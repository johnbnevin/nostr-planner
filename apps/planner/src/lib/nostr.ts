/**
 * @module nostr
 *
 * NIP-52 Calendar Event helpers for the Nostr-based planner.
 *
 * NIP-52 defines four replaceable event kinds for calendar data:
 *  - **31922** — Date-based (all-day / multi-day) calendar events.
 *  - **31923** — Time-based calendar events (with clock time as unix seconds).
 *  - **31924** — Calendar collections that group events via `a`-tag references.
 *  - **31925** — RSVPs referencing a calendar event.
 *
 * Each kind is an *addressable replaceable event* (kind 30000-39999) keyed by
 * the author's pubkey + the `d` tag, so publishing a new version of the same
 * `d` tag replaces the previous one on relays.
 *
 * This module also defines the app-data d-tag namespace used for encrypted
 * private events, backup references, shared-calendar key envelopes, and
 * task/list storage — all published under kind 30078 (NIP-78 app data).
 *
 * Recurrence is **not part of NIP-52**. This module implements client-side
 * recurrence expansion: a single event with an `rrule` tag is expanded into
 * individual CalendarEvent instances for rendering.
 */
import { addDays, addWeeks, addMonths, addYears } from "date-fns";
import { logger } from "./logger";

const log = logger("nostr");

// ── NIP-52 Calendar Event Kinds ─────────────────────────────────────────

/** Kind 31922: All-day or multi-day date-based calendar event (NIP-52).
 *  `start` tag is an ISO date string (YYYY-MM-DD). */
export const KIND_DATE_EVENT = 31922;

/** Kind 31923: Time-based calendar event with clock precision (NIP-52).
 *  `start` tag is a unix timestamp in seconds; a `D` (day-floor) tag is
 *  required for efficient relay-side day-range queries. */
export const KIND_TIME_EVENT = 31923;

/** Kind 31924: Calendar collection (NIP-52).
 *  Groups calendar events via `a`-tag references (kind:pubkey:d-tag). */
export const KIND_CALENDAR = 31924;

/** Kind 31925: RSVP to a calendar event (NIP-52).
 *  References the target event via an `a` tag; carries `status` and `fb` tags. */
export const KIND_RSVP = 31925;

/** Kind 30078: NIP-78 arbitrary app data.
 *  Used for encrypted private calendar events, backup reference pointers,
 *  shared-calendar AES key envelopes (NIP-44), task lists, and daily notes. */
export const KIND_APP_DATA = 30078;

/** Kind 10002: NIP-65 relay list metadata.
 *  Read on login to discover the user's preferred read/write relays. */
export const KIND_RELAY_LIST = 10002;

// ── App-data d-tag prefixes (kind 30078) ────────────────────────────────

/** d-tag for the Blossom backup reference event that stores the SHA-256
 *  hash and server list of the latest backup blob. */
export const DTAG_BACKUP = "nostr-planner-backup";

/** d-tag for the user's daily notes (one replaceable event per day). */
export const DTAG_DAILY = "nostr-planner-daily";

/** d-tag for the user's task/to-do lists (current format). */
export const DTAG_LISTS = "nostr-planner-lists";

/** @deprecated d-tag for the old task list format — kept for backwards
 *  compatibility when restoring backups from older versions. */
export const DTAG_LISTS_OLD = "nostr-planner-todo";

/** d-tag prefix for shared-calendar AES-256-GCM key envelopes.
 *  Full d-tag: `planner-cal-key-<calendarDTag>`. The content is NIP-44
 *  encrypted to the recipient and contains the symmetric key. */
export const DTAG_CAL_KEY_PREFIX = "planner-cal-key-";

/** d-tag prefix for shared-calendar invitation/share records.
 *  Full d-tag: `planner-share-<calendarDTag>`. */
export const DTAG_SHARE_PREFIX = "planner-share-";

/** d-tag prefix for shared-calendar member lists.
 *  Full d-tag: `planner-cal-members-<calendarDTag>`. */
export const DTAG_MEMBERS_PREFIX = "planner-cal-members-";

/** d-tag prefix for notification digest events.
 *  Full d-tag: `planner-digest-<calendarDTag>`. */
export const DTAG_DIGEST_PREFIX = "planner-digest-";

