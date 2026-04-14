/**
 * User registry and push notification event processing.
 * Handles push data snapshots and push subscriptions.
 */

import type { NPool, NostrEvent } from "@nostrify/nostrify";
import { verifyEvent } from "nostr-tools/pure";
import { queryEvents } from "./relay.js";
import { decryptFromUser } from "./decrypt.js";
import { getDatePartsInZone, getMidnightInZone } from "./timezone.js";

// ── Payload types (must match client src/lib/digest.ts) ──────────────

export interface DigestEvent {
  title: string;
  start: string;
  end?: string;
  allDay: boolean;
  location?: string;
  calendar?: string;
}

export interface DigestTodo {
  listName: string;
  title: string;
  done: boolean;
}

export interface DigestHabit {
  title: string;
  doneToday: boolean;
}

interface DigestDataPayload {
  v: number;
  preparedAt: number;
  timezone: string;
  events: DigestEvent[];
  todos: DigestTodo[];
  habits: DigestHabit[];
}

interface PushSubscriptionPayload {
  v: number;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  allDayMinsBefore: number;
  timedMinsBefore: number;
  timezone: string;
}

// ── Push subscription entry ──────────────────────────────────────────

export interface PushSubEntry {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  allDayMinsBefore: number;
  timedMinsBefore: number;
  timezone: string;
  /** Track notified event keys to avoid duplicates within the current local day. */
  notifiedToday: Set<string>;
  /**
   * The local YYYY-MM-DD date key (in this sub's timezone) for which
   * `notifiedToday` was last populated. When the local date advances,
   * `notifiedToday` is lazily cleared in `getPendingPushNotifications`.
   */
  notifiedDateKey: string;
}

// ── User entry ───────────────────────────────────────────────────────

export interface UserEntry {
  pubkey: string;
  digestData?: DigestDataPayload;
  pushSubs: Map<string, PushSubEntry>; // keyed by endpoint
  /** Tracks latest created_at per d-tag to enforce replaceable event semantics. */
  lastSeenAt: Map<string, number>;
}

// ── Registry ─────────────────────────────────────────────────────────

export class UserRegistry {
  private users = new Map<string, UserEntry>();

  constructor(
    private botPrivkey: Uint8Array,
    private botPubkey: string
  ) {}

  /** Load all existing events from relays on startup. */
  async loadFromRelays(pool: NPool): Promise<void> {
    const events = await queryEvents(pool, {
      kinds: [30078],
      "#p": [this.botPubkey],
    });

    for (const event of events) {
      this.processEvent(event);
    }

    let pushCount = 0;
    for (const u of this.users.values()) pushCount += u.pushSubs.size;
    console.log(`[registry] loaded ${this.users.size} users, ${pushCount} push subscriptions`);
  }

  /** Process a single incoming event. */
  processEvent(event: NostrEvent): void {
    // Verify Schnorr signature before trusting relay-provided data.
    try {
      if (!verifyEvent(event as Parameters<typeof verifyEvent>[0])) {
        console.warn(`[registry] invalid signature, dropping event ${event.id?.slice(0, 8)}`);
        return;
      }
    } catch {
      console.warn(`[registry] signature check threw for event ${event.id?.slice(0, 8)}, dropping`);
      return;
    }

    const dTag = event.tags.find((t) => t[0] === "d")?.[1];
    if (!dTag) return;

    // Enforce replaceable event semantics: only process the latest
    // version per pubkey+d-tag (by created_at timestamp).
    const user = this.ensureUser(event.pubkey);
    const dedupKey = `${event.pubkey}:${dTag}`;
    const prevTs = user.lastSeenAt.get(dedupKey) ?? 0;
    if (event.created_at < prevTs) return; // stale event, skip
    user.lastSeenAt.set(dedupKey, event.created_at);

    try {
      const json = decryptFromUser(this.botPrivkey, event.pubkey, event.content);
      const payload = JSON.parse(json);

      if (dTag === "planner-digest-data") {
        this.handleData(event.pubkey, payload as DigestDataPayload);
      } else if (dTag.startsWith("planner-push-sub-")) {
        this.handlePushSub(event.pubkey, payload as PushSubscriptionPayload);
      }
    } catch (err) {
      console.warn(`[registry] failed to decrypt event from ${event.pubkey.slice(0, 8)}:`, err);
    }
  }

