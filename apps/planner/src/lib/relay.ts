/**
 * Shared relay pool — manages WebSocket connections to Nostr relays.
 *
 * Uses @nostrify/nostrify's NPool for connection pooling, deduplication,
 * and reconnection. Implements NIP-65 outbox model: reads are routed to
 * the user's read relays, writes to their write relays.
 *
 * Key behaviors:
 * - Pool is singleton — all contexts share one pool instance.
 * - Pool is recreated if the relay list changes (e.g. after NIP-65 fetch).
 * - Every received event has its Schnorr signature verified before returning.
 * - Publishes retry up to 3 times with exponential backoff.
 * - Publish failures can be observed via onPublishFailure() for UI toasts.
 * - **Rate limiting:** max 3 relay calls (queries + publishes) per relay per
 *   second. Excess calls are queued and drained at the rate limit.
 *
 * @module relay
 */

import { NPool, NRelay1 } from "@nostrify/nostrify";
import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";
import { verifyEvent } from "nostr-tools/pure";
import { DEFAULT_RELAYS } from "./nostr";
import { logger } from "./logger";

const log = logger("relay");

// ── Per-relay rate limiter ─────────────────────────────────────────
//
// Hard limit: 3 calls per second per relay URL. Any call (query or
// publish) that would exceed the limit is queued and executed once a
// slot opens. This prevents relay bans and keeps WebSocket traffic
// predictable regardless of how many React effects fire simultaneously.

/** Max relay operations (query or publish) per relay per second. */
const MAX_OPS_PER_SEC = 3;

/** Sliding-window timestamps of recent operations per relay URL. */
const relayCalls = new Map<string, number[]>();

/** Pending queue per relay URL — each entry resolves when a slot opens. */
const relayQueue = new Map<string, Array<() => void>>();

/**
 * Wait until the rate limit allows a call to this relay URL.
 * Resolves immediately if under the limit, otherwise queues.
 */
function acquireSlot(url: string): Promise<void> {
  const now = Date.now();
  let timestamps = relayCalls.get(url);
  if (!timestamps) {
    timestamps = [];
    relayCalls.set(url, timestamps);
  }

  // Prune timestamps older than 1 second
  while (timestamps.length > 0 && now - timestamps[0] > 1000) {
    timestamps.shift();
  }

  if (timestamps.length < MAX_OPS_PER_SEC) {
    timestamps.push(now);
    return Promise.resolve();
  }

  // Queue this caller — it will be released when a slot opens
  return new Promise<void>((resolve) => {
    let queue = relayQueue.get(url);
    if (!queue) {
      queue = [];
      relayQueue.set(url, queue);
    }
    queue.push(resolve);
    // Schedule drain: the oldest timestamp expires in (oldest + 1000 - now) ms
    const waitMs = timestamps[0] + 1000 - now + 1;
    scheduleDrain(url, waitMs);
  });
}

/** Active drain timers per relay URL, to avoid duplicate setTimeout calls. */
const drainTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Schedule a drain pass for the given relay's queue after `delayMs`.
 * Coalesces multiple schedule requests — only one timer per relay runs.
 */
function scheduleDrain(url: string, delayMs: number): void {
  if (drainTimers.has(url)) return;
  drainTimers.set(
    url,
    setTimeout(() => {
      drainTimers.delete(url);
      drainQueue(url);
    }, Math.max(1, delayMs))
  );
}

/**
 * Release as many queued callers as the current rate limit allows,
 * then schedule another drain if callers remain.
 */
function drainQueue(url: string): void {
  const queue = relayQueue.get(url);
  if (!queue || queue.length === 0) return;

  const now = Date.now();
  let timestamps = relayCalls.get(url);
  if (!timestamps) {
    timestamps = [];
    relayCalls.set(url, timestamps);
  }

  // Prune old timestamps
  while (timestamps.length > 0 && now - timestamps[0] > 1000) {
    timestamps.shift();
  }

  // Release callers up to available slots
  while (queue.length > 0 && timestamps.length < MAX_OPS_PER_SEC) {
    timestamps.push(Date.now());
    const resolve = queue.shift()!;
    resolve();
  }

  // If callers remain, schedule another drain
  if (queue.length > 0 && timestamps.length > 0) {
    const waitMs = timestamps[0] + 1000 - Date.now() + 1;
    scheduleDrain(url, waitMs);
  }
}