/** Fallback relay URLs used when the user has no NIP-65 relay list.
 *  On login, these are replaced/supplemented by the user's kind-10002 list. */
export const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.ditto.pub",
  "wss://relay.primal.net",
];

/** Supported recurrence frequencies, matching iCal RRULE FREQ values. */
export type RecurrenceFreq = "daily" | "weekly" | "monthly" | "yearly";

/**
 * A simplified recurrence rule for calendar events.
 *
 * NIP-52 does not define recurrence, so this is an app-level convention.
 * The rule is stored in an `rrule` tag as an iCal-compatible RRULE string
 * (e.g. `FREQ=WEEKLY;COUNT=12`) for interop with other calendar clients.
 */
export interface RecurrenceRule {
  /** How often the event repeats. */
  freq: RecurrenceFreq;
  /** Total number of occurrences to generate (including the first). */
  count: number;
}

const FREQ_TO_RRULE: Record<RecurrenceFreq, string> = {
  daily: "DAILY",
  weekly: "WEEKLY",
  monthly: "MONTHLY",
  yearly: "YEARLY",
};

const RRULE_TO_FREQ: Record<string, RecurrenceFreq> = {
  DAILY: "daily",
  WEEKLY: "weekly",
  MONTHLY: "monthly",
  YEARLY: "yearly",
};

/**
 * Convert a {@link RecurrenceRule} to an iCal RRULE string for interop.
 *
 * The output format is `FREQ=<DAILY|WEEKLY|MONTHLY|YEARLY>;COUNT=<n>`,
 * which can be stored in the `rrule` tag of a NIP-52 event and parsed
 * by any iCal-aware client.
 */
export function toRRule(rule: RecurrenceRule): string {
  return `FREQ=${FREQ_TO_RRULE[rule.freq]};COUNT=${rule.count}`;
}

/**
 * Parse an iCal RRULE string into a {@link RecurrenceRule}.
 *
 * Accepts semicolon-delimited key=value pairs (e.g. `FREQ=WEEKLY;COUNT=10`).
 * If the FREQ is unrecognized, returns `null`. If COUNT is missing, defaults
 * to 52 (~one year of weekly occurrences) as a safe upper bound.
 *
 * @returns The parsed rule, or `null` if the RRULE is malformed or uses
 *          an unsupported frequency.
 */
export function fromRRule(rrule: string): RecurrenceRule | null {
  const parts: Record<string, string> = {};
  for (const part of rrule.split(";")) {
    const [k, v] = part.split("=");
    if (k && v) parts[k.toUpperCase()] = v.toUpperCase();
  }
  const freq = parts.FREQ ? RRULE_TO_FREQ[parts.FREQ] : undefined;
  if (!freq) return null;
  const MAX_RECURRENCE = 365;

  let count: number;
  if (parts.COUNT) {
    const raw = parseInt(parts.COUNT);
    count = Math.min(Math.max(1, raw || 52), MAX_RECURRENCE);
  } else if (parts.UNTIL) {
    // UNTIL=YYYYMMDD or UNTIL=YYYYMMDDTHHMMSSZ — compute count from date range
    const untilStr = parts.UNTIL.replace(/[^0-9]/g, "").slice(0, 8);
    const untilDate = new Date(`${untilStr.slice(0, 4)}-${untilStr.slice(4, 6)}-${untilStr.slice(6, 8)}`);
    if (!isNaN(untilDate.getTime())) {
      const now = new Date();
      const diffMs = untilDate.getTime() - now.getTime();
      const diffDays = Math.max(1, Math.ceil(diffMs / 86400000));
      const freqDivisors: Record<RecurrenceFreq, number> = { daily: 1, weekly: 7, monthly: 30, yearly: 365 };
      count = Math.min(Math.max(1, Math.ceil(diffDays / freqDivisors[freq])), MAX_RECURRENCE);
    } else {
      count = 52;
    }
  } else {
    count = 52; // default: ~1 year of weekly
  }

  return { freq, count };
}

/**
 * A NIP-52 calendar collection (kind 31924).
 *
 * Groups calendar events by referencing them via Nostr `a`-tag coordinates
 * (format: `kind:pubkey:d-tag`). Each collection has a user-facing title
 * and an optional display color.
 */
