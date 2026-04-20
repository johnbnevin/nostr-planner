/**
 * Shared relay pool — manages WebSocket connections to Nostr relays.
 *
 * Uses @nostrify/nostrify's NPool for connection pooling, deduplication,
 * and reconnection.
 *
 * Relay strategy (primary / redundancy split):
 * - The **primary relay** is user-configurable (see SettingsContext) and is
 *   the only relay on the hot path. Every query and every interactive
 *   publish goes here and nowhere else, so redundancy relays being slow or
 *   down can never slow the app down. The default primary is the first
 *   entry in SUGGESTED_RELAYS (damus), but users can switch to any of their
 *   NIP-65 relays, another suggested relay, or a custom URL.
 * - Redundancy relays (the other suggested relays plus the user's NIP-65
 *   read/write lists, minus whatever is currently primary) are written to
 *   in the background during idle time only. After each successful primary
 *   publish, the event is queued and broadcast to the redundancy set via
 *   requestIdleCallback — purely for data durability.
 * - NIP-65 read relays are NOT queried on the hot path either. The primary
 *   holds the app's authoritative state; redundancy is backup, not failover.
 *
 * Key behaviors:
 * - Pool is singleton — all contexts share one pool instance.
 * - Switching the primary closes the old pool; next use lazily opens a new
 *   one routed at the new primary.
 * - Every received event has its Schnorr signature verified before returning.
 * - Interactive publishes retry up to 3 times with linear backoff.
 * - Background redundancy publishes are best-effort: no retries, silent failures.
 * - Publish failures can be observed via onPublishFailure() for UI toasts.
 * - **Rate limiting:** max 3 relay calls (queries + publishes) per relay per
 *   second. Excess calls are queued and drained at the rate limit.
 *
 * @module relay
 */

import { NPool, NRelay1 } from "@nostrify/nostrify";
import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";
import { verifyEvent } from "nostr-tools/pure";
import { SUGGESTED_RELAYS } from "./nostr";
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

/** The single shared pool instance. Null when logged out or after the
 *  primary relay changes (next getPool call will recreate). */
let pool: NPool | null = null;

/** URL of the current primary relay — the only relay used on the hot path.
 *  Defaults to the first suggested relay; SettingsContext replaces this on
 *  login with the user's saved preference (if any). Consumers that run on
 *  login must include `primaryRelay` in their effect deps so they retry
 *  once SettingsContext has restored the saved choice (see loadSnapshot
 *  and watchPointer in CalendarApp for the pattern). */
let primaryRelay: string = SUGGESTED_RELAYS[0];

/** Cached NIP-65 read/write lists from the user's kind-10002 event.
 *  Kept to feed the Settings UI list and to compute redundancy, nothing
 *  else — they are never on the hot path. */
let nip65Read: string[] = [];
let nip65Write: string[] = [];

/** Redundancy relay URLs — the union of SUGGESTED_RELAYS and the user's
 *  NIP-65 list, minus whatever is currently primary. Recomputed on every
 *  primary change and on every NIP-65 update. */
let redundancyRelays: string[] = computeRedundancy();

function computeRedundancy(): string[] {
  return [...new Set([...SUGGESTED_RELAYS, ...nip65Read, ...nip65Write])]
    .filter((u) => u !== primaryRelay);
}

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
 * Fold the user's NIP-65 read/write lists into the redundancy set.
 *
 * The hot path (queries + interactive publishes) always uses the primary
 * relay only, so NIP-65 relays never become active read/write targets —
 * they're purely additional redundancy destinations for idle-time
 * background publishes. This preserves data portability (user's preferred
 * relays still get a copy) without trading off UX latency. The lists are
 * also exposed via {@link getNip65Relays} so the Settings UI can offer
 * them as choices for the primary relay.
 */
export function setRelayLists(read: string[], write: string[]): void {
  nip65Read = [...read];
  nip65Write = [...write];
  redundancyRelays = computeRedundancy();
  log.debug("NIP-65 relays:", { read: nip65Read.length, write: nip65Write.length, redundancy: redundancyRelays.length });
}