  private ensureUser(pubkey: string): UserEntry {
    let user = this.users.get(pubkey);
    if (!user) {
      user = {
        pubkey,
        pushSubs: new Map(),
        lastSeenAt: new Map(),
      };
      this.users.set(pubkey, user);
    }
    return user;
  }

  private handleData(pubkey: string, data: DigestDataPayload): void {
    // Schema validation — reject malformed payloads
    if (
      typeof data.preparedAt !== "number" ||
      typeof data.timezone !== "string" ||
      !Array.isArray(data.events) ||
      !Array.isArray(data.todos) ||
      !Array.isArray(data.habits)
    ) {
      console.warn(`[registry] malformed push data from ${pubkey.slice(0, 8)}, ignoring`);
      return;
    }
    const user = this.ensureUser(pubkey);
    user.digestData = data;
  }

  private handlePushSub(pubkey: string, sub: PushSubscriptionPayload): void {
    // Schema validation — reject malformed push subscription payloads
    if (
      typeof sub.endpoint !== "string" ||
      !sub.endpoint.startsWith("https://") ||
      typeof sub.keys?.p256dh !== "string" ||
      typeof sub.keys?.auth !== "string" ||
      typeof sub.allDayMinsBefore !== "number" ||
      typeof sub.timedMinsBefore !== "number" ||
      typeof sub.timezone !== "string"
    ) {
      console.warn(`[registry] malformed push sub from ${pubkey.slice(0, 8)}, ignoring`);
      return;
    }
    const user = this.ensureUser(pubkey);
    user.pushSubs.set(sub.endpoint, {
      endpoint: sub.endpoint,
      keys: sub.keys,
      allDayMinsBefore: sub.allDayMinsBefore,
      timedMinsBefore: sub.timedMinsBefore,
      timezone: sub.timezone,
      notifiedToday: new Set(),
      notifiedDateKey: "",
    });
    console.log(`[registry] push sub for ${pubkey.slice(0, 8)} (${user.pushSubs.size} device(s))`);
  }

  /** Get push notifications that need to fire right now. */
  getPendingPushNotifications(maxStaleHours: number): Array<{
    user: UserEntry;
    sub: PushSubEntry;
    event: DigestEvent;
  }> {
    const nowMs = Date.now();
    const nowSecs = nowMs / 1000;
    const pending: Array<{ user: UserEntry; sub: PushSubEntry; event: DigestEvent }> = [];

    for (const user of this.users.values()) {
      if (!user.digestData) continue;
      const ageHours = (nowSecs - user.digestData.preparedAt) / 3600;
      if (ageHours > maxStaleHours) continue;

      for (const sub of user.pushSubs.values()) {
        // Lazy per-timezone daily reset: clear the dedup set when the user's
        // local date advances, rather than resetting all users at UTC midnight.
        const todayKey = getDatePartsInZone(sub.timezone).dateKey;
        if (sub.notifiedDateKey !== todayKey) {
          sub.notifiedToday.clear();
          sub.notifiedDateKey = todayKey;
        }

        for (const event of user.digestData.events) {
          const eventKey = `${event.start}\x00${event.title}\x00${event.location ?? ""}`;
          if (sub.notifiedToday.has(eventKey)) continue;

          let eventStartMs: number;
          if (event.allDay) {
            eventStartMs = getMidnightInZone(event.start, sub.timezone);
          } else {
            eventStartMs = new Date(event.start).getTime();
          }

          const minsBefore = event.allDay ? sub.allDayMinsBefore : sub.timedMinsBefore;
          const alertTimeMs = eventStartMs - minsBefore * 60_000;

          // Fire if: alert time has passed, but event hasn't started + 5min grace
          if (nowMs >= alertTimeMs && nowMs < eventStartMs + 5 * 60_000) {
            pending.push({ user, sub, event });
          }
        }
      }
    }

    return pending;
  }

  /** Mark a push notification as sent for today. */
  markPushSent(sub: PushSubEntry, eventKey: string): void {
    sub.notifiedToday.add(eventKey);
  }

  /** Remove a push subscription (e.g., when it expires/fails). */
  removePushSub(pubkey: string, endpoint: string): void {
    const user = this.users.get(pubkey);
    if (user) user.pushSubs.delete(endpoint);
  }
}
