/**
 * Outbox — IndexedDB-backed write queue for events whose first publish
 * attempt failed.
 *
 * Goal: optimistic edits made on slow/spotty networks must survive a tab
 * kill and replay automatically once connectivity returns, without the
 * user having to do anything. The Blossom snapshot already provides
 * end-of-day durability; this queue provides minute-by-minute durability.
 *
 * Lifecycle:
 *   1. NostrContext.publishEvent calls publishToRelays.
 *   2. On failure (offline, timeout, all retries exhausted) the event is
 *      enqueued here.
 *   3. A drainer fires whenever any of these wake signals arrives:
 *        - `online` window event
 *        - `visibilitychange` → visible
 *        - explicit signer-came-online nudge
 *        - 60-second tick while we believe we're online
 *      It walks the queue oldest-first, attempts publish, drops on success,
 *      and applies exponential backoff (capped at 5 min) on failure.
 *   4. After 24 hours of continuous failure the event is dropped from the
 *      queue and a permanent-failure handler is fired.
 *
 * Scoped by pubkey: switching accounts won't replay the previous user's
 * pending writes.
 *
 * @module outbox
 */
import type { NostrEvent } from "@nostrify/nostrify";
import { publishToRelays } from "./relay";
import { logger } from "./logger";
import { isProbablyOnline, onOnlineChange } from "./online";

const log = logger("outbox");

const DB_NAME = "nostr-planner-outbox";
const DB_VERSION = 1;
const STORE_NAME = "pending";

interface OutboxEntry {
  /** Key: pubkey + ":" + event.id. Scopes by user so multi-account browsers
   *  don't replay one user's writes under another's signer. */
  key: string;
  pubkey: string;
  event: NostrEvent;
  queuedAt: number;
  lastAttemptAt: number;
  attempts: number;
  lastError: string;
}

let cachedDb: IDBDatabase | null = null;

function openDb(): Promise<IDBDatabase> {
  if (cachedDb) {
    try {
      cachedDb.transaction(STORE_NAME, "readonly");
      return Promise.resolve(cachedDb);
    } catch {
      cachedDb = null;
    }
  }
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "key" });
        store.createIndex("pubkey", "pubkey", { unique: false });
      }
    };
    req.onsuccess = () => {
      cachedDb = req.result;
      cachedDb.onclose = () => { cachedDb = null; };
      resolve(cachedDb);
    };
    req.onerror = () => reject(req.error);
  });
}

function entryKey(pubkey: string, eventId: string): string {
  return `${pubkey}:${eventId}`;
}

/** Read all entries for this pubkey, oldest-first. */
async function listEntries(pubkey: string): Promise<OutboxEntry[]> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, "readonly");
    const idx = tx.objectStore(STORE_NAME).index("pubkey");
    const req = idx.getAll(pubkey);
    const all = await new Promise<OutboxEntry[]>((resolve, reject) => {
      req.onsuccess = () => resolve((req.result as OutboxEntry[]) ?? []);
      req.onerror = () => reject(req.error);
    });
    all.sort((a, b) => a.queuedAt - b.queuedAt);
    return all;
  } catch (err) {
    log.warn("listEntries failed (non-fatal):", err);
    return [];
  }
}

async function putEntry(entry: OutboxEntry): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_NAME, "readwrite");
  tx.objectStore(STORE_NAME).put(entry);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function deleteEntry(key: string): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(key);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    log.warn("deleteEntry failed (non-fatal):", err);
  }
}

/** Enqueue a failed publish for later retry. */
export async function enqueueOutbox(
  pubkey: string,
  event: NostrEvent,
  error: Error
): Promise<void> {
  if (!event.id) {
    log.warn("refusing to enqueue event without id");
    return;
  }
  const now = Date.now();
  const key = entryKey(pubkey, event.id);
  try {
    await putEntry({
      key,
      pubkey,
      event,
      queuedAt: now,
      lastAttemptAt: now,
      attempts: 1,
      lastError: error.message,
    });
    log.info(`enqueued kind=${event.kind} id=${event.id.slice(0, 8)} (${error.message})`);
    notifyChange();
  } catch (err) {
    // IndexedDB write itself failed — last-resort fallback is the in-memory
    // queue used during this session only. Most browsers only fail here
    // when the user has disabled storage entirely. Notify any listeners
    // so the UI can warn the user that pending writes will be lost on
    // tab close.
    log.error("outbox enqueue failed (storage unavailable):", err);
    memoryQueue.push({ key, pubkey, event, queuedAt: now, lastAttemptAt: now, attempts: 1, lastError: error.message });
    for (const fn of storageUnavailableHandlers) {
      try { fn(); } catch { /* ignore */ }
    }
    notifyChange();
  }
}