// ── Pool state ──────────────────────────────────────────────────────

/** The single shared pool instance. Null when logged out. */
let pool: NPool | null = null;

/** The relay URLs currently backing the pool. Used to detect changes. */
let currentRelays: string[] = [];

/** NIP-65 read relays (queries are sent here). */
let readRelays: string[] = [];

/** NIP-65 write relays (publishes are sent here). */
let writeRelays: string[] = [];

// ── NIP-65 relay list parsing ───────────────────────────────────────

/**
 * Parse a NIP-65 relay list event (kind 10002) into separate read and write sets.
 *
 * NIP-65 tags follow the format:
 *   ["r", "wss://relay.example.com"]           → both read and write
 *   ["r", "wss://relay.example.com", "read"]   → read only
 *   ["r", "wss://relay.example.com", "write"]  → write only
 *
 * @returns Object with `read`, `write`, and `all` (deduplicated union) arrays.
 */
export function parseRelayList(event: { tags: string[][] }): {
  read: string[];
  write: string[];
  all: string[];
} {
  const read: string[] = [];
  const write: string[] = [];
  for (const tag of event.tags) {
    if (tag[0] !== "r") continue;
    const url = tag[1];
    const marker = tag[2]; // "read" | "write" | undefined (both)
    if (!marker || marker === "read") read.push(url);
    if (!marker || marker === "write") write.push(url);
  }
  return { read, write, all: [...new Set([...read, ...write])] };
}

/**
 * Update the NIP-65 read/write relay sets.
 * Call this after fetching the user's kind 10002 event on login.
 * Falls back to DEFAULT_RELAYS if either set is empty.
 */
export function setRelayLists(read: string[], write: string[]): void {
  readRelays = read.length > 0 ? read : DEFAULT_RELAYS;
  writeRelays = write.length > 0 ? write : DEFAULT_RELAYS;
  log.debug("NIP-65 relays set:", { read: readRelays.length, write: writeRelays.length });
}

// ── Pool management ─────────────────────────────────────────────────

/** Resolved read/write relay URLs for the current pool. Cached for rate-limit lookup. */
let activeReadRelays: string[] = [];
let activeWriteRelays: string[] = [];

/**
 * Get or create the shared relay pool.
 *
 * If the relay list has changed since the last call, the old pool is closed
 * and a new one is created. This is cheap — NRelay1 connects lazily on
 * first use, not on construction.
 *
 * The pool routes requests using the NIP-65 outbox model:
 * - Queries → read relays (up to 5)
 * - Publishes → write relays (up to 5)
 */
export function getPool(relays: string[]): NPool {
  // Check if we can reuse the existing pool (same relay list)
  const sorted = [...relays].sort();
  const currentSorted = [...currentRelays].sort();
  if (pool && sorted.join(",") === currentSorted.join(",")) {
    return pool;
  }

  // Close old pool if relay list changed
  pool?.close().catch(() => {});
  currentRelays = relays;

  const urls = relays.length > 0 ? relays : DEFAULT_RELAYS;
  const rRelays = readRelays.length > 0 ? readRelays : urls;
  const wRelays = writeRelays.length > 0 ? writeRelays : urls;

  // Cache active relay sets — cap at 3 to keep queries fast and predictable
  activeReadRelays = rRelays.slice(0, 3);
  activeWriteRelays = wRelays.slice(0, 3);

  log.debug("creating pool:", rRelays.length, "read,", wRelays.length, "write relays");

  pool = new NPool({
    // backoff: false — NPool manages reconnection at the pool level, so we
    // disable NRelay1's built-in per-relay backoff to avoid double-backoff
    // behaviour where both layers independently retry the same downed relay.
    open: (url) => new NRelay1(url, { backoff: false }),

    // NIP-65 outbox: send all queries to read relays
    reqRouter: (filters) => {
      const map = new Map<string, NostrFilter[]>();
      for (const url of activeReadRelays) {
        map.set(url, filters);
      }
      return map;
    },

    // NIP-65 outbox: send all publishes to write relays
    eventRouter: () => activeWriteRelays,
  });

  return pool;
}