/** Get the current NIP-65 read/write lists for UI display. */
export function getNip65Relays(): { read: string[]; write: string[] } {
  return { read: [...nip65Read], write: [...nip65Write] };
}

/** Get the URL of the currently active primary relay. */
export function getPrimaryRelay(): string {
  return primaryRelay;
}

/**
 * Switch the primary relay to a new URL.
 *
 * Validates the URL (must start with `wss://` or `ws://`), closes the
 * existing pool so subsequent reads/writes route to the new primary, and
 * recomputes the redundancy set. A no-op if the URL is unchanged or
 * invalid.
 */
export function setPrimaryRelay(url: string): void {
  const trimmed = url.trim();
  if (!trimmed) return;
  if (!/^wss?:\/\//i.test(trimmed)) {
    log.warn("setPrimaryRelay: ignoring invalid URL (must be ws:// or wss://):", trimmed);
    return;
  }
  if (trimmed === primaryRelay) return;
  log.debug("switching primary relay:", primaryRelay, "→", trimmed);
  primaryRelay = trimmed;
  redundancyRelays = computeRedundancy();
  // Close the current pool so the next getPool() call builds one routed at
  // the new primary. NRelay1 instances for stale primaries are dropped.
  pool?.close().catch(() => {});
  pool = null;
}

// ── Pool management ─────────────────────────────────────────────────

/**
 * Get or create the shared relay pool.
 *
 * Router behavior: every query and every publish (via pool.event without a
 * `relays` override) goes to the current `primaryRelay`. Routers are
 * evaluated per-request, so the pool picks up changes to primaryRelay
 * immediately — but we also close the pool on setPrimaryRelay so stale
 * WebSocket connections to the old primary are dropped eagerly.
 *
 * Background idle-time redundancy publishes call
 * pool.event(event, { relays: redundancyRelays }) to bypass the router
 * and target the redundancy set explicitly, reusing cached connections.
 *
 * The `relays` argument is accepted for backward-compatibility with callers
 * that pass a relay list (e.g. early login before NIP-65 is resolved) but
 * has no effect on routing — primary is always the hot path.
 */
export function getPool(_relays: string[] = []): NPool {
  if (pool) return pool;

  log.debug("creating pool, primary:", primaryRelay);

  pool = new NPool({
    // backoff: false — NRelay1 reconnection is managed implicitly; we don't
    // need its built-in backoff here since failed idle publishes are
    // silently dropped and primary failures surface through retry logic.
    open: (url) => new NRelay1(url, { backoff: false }),
    reqRouter: (filters) => new Map([[primaryRelay, [...filters]]]),
    eventRouter: () => [primaryRelay],
  });

  return pool;
}

/**
 * Close the shared pool and reset all relay state.
 * Called on logout to clean up WebSocket connections. Keeps the current
 * primaryRelay intact so a re-login (same user) lands on the same primary.
 */
