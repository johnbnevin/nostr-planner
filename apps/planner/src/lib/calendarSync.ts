/**
 * Pure helper functions for calendar sync operations.
 *
 * Extracted from CalendarContext to reduce the god-object size.
 * These functions contain no React state — they accept data as parameters
 * and return results, making them testable in isolation.
 *
 * @module calendarSync
 */

import type { NostrEvent } from "@nostrify/nostrify";
import {
  KIND_CALENDAR,
  KIND_APP_DATA,
  DTAG_DAILY,
  DTAG_LISTS,
  DTAG_LISTS_OLD,
  DTAG_BACKUP,
  DTAG_DIGEST_PREFIX,
  DTAG_CAL_KEY_PREFIX,
  DTAG_MEMBERS_PREFIX,
  DTAG_SHARE_PREFIX,
  parseCalendarEvent,
  parseCalendarCollection,
  type CalendarEvent,
  type CalendarCollection,
} from "./nostr";
import {
  isEncryptedEvent,
  isSharedEncryptedEvent,
  getSharedCalendarRef,
  decryptEvent,
  decryptEventWithSharedKey,
} from "./crypto";
import { isNip44Available } from "./crypto";
import type { NostrSigner } from "./signer";
import { logger } from "./logger";

const log = logger("calendar-sync");

// ── Non-calendar d-tag prefixes to exclude from event processing ──────

const NON_CALENDAR_PREFIXES = [
  DTAG_DAILY, DTAG_LISTS, DTAG_LISTS_OLD, DTAG_BACKUP,
  DTAG_DIGEST_PREFIX, DTAG_CAL_KEY_PREFIX, DTAG_MEMBERS_PREFIX, DTAG_SHARE_PREFIX,
];

/**
 * Filter raw kind 30078 events to exclude non-calendar app data.
 * Tasks, sharing metadata, digests, and backups are stripped out to avoid
 * wasting time decrypting events that are not calendar events.
 */
export function filterCalendarAppData(rawAppData: NostrEvent[]): NostrEvent[] {
  return rawAppData.filter((e) => {
    const dTag = e.tags.find((t: string[]) => t[0] === "d")?.[1];
    if (!dTag) return true; // keep events without d-tag (unusual but safe)
    return !NON_CALENDAR_PREFIXES.some((p) => dTag.startsWith(p));
  });
}

/**
 * Build a set of deleted d-tags from kind 5 deletion events.
 * Merges with any previously known deletions.
 */
export function buildDeletedCoords(
  rawDeletions: NostrEvent[],
  existingDeletedDTags: Set<string>
): Set<string> {
  const deletedCoords = new Set<string>(existingDeletedDTags);
  for (const del of rawDeletions) {
    for (const tag of del.tags) {
      if (tag[0] === "a") {
        const parts = tag[1].split(":");
        if (parts.length >= 3 && parts[2]) deletedCoords.add(parts[2]);
      }
    }
  }
  return deletedCoords;
}

/**
 * Result of the two-pass decrypt pipeline.
 */
export interface DecryptResult {
  events: CalendarEvent[];
  calendars: CalendarCollection[];
  decryptErrors: number;
  decryptSuccesses: number;
}

/**
 * Decrypt a batch of raw Nostr events in two passes:
 *   1. Calendars first (for fast sidebar rendering)
 *   2. Events in parallel batches
 *
 * This is the core decrypt pipeline extracted from CalendarContext.doRefresh().
 */