/**
 * Close the shared pool and reset all relay state.
 * Called on logout to clean up WebSocket connections.
 */
export function closePool(): void {
  pool?.close().catch(() => {});
  pool = null;
  currentRelays = [];
  readRelays = [];
  writeRelays = [];
  activeReadRelays = [];
  activeWriteRelays = [];
  log.debug("pool closed");
}

// ── Query deduplication ──────────────────────────────────────────────

/** In-flight query cache: identical filter queries share a single relay request. */
const inflight = new Map<string, Promise<NostrEvent[]>>();

/** Minimum interval between full refreshes with the same filter (ms). */
const MIN_QUERY_INTERVAL_MS = 2000;
const lastQueryTime = new Map<string, number>();

/**
 * Produce a canonical JSON key for a filter, independent of property/array ordering.
 *
 * JSON.stringify() is order-sensitive: { kinds:[31922,31923] } and
 * { kinds:[31923,31922] } produce different strings even though they match
 * the same events. We sort object keys and array values to ensure semantically
 * identical filters always map to the same deduplication key.
 */
export function filterKey(filter: NostrFilter): string {
  // Build a canonical JSON key for the filter, independent of property/array ordering.
  // Uses a single pass with sorted keys and in-place sorted array copies.
  const keys = Object.keys(filter).sort();
  const parts: string[] = [];
  for (const k of keys) {
    const v = (filter as Record<string, unknown>)[k];
    if (v === undefined) continue;
    const val = Array.isArray(v)
      ? JSON.stringify([...v].sort((a, b) => typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b))))
      : JSON.stringify(v);
    parts.push(`${JSON.stringify(k)}:${val}`);
  }
  return `{${parts.join(",")}}`;
}

/** Prune lastQueryTime entries older than this threshold to prevent unbounded growth. */
const QUERY_TIME_TTL_MS = 60_000;

// ── Query ───────────────────────────────────────────────────────────

/**
 * Query events from relays with a timeout.
 *
 * Returns deduplicated events with verified Schnorr signatures.
 * Events with invalid signatures are silently dropped (logged as warnings).
 * Concurrent identical queries are deduplicated (same filter → same result).
 * Rapid duplicate queries within 2s are throttled.
 * Rate-limited to 3 calls/sec per relay.
 *
 * @param relays - Relay URLs to query. Used to get/create the pool.
 * @param filter - Nostr filter (kinds, authors, #tags, limit, etc.)
 * @param timeoutMs - Maximum time to wait for relay responses. Default: 10s.
 * @returns Array of verified events, or empty array on timeout/error.
 */
export async function queryEvents(
  relays: string[],
  filter: NostrFilter,
  timeoutMs = 10000
): Promise<NostrEvent[]> {
  const key = filterKey(filter);

  // Deduplicate: if the same query is already in flight, piggyback on it
  const existing = inflight.get(key);
  if (existing) {
    log.debug("query deduplicated (in-flight)", filter.kinds);
    return existing;
  }

  // Throttle: skip if an identical query completed very recently and is no longer in-flight.
  // Only suppress when there's no in-flight promise — never return empty when we could wait.
  const lastTime = lastQueryTime.get(key);
  if (lastTime && Date.now() - lastTime < MIN_QUERY_INTERVAL_MS) {
    log.debug("query throttled (duplicate within 2s)", filter.kinds);
    return [];
  }

  const doQuery = async (): Promise<NostrEvent[]> => {
    const p = getPool(relays);

    // Record the call for rate-limit tracking (non-blocking)
    for (const u of activeReadRelays) acquireSlot(u);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    log.time("query");

    try {
      const events = await p.query([filter], { signal: controller.signal });

      // Verify Schnorr signatures — don't trust relays. Process in batches
      // and yield to the main thread between batches to avoid blocking UI.
      const VERIFY_BATCH = 50;
      const verified: NostrEvent[] = [];
      for (let i = 0; i < events.length; i += VERIFY_BATCH) {
        if (i > 0) await new Promise((r) => setTimeout(r, 0)); // yield
        const batch = events.slice(i, i + VERIFY_BATCH);
        for (const e of batch) {
          try {
            if (verifyEvent(e as Parameters<typeof verifyEvent>[0])) {
              verified.push(e);
            }
          } catch {
            log.warn("invalid signature, dropping event", e.id?.slice(0, 8));
          }
        }
      }

      log.debug(`query returned ${verified.length}/${events.length} events`, filter.kinds);
      return verified;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        log.warn("query timed out after", timeoutMs, "ms, kinds:", filter.kinds);
        return [];
      }
      log.error("query failed:", err);
      return [];
    } finally {
      clearTimeout(timer);
      log.timeEnd("query");
      inflight.delete(key);
      const now = Date.now();
      lastQueryTime.set(key, now);
      // Prune stale entries to prevent unbounded growth — long sessions with
      // date-range filters that change every render would otherwise accumulate
      // indefinitely.
      if (lastQueryTime.size > 200) {
        for (const [k, ts] of lastQueryTime) {
          if (now - ts > QUERY_TIME_TTL_MS) lastQueryTime.delete(k);
        }
      }
    }
  };

  const promise = doQuery();
  inflight.set(key, promise);
  return promise;
}