export interface CalendarCollection {
  /** The `d` tag value — unique identifier for this collection per pubkey. */
  dTag: string;
  /** User-facing name of the calendar. */
  title: string;
  /** Nostr `a`-tag coordinate strings (`kind:pubkey:d-tag`) referencing member events. */
  eventRefs: string[];
  /** Optional hex color for calendar UI rendering (e.g. `"#4c6ef5"`). */
  color?: string;
  /** Set when this is a shared calendar owned by another user. */
  ownerPubkey?: string;
}

/**
 * A parsed NIP-52 calendar event (kind 31922 or 31923).
 *
 * Created by {@link parseCalendarEvent} from a raw Nostr event. Contains
 * all tag-derived fields plus the original tags array for round-tripping.
 */
export interface CalendarEvent {
  id: string;
  pubkey: string;
  kind: number;
  dTag: string;
  title: string;
  content: string;
  start: Date;
  end?: Date;
  allDay: boolean;
  location?: string;
  link?: string;
  hashtags: string[];
  recurrence?: RecurrenceRule;
  seriesId?: string; // shared ID linking all instances of a recurring series
  calendarRefs: string[]; // d-tags of calendars this event belongs to
  notify?: boolean; // per-event notification opt-in/out
  tags: string[][];
  createdAt: number;
}

/**
 * Coerce a tag value to a bounded string.
 *
 * Relay-sourced tag values are untrusted input. This helper ensures the
 * value is actually a string and truncates it to `maxLen` characters to
 * prevent UI overflow or memory abuse from maliciously large tags.
 */
function safeStr(val: unknown, maxLen = 500): string {
  if (typeof val !== "string") return "";
  return val.slice(0, maxLen);
}

/**
 * Sanitize a tag value as an HTTP(S) URL.
 *
 * Only allows `http://` or `https://` schemes to prevent `javascript:` or
 * other dangerous URI schemes from reaching the UI. Truncates to 2048 chars.
 * Returns `undefined` for non-string or non-HTTP values.
 */
function safeUrl(val: unknown): string | undefined {
  if (typeof val !== "string") return undefined;
  return /^https?:\/\//i.test(val) ? val.slice(0, 2048) : undefined;
}

/**
 * Parse a raw Nostr event into a {@link CalendarEvent}.
 *
 * Maps NIP-52 tags to the CalendarEvent interface:
 *  - `d`        → `dTag` (unique identifier per pubkey, required)
 *  - `title`    → `title` (falls back to `name` tag, then "Untitled")
 *  - `start`    → `start` (ISO date for kind 31922, unix seconds for 31923)
 *  - `end`      → `end` (same format as start; exclusive per NIP-52)
 *  - `location` → `location`
 *  - `r`        → `link` (sanitized to HTTP(S) only via {@link safeUrl})
 *  - `t`        → `hashtags` (collected from all `t` tags)
 *  - `calendar` → `calendarRefs` (d-tags of parent calendar collections)
 *  - `series`   → `seriesId` (links recurring event instances)
 *  - `notify`   → `notify` (per-event notification preference)
 *  - `rrule`    → `recurrence` (parsed via {@link fromRRule}; falls back
 *                  to `recurrence` or `rrule` in JSON content body)
 *
 * @returns The parsed event, or `null` if the required `d` or `start` tag
 *          is missing.
 */