export function closePool(): void {
  pool?.close().catch(() => {});
  pool = null;
  nip65Read = [];
  nip65Write = [];
  redundancyRelays = computeRedundancy();
  redundancyQueue.length = 0;
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

    // Record the call for rate-limit tracking (non-blocking).
    // Router sends queries to primary only, so only primary's slot is used.
    acquireSlot(primaryRelay);

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
 * Publish an event to the primary relay, then schedule a background
 * redundancy publish to damus/ditto (and any NIP-65 relays) during idle time.
 *
 * On primary failure, retries up to 3 times with linear backoff (2s, 4s, 6s).
 * Throws if all attempts fail — the caller should catch this and show a
 * "Failed to save" toast or similar. The caller never waits on redundancy.
 * Rate-limited to 3 calls/sec per relay.
 *
 * @param relays - Relay URLs (accepted for backward-compat; routing is
 *   always to primary regardless of this list).
 * @param event - Signed Nostr event to publish.
 * @param timeoutMs - Timeout per attempt. Default: 10s.
 * @throws Error if all retry attempts to the primary are exhausted.
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

    // Rate-limit slot for primary (router sends to primary only).
    acquireSlot(primaryRelay);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      await p.event(event, { signal: controller.signal });
      log.debug("published to primary", event.id?.slice(0, 8), "kind:", event.kind);
      // Queue for background redundancy publish. Never awaited — caller
      // returns immediately once primary has accepted the event.
      scheduleRedundancy(event);
      return;
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_DELAY_MS * (attempt + 1);
        log.warn(`publish attempt ${attempt + 1}/${MAX_RETRIES + 1} failed, retrying in ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
      } else {
        log.error("publish failed after", MAX_RETRIES, "retries:", err);
        // The raw error from NPool is usually AggregateError("All promises
        // were rejected") which is cryptic in a user-facing toast. Wrap
        // with a friendlier message that names the relay so the user
        // knows what's unreachable. The original error is still logged
        // above for debugging.
        const friendly = new Error(`could not reach primary relay (${primaryRelay})`);
        notifyPublishFailure(friendly, event);
        throw friendly;
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

// ── Background redundancy publishing ────────────────────────────────
//
// After a successful primary publish, each event is queued for background
// redundancy. A drainer, invoked via requestIdleCallback (setTimeout
// fallback), replays queued events to every redundancy relay. These
// publishes are best-effort — failures are logged at debug and dropped
// without retry, since the event is already durably stored on primary.

/** Max events pending redundancy publish. Bursts beyond this drop the
 *  oldest queued events — primary already has them, so dropping is safe. */
const MAX_REDUNDANCY_QUEUE = 500;

/** Queue of events awaiting idle-time redundancy broadcast. */
const redundancyQueue: NostrEvent[] = [];

/** True while drainRedundancy is running, to prevent overlapping drains. */
let redundancyDraining = false;

/** Per-publish timeout for redundancy relays (longer than primary: not on
 *  the hot path, so a slow relay can have time without harming UX). */
const REDUNDANCY_TIMEOUT_MS = 15_000;

/** Enqueue an event for idle-time broadcast to redundancy relays. */
function scheduleRedundancy(event: NostrEvent): void {
  if (redundancyRelays.length === 0) return;
  redundancyQueue.push(event);
  while (redundancyQueue.length > MAX_REDUNDANCY_QUEUE) {
    redundancyQueue.shift();
  }
  requestIdleRun(() => { void drainRedundancy(); });
}

/** Run `fn` when the event loop is idle. Falls back to a short setTimeout
 *  on runtimes without requestIdleCallback (Safari, some older WebViews). */
function requestIdleRun(fn: () => void): void {
  const g = globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void };
  if (typeof g.requestIdleCallback === "function") {
    g.requestIdleCallback(fn, { timeout: 30_000 });
  } else {
    setTimeout(fn, 1000);
  }
}

/** Drain the redundancy queue, publishing each event to every redundancy
 *  relay. Runs serially to avoid saturating the browser's WebSocket budget,
 *  and yields between events so it never blocks the main thread for long. */
async function drainRedundancy(): Promise<void> {
  if (redundancyDraining) return;
  if (!pool || redundancyRelays.length === 0 || redundancyQueue.length === 0) return;
  redundancyDraining = true;
  try {
    while (redundancyQueue.length > 0 && redundancyRelays.length > 0) {
      const event = redundancyQueue.shift()!;
      const targets = [...redundancyRelays];
      for (const url of targets) acquireSlot(url);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REDUNDANCY_TIMEOUT_MS);
      try {
        // pool.event with explicit `relays` bypasses the primary-only router.
        await pool.event(event, { signal: controller.signal, relays: targets });
        log.debug("redundancy publish ok", event.id?.slice(0, 8));
      } catch (err) {
        log.debug("redundancy publish failed (best-effort):", err);
      } finally {
        clearTimeout(timer);
      }

      // Yield to the event loop between events so UI stays responsive.
      await new Promise((r) => setTimeout(r, 0));
    }
  } finally {
    redundancyDraining = false;
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