/** Notified once if IndexedDB is unusable so the UI can warn the user. */
const storageUnavailableHandlers = new Set<() => void>();
export function onOutboxStorageUnavailable(fn: () => void): () => void {
  storageUnavailableHandlers.add(fn);
  return () => { storageUnavailableHandlers.delete(fn); };
}

// ── In-memory fallback for hostile storage environments ─────────────
const memoryQueue: OutboxEntry[] = [];

// ── Drain loop ─────────────────────────────────────────────────────

/** Max age before a queued event is given up on. Caller is notified. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Cap on exponential backoff between attempts. */
const MAX_BACKOFF_MS = 5 * 60 * 1000;

/** Returns true if the entry is eligible to attempt now. */
function isEligible(entry: OutboxEntry, now: number): boolean {
  const backoff = Math.min(MAX_BACKOFF_MS, 1000 * Math.pow(2, Math.max(0, entry.attempts - 1)));
  return now - entry.lastAttemptAt >= backoff;
}

/** Set of permanent-failure handlers. */
type PermanentFailureHandler = (event: NostrEvent, lastError: string) => void;
const permanentFailureHandlers = new Set<PermanentFailureHandler>();

export function onOutboxPermanentFailure(fn: PermanentFailureHandler): () => void {
  permanentFailureHandlers.add(fn);
  return () => { permanentFailureHandlers.delete(fn); };
}

/** Set of queue-change handlers (for UI badge). */
const changeHandlers = new Set<(depth: number) => void>();

export function onOutboxChange(fn: (depth: number) => void): () => void {
  changeHandlers.add(fn);
  return () => { changeHandlers.delete(fn); };
}

/** Coalesces rapid notifyChange calls during a drain so the UI doesn't
 *  thrash with one re-render per drained entry. */
let notifyTimer: ReturnType<typeof setTimeout> | null = null;

function notifyChange(): void {
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    // Best-effort depth count for UI; we don't await listEntries here.
    void countPending().then((depth) => {
      for (const fn of changeHandlers) {
        try { fn(depth); } catch (err) { log.warn("change handler threw:", err); }
      }
    });
  }, 250);
}

/** Synchronous-ish count: returns the most recent observed depth. */
let lastObservedDepth = 0;
export function getOutboxDepth(): number {
  return lastObservedDepth;
}