export function parseCalendarEvent(event: {
  id: string;
  pubkey: string;
  kind: number;
  tags: string[][];
  content: string;
  created_at: number;
}): CalendarEvent | null {
  // Required: `d` tag is the replaceable-event identifier
  const dTag = event.tags.find((t) => t[0] === "d")?.[1];
  // Title: prefer `title` tag, fall back to `name` (older convention)
  const title = safeStr(
    event.tags.find((t) => t[0] === "title")?.[1] ||
    event.tags.find((t) => t[0] === "name")?.[1],
    300
  ) || "Untitled";
  // Start/end: format depends on kind (ISO date vs unix seconds)
  const startRaw = event.tags.find((t) => t[0] === "start")?.[1];
  const endRaw = event.tags.find((t) => t[0] === "end")?.[1];
  // Location and link are optional metadata tags
  const location = safeStr(event.tags.find((t) => t[0] === "location")?.[1], 500) || undefined;
  const link = safeUrl(event.tags.find((t) => t[0] === "r")?.[1]);
  // Collect all `t` (hashtag) tags, sanitized and filtered
  const hashtags = event.tags
    .filter((t) => t[0] === "t" && typeof t[1] === "string")
    .map((t) => safeStr(t[1], 100))
    .filter(Boolean);
  // `calendar` tags reference the d-tags of parent CalendarCollections
  const calendarRefs = event.tags
    .filter((t) => t[0] === "calendar" && typeof t[1] === "string")
    .map((t) => t[1]);
  // `series` tag links all instances of a recurring event together
  const seriesId = event.tags.find((t) => t[0] === "series")?.[1];
  // `notify` tag: per-event opt-in/out for notifications
  const notifyTag = event.tags.find((t) => t[0] === "notify")?.[1];
  const notify = notifyTag === "true" ? true : notifyTag === "false" ? false : undefined;

  // Parse recurrence: prefer `rrule` tag (iCal-interoperable),
  // fall back to recurrence/rrule embedded in the JSON content body
  let recurrence: RecurrenceRule | undefined;
  const rruleTag = event.tags.find((t) => t[0] === "rrule")?.[1];
  if (rruleTag) {
    recurrence = fromRRule(rruleTag) ?? undefined;
  }
  if (!recurrence) {
    try {
      const parsed = JSON.parse(event.content);
      if (parsed?.recurrence) {
        recurrence = parsed.recurrence;
      } else if (parsed?.rrule) {
        recurrence = fromRRule(parsed.rrule) ?? undefined;
      }
    } catch {
      // content is plain text, no recurrence embedded
    }
  }

  // Both `d` and `start` are mandatory per NIP-52
  if (!dTag || !startRaw) return null;

  // Kind 31922 (date event) uses ISO date strings; kind 31923 uses unix seconds
  const allDay = event.kind === KIND_DATE_EVENT;
  let start: Date;
  let end: Date | undefined;

  if (allDay) {
    // Date events: `start` is "YYYY-MM-DD", parsed at midnight local time
    start = new Date(startRaw + "T00:00:00");
    if (endRaw) end = new Date(endRaw + "T00:00:00");
  } else {
    // Time events: `start` is unix seconds, convert to milliseconds for Date
    const startUnix = parseInt(startRaw, 10);
    if (!Number.isFinite(startUnix) || startUnix <= 0) return null;
    start = new Date(startUnix * 1000);
    if (endRaw) {
      const endUnix = parseInt(endRaw, 10);
      if (Number.isFinite(endUnix) && endUnix > 0) end = new Date(endUnix * 1000);
    }
  }

  // Guard against invalid Date objects (malformed ISO strings, etc.)
  if (isNaN(start.getTime())) return null;

  // Warn (don't reject) on timestamps that are suspiciously out of range.
  // Users may have legitimately archived old events; far-future events are
  // less likely but shouldn't be silently dropped.
  if (!allDay) {
    const nowS = Math.floor(Date.now() / 1000);
    const MAX_AGE_S = 30 * 365 * 24 * 3600; // 30 years back
    const MAX_FUTURE_S = 10 * 365 * 24 * 3600; // 10 years ahead
    const startS = start.getTime() / 1000;
    if (startS < nowS - MAX_AGE_S || startS > nowS + MAX_FUTURE_S) {
      log.warn("event timestamp out of plausible range", event.id?.slice(0, 8));
    }
  }

  return {
    id: event.id,
    pubkey: event.pubkey,
    kind: event.kind,
    dTag,
    title,
    content: event.content,
    start,
    end,
    allDay,
    location,
    link,
    hashtags,
    recurrence,
    seriesId,
    calendarRefs,
    notify,
    tags: event.tags,
    createdAt: event.created_at,
  };
}

/**
 * Parse a raw Nostr event into a {@link CalendarCollection} (kind 31924).
 *
 * Extracts the `d` tag (identifier), `title`, `color`, and all `a`-tag
 * coordinate references that link this collection to its member events.
 *
 * @returns The parsed collection, or `null` if the `d` tag is missing.
 */
