/**
 * User registry and push notification event processing.
 * Handles push data snapshots and push subscriptions.
 */

import type { NPool, NostrEvent } from "@nostrify/nostrify";
import { verifyEvent } from "nostr-tools/pure";
import { queryEvents } from "./relay.js";
import { decryptFromUser } from "./decrypt.js";
import { getDatePartsInZone, getMidnightInZone, isValidTimeZone } from "./timezone.js";

/** Hard caps to bound memory against a spammer minting signature-valid
 *  events #p-tagged to the bot. Generous enough for any real deployment. */
const MAX_USERS = 50_000;
const MAX_SUBS_PER_USER = 20;

/** Per-pubkey identifiers in logs are gated behind this flag so production
 *  logs don't leak which pubkeys interact with the bot (a mild social-graph
 *  signal). Counts are always logged; identifiers only when explicitly opted in. */
const LOG_PUBKEYS = process.env.DAEMON_LOG_PUBKEYS === "true";
const pk = (pubkey: string): string => (LOG_PUBKEYS ? pubkey.slice(0, 8) : "user");

// ── Payload types (must match client src/lib/digest.ts) ──────────────

export interface DigestEvent {
  title: string;
  start: string;
  end?: string;
  allDay: boolean;
  location?: string;
  calendar?: string;
}

/** Stable per-event dedup/notification key. Includes the calendar so two
 *  events that coincide on start/title/location but live on different
 *  calendars each get their own notification. Single source of truth shared
 *  by the pending-scan, the mark-sent path, and the web-push tag so they
 *  can't drift. */
export function pushDedupKey(event: DigestEvent): string {
  return `${event.start}\x00${event.title}\x00${event.location ?? ""}\x00${event.calendar ?? ""}`;
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
  /** Web Push endpoint (VAPID). */
  endpoint: string;
  /** Web Push encryption keys. */
  keys: { p256dh: string; auth: string };
  allDayMinsBefore: number;
  timedMinsBefore: number;
  timezone: string;
}

// ── Push subscription entry ──────────────────────────────────────────
//
// Web Push (VAPID) only — there is no FCM/APNs path. Native clients (Tauri,
// incl. GrapheneOS) schedule local on-device notifications instead of
// registering for server push, so the daemon never receives a native sub.

export interface PushSubEntry {
  /** Web Push endpoint. */
  endpoint: string;
  /** Web Push keys. */
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
      // Bound total tracked users. Map iterates in insertion order, so the
      // first key is the oldest — evict it to make room. The primary copy of
      // any evicted user's data still lives on relays; they re-register on
      // next contact.
      if (this.users.size >= MAX_USERS) {
        const oldest = this.users.keys().next().value;
        if (oldest !== undefined) this.users.delete(oldest);
      }
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
    // Delivery prefs + timezone. The timezone MUST be a real IANA zone — it
    // flows into Intl.DateTimeFormat in the push loop, where a bad value
    // throws and (without this guard) would crash the daemon for every user.
    if (
      typeof sub.allDayMinsBefore !== "number" ||
      typeof sub.timedMinsBefore !== "number" ||
      !isValidTimeZone(sub.timezone)
    ) {
      console.warn(`[registry] malformed push sub from ${pk(pubkey)}, ignoring`);
      return;
    }

    // Web Push needs the VAPID endpoint and encryption keys. (Web Push is the
    // only transport — native clients use on-device local notifications.)
    if (
      typeof sub.endpoint !== "string" ||
      !sub.endpoint.startsWith("https://") ||
      typeof sub.keys?.p256dh !== "string" ||
      typeof sub.keys?.auth !== "string"
    ) {
      console.warn(`[registry] malformed webpush sub from ${pk(pubkey)}, ignoring`);
      return;
    }

    const user = this.ensureUser(pubkey);
    // Bound devices per user. If at cap and this endpoint is new, evict the
    // oldest sub to make room (re-registration restores it).
    if (!user.pushSubs.has(sub.endpoint) && user.pushSubs.size >= MAX_SUBS_PER_USER) {
      const oldest = user.pushSubs.keys().next().value;
      if (oldest !== undefined) user.pushSubs.delete(oldest);
    }
    user.pushSubs.set(sub.endpoint, {
      endpoint: sub.endpoint,
      keys: sub.keys,
      allDayMinsBefore: sub.allDayMinsBefore,
      timedMinsBefore: sub.timedMinsBefore,
      timezone: sub.timezone,
      notifiedToday: new Set(),
      notifiedDateKey: "",
    });
    console.log(`[registry] webpush sub for ${pk(pubkey)} (${user.pushSubs.size} device(s))`);
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
        // Isolate each sub: a bad value (e.g. a timezone that slipped past
        // validation on an older build) must not abort the whole loop and
        // starve every other user's notifications.
        try {
          // Lazy per-timezone daily reset: clear the dedup set when the user's
          // local date advances, rather than resetting all users at UTC midnight.
          const todayKey = getDatePartsInZone(sub.timezone).dateKey;
          if (sub.notifiedDateKey !== todayKey) {
            sub.notifiedToday.clear();
            sub.notifiedDateKey = todayKey;
          }

          for (const event of user.digestData.events) {
            const eventKey = pushDedupKey(event);
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
        } catch (err) {
          console.warn(`[registry] skipping sub for ${pk(user.pubkey)}:`, err instanceof Error ? err.message : err);
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