/** Count pending entries for a pubkey (or across all if pubkey is null). */
export async function countPending(pubkey?: string | null): Promise<number> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    let n: number;
    if (pubkey) {
      const req = store.index("pubkey").count(pubkey);
      n = await new Promise<number>((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } else {
      const req = store.count();
      n = await new Promise<number>((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    n += memoryQueue.filter((e) => !pubkey || e.pubkey === pubkey).length;
    lastObservedDepth = n;
    return n;
  } catch {
    const n = memoryQueue.filter((e) => !pubkey || e.pubkey === pubkey).length;
    lastObservedDepth = n;
    return n;
  }
}

/** Discard a queued event (e.g. user clicked "Discard" on the failure toast). */
export async function discardOutboxEntry(pubkey: string, eventId: string): Promise<void> {
  await deleteEntry(entryKey(pubkey, eventId));
  const idx = memoryQueue.findIndex((e) => e.key === entryKey(pubkey, eventId));
  if (idx >= 0) memoryQueue.splice(idx, 1);
  notifyChange();
}

/** Clear all entries for a pubkey. Called on logout. */
export async function clearOutbox(pubkey: string): Promise<void> {
  try {
    const entries = await listEntries(pubkey);
    for (const e of entries) await deleteEntry(e.key);
  } catch (err) {
    log.warn("clearOutbox failed (non-fatal):", err);
  }
  for (let i = memoryQueue.length - 1; i >= 0; i--) {
    if (memoryQueue[i].pubkey === pubkey) memoryQueue.splice(i, 1);
  }
  notifyChange();
}

let draining = false;
let drainScheduled: ReturnType<typeof setTimeout> | null = null;

/** Public entry point: try to drain the queue now, coalescing rapid calls. */
export function scheduleOutboxDrain(pubkey: string): void {
  if (drainScheduled) return;
  // Tiny debounce — multiple wake signals fire in quick succession on
  // visibilitychange + online + signer-online; we want one drain pass.
  drainScheduled = setTimeout(() => {
    drainScheduled = null;
    void drainOutbox(pubkey);
  }, 250);
}

/**
 * Walk the queue for this pubkey, attempting eligible entries. Successes
 * are removed; failures bump `attempts` and `lastAttemptAt`. Entries
 * older than MAX_AGE_MS are dropped and reported via permanentFailureHandlers.
 *
 * Single-flight: overlapping calls are coalesced.
 */
export async function drainOutbox(pubkey: string): Promise<void> {
  if (draining) return;
  if (!isProbablyOnline()) {
    log.debug("drain skipped (offline)");
    return;
  }
  draining = true;
  try {
    const entries = [
      ...(await listEntries(pubkey)),
      ...memoryQueue.filter((e) => e.pubkey === pubkey),
    ];
    if (entries.length === 0) return;
    log.info(`drain pass: ${entries.length} pending`);
    const now = Date.now();

    for (const entry of entries) {
      // Bail mid-drain if connectivity drops — next online event resumes.
      if (!isProbablyOnline()) {
        log.debug("drain aborted mid-pass (went offline)");
        break;
      }

      if (now - entry.queuedAt > MAX_AGE_MS) {
        log.warn(`giving up on kind=${entry.event.kind} id=${entry.event.id?.slice(0, 8)} after 24h`);
        await deleteEntry(entry.key);
        const memIdx = memoryQueue.findIndex((e) => e.key === entry.key);
        if (memIdx >= 0) memoryQueue.splice(memIdx, 1);
        for (const fn of permanentFailureHandlers) {
          try { fn(entry.event, entry.lastError); } catch (err) { log.warn("permanent-failure handler threw:", err); }
        }
        continue;
      }

      if (!isEligible(entry, Date.now())) continue;

      try {
        log.info(`drain → kind=${entry.event.kind} id=${entry.event.id?.slice(0, 8)} attempt=${entry.attempts + 1}`);
        await publishToRelays([], entry.event);
        await deleteEntry(entry.key);
        const memIdx = memoryQueue.findIndex((e) => e.key === entry.key);
        if (memIdx >= 0) memoryQueue.splice(memIdx, 1);
        log.info("drain ✓");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.info("drain ✗", msg);
        const next: OutboxEntry = {
          ...entry,
          lastAttemptAt: Date.now(),
          attempts: entry.attempts + 1,
          lastError: msg,
        };
        try { await putEntry(next); }
        catch {
          const memIdx = memoryQueue.findIndex((e) => e.key === entry.key);
          if (memIdx >= 0) memoryQueue[memIdx] = next;
        }
      }
    }
  } finally {
    draining = false;
    notifyChange();
  }
}

// ── Periodic ticker while online ─────────────────────────────────────

let ticker: ReturnType<typeof setInterval> | null = null;
/** Tracks which pubkey owns the active ticker — guards against stale
 *  fires after a logout/login where the previous closure could otherwise
 *  drain into the wrong user's pubkey. */
let activePubkey: string | null = null;

/** Begin background drain for this pubkey. Idempotent. Stops on `stopOutbox`. */
export function startOutbox(pubkey: string): void {
  stopOutbox();
  activePubkey = pubkey;
  // Immediate kickoff in case there's pending work from a previous session.
  scheduleOutboxDrain(pubkey);
  // 60s ticker while we believe we're online.
  ticker = setInterval(() => {
    // Bail if a logout / account switch happened between fires —
    // draining for an old user would be incorrect and could leak
    // pending events to the wrong identity.
    if (activePubkey !== pubkey) return;
    if (isProbablyOnline()) scheduleOutboxDrain(pubkey);
  }, 60_000);
  // Online transitions resume drain immediately.
  const offOnline = onOnlineChange((online) => {
    if (activePubkey !== pubkey) return;
    if (online) scheduleOutboxDrain(pubkey);
  });
  // Visibility transitions resume too.
  const onVisibility = () => {
    if (activePubkey !== pubkey) return;
    if (document.visibilityState === "visible") scheduleOutboxDrain(pubkey);
  };
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibility);
  }
  outboxCleanups.push(() => {
    offOnline();
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibility);
    }
  });
}

const outboxCleanups: Array<() => void> = [];

export function stopOutbox(): void {
  activePubkey = null;
  if (ticker) { clearInterval(ticker); ticker = null; }
  if (notifyTimer) { clearTimeout(notifyTimer); notifyTimer = null; }
  if (drainScheduled) { clearTimeout(drainScheduled); drainScheduled = null; }
  while (outboxCleanups.length > 0) {
    try { outboxCleanups.pop()!(); } catch { /* ignore */ }
  }
}

/** Force an immediate drain pass (no debounce). Used after a fresh signer
 *  becomes available, to flush events that failed during the gap. */
export async function flushOutbox(pubkey: string): Promise<void> {
  if (drainScheduled) { clearTimeout(drainScheduled); drainScheduled = null; }
  await drainOutbox(pubkey);
}