export function parseCalendarCollection(event: {
  tags: string[][];
  content: string;
}): CalendarCollection | null {
  const dTag = event.tags.find((t) => t[0] === "d")?.[1];
  const title =
    event.tags.find((t) => t[0] === "title")?.[1] || "Untitled Calendar";
  const ATAG_RE = /^\d+:[0-9a-f]{64}:.{1,256}$/;
  // Cap to 1000 refs to prevent memory abuse from maliciously crafted events
  // (relay size limits keep this well below 1000 in practice).
  const eventRefs = event.tags
    .filter((t) => t[0] === "a" && ATAG_RE.test(t[1]))
    .slice(0, 1000)
    .map((t) => t[1]);
  const color = event.tags.find((t) => t[0] === "color")?.[1];

  if (!dTag) return null;
  return { dTag, title, eventRefs, color };
}

/**
 * Build the NIP-52 tag array for a **date-based** calendar event (kind 31922).
 *
 * Date events represent all-day or multi-day entries. The `start` and `end`
 * tags use ISO date strings (`YYYY-MM-DD`). Unlike time events, no `D`
 * (day-floor) tag is needed because relays can filter directly on the
 * date string.
 *
 * Optional tags (`location`, `r`, `t`, `calendar`, `series`, `notify`,
 * `rrule`) are only included when the corresponding option is provided.
 *
 * @param opts.dTag     - Unique replaceable-event identifier (use {@link generateDTag}).
 * @param opts.startDate - Start date as `YYYY-MM-DD`.
 * @param opts.endDate   - End date as `YYYY-MM-DD` (exclusive, per NIP-52).
 */
export function buildDateEventTags(opts: {
  dTag: string;
  title: string;
  startDate: string;
  endDate?: string;
  location?: string;
  link?: string;
  hashtags?: string[];
  calendarRefs?: string[];
  seriesId?: string;
  notify?: boolean;
  recurrence?: RecurrenceRule;
}): string[][] {
  const tags: string[][] = [
    ["d", opts.dTag],
    ["title", opts.title],
    ["start", opts.startDate],
  ];
  if (opts.endDate) tags.push(["end", opts.endDate]);
  if (opts.location) tags.push(["location", opts.location]);
  if (opts.link) tags.push(["r", opts.link]);
  if (opts.hashtags) {
    for (const t of opts.hashtags) tags.push(["t", t]);
  }
  if (opts.calendarRefs) {
    for (const c of opts.calendarRefs) tags.push(["calendar", c]);
  }
  if (opts.seriesId) tags.push(["series", opts.seriesId]);
  if (opts.notify !== undefined) tags.push(["notify", String(opts.notify)]);
  if (opts.recurrence) tags.push(["rrule", toRRule(opts.recurrence)]);
  return tags;
}

/**
 * Build the NIP-52 tag array for a **time-based** calendar event (kind 31923).
 *
 * Time events store `start` and `end` as unix timestamps (seconds). NIP-52
 * requires a `D` tag whose value is the **day floor**: the start timestamp
 * integer-divided by 86400 (seconds per day). This enables relays to answer
 * day-range queries efficiently without parsing timestamps.
 *
 * **Multi-day spanning:** If the event crosses midnight (i.e. end day-floor
 * differs from start day-floor), additional `D` tags are emitted for every
 * intervening day so the event appears in queries for each day it spans.
 *
 * Timezone tags (`start_tzid`, `end_tzid`) use IANA timezone identifiers
 * (e.g. `"America/New_York"`) and are included when `opts.timezone` is set.
 *
 * @param opts.dTag      - Unique replaceable-event identifier.
 * @param opts.startUnix - Start time as unix seconds.
 * @param opts.endUnix   - End time as unix seconds (exclusive).
 */