export async function decryptCalendarData(opts: {
  rawEvents: NostrEvent[];
  deletedCoords: Set<string>;
  pubkey: string;
  signer: NostrSigner | null;
  sharedKeys: Map<string, CryptoKey>;
  existingEvents: CalendarEvent[];
  existingCalendars: CalendarCollection[];
  isIncremental: boolean;
}): Promise<DecryptResult> {
  const { rawEvents, deletedCoords, pubkey, signer, sharedKeys, isIncremental } = opts;

  const nip44Ok = isNip44Available(signer);
  const seenEvents = new Map<string, { event: CalendarEvent; createdAt: number }>();
  const seenCalendars = new Map<string, CalendarCollection>();

  // Carry forward existing data for incremental refreshes
  if (isIncremental) {
    for (const e of opts.existingEvents) {
      if (!deletedCoords.has(e.dTag)) {
        seenEvents.set(`${e.kind}:${e.pubkey}:${e.dTag}`, {
          event: e,
          createdAt: e.createdAt,
        });
      }
    }
    for (const c of opts.existingCalendars) {
      if (!deletedCoords.has(c.dTag)) seenCalendars.set(c.dTag, c);
    }
  }

  const addEvent = (parsed: CalendarEvent) => {
    const key = `${parsed.kind}:${parsed.pubkey}:${parsed.dTag}`;
    const existing = seenEvents.get(key);
    if (!existing || parsed.createdAt > existing.createdAt) {
      seenEvents.set(key, { event: parsed, createdAt: parsed.createdAt });
    }
  };

  // ── Pass 1: Decrypt calendars first ──────────────────────────────
  const pendingEvents: NostrEvent[] = [];

  for (const raw of rawEvents) {
    const dTag = raw.tags.find((t: string[]) => t[0] === "d")?.[1];
    if (dTag && deletedCoords.has(dTag)) continue;

    const isNip44 = isEncryptedEvent(raw.tags);
    const isAesGcm = isSharedEncryptedEvent(raw.tags);

    // Plaintext calendars
    if (!isNip44 && !isAesGcm) {
      if (raw.kind === KIND_APP_DATA) continue;
      if (raw.kind === KIND_CALENDAR) {
        const parsed = parseCalendarCollection(raw);
        if (parsed) {
          const ownerPubkey = raw.pubkey !== pubkey ? raw.pubkey : undefined;
          seenCalendars.set(parsed.dTag, { ...parsed, ownerPubkey });
        }
        continue;
      }
    }

    // Encrypted calendars
    if (isAesGcm && dTag) {
      const sharedCalDTag = getSharedCalendarRef(raw.tags);
      const sharedKey = sharedCalDTag ? sharedKeys.get(sharedCalDTag) : undefined;
      if (!sharedKey) { pendingEvents.push(raw); continue; }
      try {
        const decrypted = await decryptEventWithSharedKey(sharedKey, raw.content, raw.kind, dTag);
        if (decrypted.kind === KIND_CALENDAR) {
          const rebuilt = { ...raw, kind: decrypted.kind, tags: decrypted.tags, content: decrypted.content };
          const parsed = parseCalendarCollection(rebuilt);
          if (parsed) {
            const ownerPubkey = raw.pubkey !== pubkey ? raw.pubkey : undefined;
            seenCalendars.set(parsed.dTag, { ...parsed, ownerPubkey });
          }
          continue;
        }
      } catch (err) {
        log.warn("AES-GCM calendar decrypt failed for", dTag, err);
      }
    } else if (isNip44 && nip44Ok && dTag) {
      if (raw.pubkey !== pubkey) { pendingEvents.push(raw); continue; }
      try {
        const decrypted = await decryptEvent(pubkey, raw.content, raw.kind, dTag, signer!);
        if (decrypted.kind === KIND_CALENDAR) {
          const rebuilt = { ...raw, kind: decrypted.kind, tags: decrypted.tags, content: decrypted.content };
          const parsed = parseCalendarCollection(rebuilt);
          if (parsed) seenCalendars.set(parsed.dTag, parsed);
          continue;
        }
      } catch (err) {
        log.warn("NIP-44 calendar decrypt failed for", dTag, err);
      }
    }

    pendingEvents.push(raw);
  }

  // ── Pass 2: Decrypt events in parallel batches ───────────────────
  let decryptErrors = 0;
  let decryptSuccesses = 0;
  const CONCURRENCY = 20;

  const decryptOne = async (raw: NostrEvent) => {
    const dTag = raw.tags.find((t: string[]) => t[0] === "d")?.[1];
    const isNip44Flag = isEncryptedEvent(raw.tags);
    const isAesGcm = isSharedEncryptedEvent(raw.tags);

    if (isAesGcm && dTag) {
      const sharedCalDTag = getSharedCalendarRef(raw.tags);
      const sharedKey = sharedCalDTag ? sharedKeys.get(sharedCalDTag) : undefined;
      if (!sharedKey) return;
      try {
        const decrypted = await decryptEventWithSharedKey(sharedKey, raw.content, raw.kind, dTag);
        const rebuilt = { ...raw, kind: decrypted.kind, tags: decrypted.tags, content: decrypted.content };
        const parsed = parseCalendarEvent(rebuilt);
        if (parsed) addEvent(parsed);
        decryptSuccesses++;
      } catch (err) {
        log.warn("AES-GCM event decrypt failed for", dTag, err);
        decryptErrors++;
      }
    } else if (isNip44Flag && nip44Ok && dTag) {
      if (raw.pubkey !== pubkey) return;
      try {
        const decrypted = await decryptEvent(pubkey, raw.content, raw.kind, dTag, signer!);
        const rebuilt = { ...raw, kind: decrypted.kind, tags: decrypted.tags, content: decrypted.content };
        const parsed = parseCalendarEvent(rebuilt);
        if (parsed) addEvent(parsed);
        decryptSuccesses++;
      } catch (err) {
        log.warn("NIP-44 event decrypt failed for", dTag, err);
        decryptErrors++;
      }
    } else if (!isNip44Flag && !isAesGcm) {
      const parsed = parseCalendarEvent(raw);
      if (parsed) addEvent(parsed);
    }
  };

  for (let i = 0; i < pendingEvents.length; i += CONCURRENCY) {
    const batch = pendingEvents.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(decryptOne));
  }

  const allEvents: CalendarEvent[] = [];
  for (const { event } of seenEvents.values()) allEvents.push(event);

  return {
    events: allEvents,
    calendars: [...seenCalendars.values()],
    decryptErrors,
    decryptSuccesses,
  };
}