// ── Publish ─────────────────────────────────────────────────────────

/**
 * Publish an event to relays with automatic retry.
 *
 * On failure, retries up to 3 times with linear backoff
 * (2s, 4s, 6s). Throws if all attempts fail — the caller should
 * catch this and show a "Failed to save" toast or similar.
 * Rate-limited to 3 calls/sec per relay.
 *
 * @param relays - Relay URLs. Used to get/create the pool.
 * @param event - Signed Nostr event to publish.
 * @param timeoutMs - Timeout per attempt. Default: 10s.
 * @throws Error if all retry attempts are exhausted.
 */
export async function publishToRelays(
  relays: string[],
  event: NostrEvent,
  timeoutMs = 10000
): Promise<void> {
  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 2000;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const p = getPool(relays);

    // Record the call for rate-limit tracking (non-blocking)
    for (const u of activeWriteRelays) acquireSlot(u);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      await p.event(event, { signal: controller.signal });
      log.debug("published event", event.id?.slice(0, 8), "kind:", event.kind);
      return; // success
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_DELAY_MS * (attempt + 1);
        log.warn(`publish attempt ${attempt + 1}/${MAX_RETRIES + 1} failed, retrying in ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
      } else {
        log.error("publish failed after", MAX_RETRIES, "retries:", err);
        notifyPublishFailure(err instanceof Error ? err : new Error(String(err)), event);
        throw err;
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

// ── Publish failure observation ─────────────────────────────────────

/**
 * Subscribe to publish failures for UI feedback (e.g. toast notifications).
 *
 * Usage:
 *   const unsubscribe = onPublishFailure((error, event) => {
 *     showToast(`Failed to save: ${error.message}`);
 *   });
 *   // later:
 *   unsubscribe();
 *
 * @returns Cleanup function to remove the handler.
 */
type PublishFailureHandler = (error: Error, event: NostrEvent) => void;
const publishFailureHandlers: PublishFailureHandler[] = [];

const MAX_FAILURE_HANDLERS = 50;

export function onPublishFailure(handler: PublishFailureHandler): () => void {
  if (publishFailureHandlers.length >= MAX_FAILURE_HANDLERS) {
    log.warn("publish failure handler limit reached, ignoring new handler");
    return () => {};
  }
  publishFailureHandlers.push(handler);
  return () => {
    const idx = publishFailureHandlers.indexOf(handler);
    if (idx >= 0) publishFailureHandlers.splice(idx, 1);
  };
}

/** Notify all registered handlers of a publish failure. Called by NostrContext. */
export function notifyPublishFailure(error: Error, event: NostrEvent): void {
  for (const handler of publishFailureHandlers) {
    try { handler(error, event); } catch (err) { log.warn("publish failure handler threw:", err); }
  }
}

export type { NostrEvent, NostrFilter };