export function buildTimeEventTags(opts: {
  dTag: string;
  title: string;
  startUnix: number;
  endUnix?: number;
  timezone?: string;
  location?: string;
  link?: string;
  hashtags?: string[];
  calendarRefs?: string[];
  seriesId?: string;
  notify?: boolean;
  recurrence?: RecurrenceRule;
}): string[][] {
  // Day floor = unix seconds / 86400, floored to an integer day index.
  // This is what NIP-52 calls the "D" tag — used for relay-side day filtering.
  const dayFloor = Math.floor(opts.startUnix / 86400);
  const tags: string[][] = [
    ["d", opts.dTag],
    ["title", opts.title],
    ["start", String(opts.startUnix)],
    ["D", String(dayFloor)],
  ];
  if (opts.endUnix) {
    tags.push(["end", String(opts.endUnix)]);
    // If the event spans multiple days, emit a `D` tag for each additional day
    // so the event is discoverable in relay queries for any day it covers.
    const endDayFloor = Math.floor(opts.endUnix / 86400);
    // Cap multi-day D tags to 366 to prevent tag explosion from malformed events
    const maxDayFloor = Math.min(endDayFloor, dayFloor + 366);
    for (let d = dayFloor + 1; d <= maxDayFloor; d++) {
      tags.push(["D", String(d)]);
    }
  }
  if (opts.timezone) {
    tags.push(["start_tzid", opts.timezone]);
    if (opts.endUnix) tags.push(["end_tzid", opts.timezone]);
  }
  if (opts.location) tags.push(["location", opts.location]);
  if (opts.link) tags.push(["r", opts.link]);
  if (opts.hashtags) {
    for (const t of opts.hashtags) tags.push(["t", t]);
  }
  if (opts.calendarRefs) {
    for (const c of opts.calendarRefs) tags.push(["calendar", c]);
  }
  if (opts.seriesId) tags.push(["series", opts.seriesId]);
  if (opts.notify !== undefined) tags.push(["notify", String(opts.notify)]);
  if (opts.recurrence) tags.push(["rrule", toRRule(opts.recurrence)]);
  return tags;
}

/** Format a Date as YYYY-MM-DD (local time) for NIP-52 date event tags. */
export function formatDateTag(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Generate a random 32-character hex `d` tag (128-bit) for a new replaceable event. */
export function generateDTag(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Advance a date by `count` units of the given frequency using date-fns
 *  to handle DST, month-end overflow, and leap years correctly. */
export function advanceDate(base: Date, freq: RecurrenceFreq, count: number): Date {
  switch (freq) {
    case "daily": return addDays(base, count);
    case "weekly": return addWeeks(base, count);
    case "monthly": return addMonths(base, count);
    case "yearly": return addYears(base, count);
  }
}

/**
 * Expand a recurring event into individual {@link CalendarEvent} instances.
 *
 * NIP-52 does **not** define recurrence — it is purely an app-level feature.
 * Rather than publishing N separate Nostr events (which would pollute relays
 * and complicate edits/deletes), a single event carries an `rrule` tag and
 * this function generates virtual instances client-side for rendering.
 *
 * Each generated instance shares the original event's data but has:
 *  - An adjusted `start` (and `end`, preserving the original duration).
 *  - A synthetic `dTag` with an `-<index>` suffix (e.g. `abc123-3`) so
 *    each instance can be uniquely identified in the UI.
 *
 * If the event has no recurrence rule, returns a single-element array
 * containing the original event unchanged.
 */
export function expandRecurringEvent(event: CalendarEvent): CalendarEvent[] {
  if (!event.recurrence) return [event];

  const { freq, count } = event.recurrence;
  const instances: CalendarEvent[] = [];
  const duration = event.end
    ? event.end.getTime() - event.start.getTime()
    : 0;
  const MAX_EXPANSION = 365;
  const safeCount = Math.min(count, MAX_EXPANSION);

  for (let i = 0; i < safeCount; i++) {
    const start = advanceDate(event.start, freq, i);
    const end = duration ? new Date(start.getTime() + duration) : undefined;

    instances.push({
      ...event,
      start,
      end,
      dTag: i === 0 ? event.dTag : `${event.dTag}-${i}`,
    });
  }

  return instances;
}

/** Default palette of calendar collection colors, cycled through when the
 *  user creates a new calendar without choosing a specific color. */
export const CALENDAR_COLORS = [
  "#4c6ef5", // blue
  "#12b886", // teal
  "#f59f00", // yellow
  "#fa5252", // red
  "#be4bdb", // purple
  "#fd7e14", // orange
  "#20c997", // cyan
  "#e64980", // pink
];
