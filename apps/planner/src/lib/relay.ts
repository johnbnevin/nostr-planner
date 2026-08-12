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
import { recordSuccess, recordFailure, sortRelaysByScore } from "./relayScore";
import {
  recordReplication,
  enqueueRelayMirrorRetry,
  registerRelayMirrorDrainer,
  type MirrorOutcome,
} from "./replication";
import type { NostrSigner } from "./signer";

const log = logger("relay");

// ── Per-relay rate limiter ─────────────────────────────────────────
//
// Hard limit: 3 calls per second per relay URL. Any call (query or
// publish) that would exceed the limit is queued and executed once a
// slot opens. This prevents relay bans and keeps WebSocket traffic
// predictable regardless of how many React effects fire simultaneously.

/** Max relay operations (query or publish) per relay per second. */
const MAX_OPS_PER_SEC = 3;

/** Hard cap on queued operations per relay. Excess callers fail fast
 *  rather than letting the queue grow unbounded — a pathological burst
 *  (e.g. thousands of effects firing during a state thrash) shouldn't be
 *  able to leak megabytes of resolve callbacks held by setTimeout. */
const MAX_QUEUE_DEPTH = 200;

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
    if (queue.length >= MAX_QUEUE_DEPTH) {
      // Overflow: drop the OLDEST entry so the queue stays bounded.
      // Existing callers are non-blocking (the calls are recorded for
      // rate-limit accounting, not awaited), so dropping is a safe
      // memory-protection signal rather than a correctness regression.
      const dropped = queue.shift();
      try { dropped?.(); } catch { /* ignore */ }
      log.warn(`relay queue saturated for ${url} (>${MAX_QUEUE_DEPTH}) — releasing oldest`);
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

/** Signer used to answer NIP-42 AUTH challenges. Set by NostrContext on
 *  login; cleared on logout. Some relays (relay.damus.io, relay.nostr.band
 *  on certain filters, paid relays generally) won't return events until
 *  the connection is authenticated. */
let authSigner: NostrSigner | null = null;

/**
 * Inject (or clear) the signer used for NIP-42 AUTH responses.
 * The relay pool reads from this at AUTH time — no need to recreate
 * connections when the signer changes; the next challenge will use the
 * latest value. Pass null on logout so we don't accidentally sign auth
 * events under a stale identity.
 */
export function setRelayAuthSigner(signer: NostrSigner | null): void {
  authSigner = signer;
}

/** Build a NIP-42 AUTH response event for the given challenge.
 *  Kind 22242 (NIP-42), tags `relay` and `challenge`, no content. */
async function buildAuthEvent(relayUrl: string, challenge: string): Promise<NostrEvent | null> {
  const signer = authSigner;
  if (!signer) {
    log.debug("AUTH challenge received but no signer wired — declining");
    return null;
  }
  try {
    const signed = await signer.signEvent({
      kind: 22242,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["relay", relayUrl], ["challenge", challenge]],
      content: "",
    });
    log.info(`NIP-42 AUTH → ${relayUrl}`);
    return signed;
  } catch (err) {
    log.warn(`NIP-42 AUTH sign failed for ${relayUrl}:`, err);
    return null;
  }
}

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

/** Normalize a relay URL so trailing-slash and non-trailing-slash
 *  variants dedupe to the same entry (NIP-65 often has the slash;
 *  our SUGGESTED_RELAYS don't). Also lowercases the scheme. */
function normalizeRelayUrl(u: string): string {
  return u.trim().replace(/\/+$/, "").replace(/^WSS:/i, "wss:").replace(/^WS:/i, "ws:");
}

function computeRedundancy(): string[] {
  const primaryNorm = normalizeRelayUrl(primaryRelay);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...SUGGESTED_RELAYS, ...nip65Read, ...nip65Write]) {
    const norm = normalizeRelayUrl(raw);
    if (!norm || norm === primaryNorm) continue;
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  return out;
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
    // auth: handle NIP-42 challenges by signing a kind-22242 event with
    // the active signer. Required for paid/AUTH-gated relays. If no
    // signer is wired (logged out, or operation runs before login),
    // returning null causes the connection to remain unauthenticated —
    // free relays still serve filters they don't gate behind AUTH.
    open: (url) => new NRelay1(url, {
      backoff: false,
      auth: async (challenge: string) => {
        const ev = await buildAuthEvent(url, challenge);
        if (!ev) throw new Error("auth declined: no signer");
        return ev;
      },
    }),
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
  // Cancel any pending idle-time redundancy drain so it doesn't fire (with
  // its 30s timeout) after logout against a freshly-nulled pool.
  idleHandle?.cancel();
  idleHandle = null;
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

/**
 * Verify Schnorr signatures on a batch of events — never trust relays.
 * Processes in chunks and yields to the main thread between chunks so a
 * large result set can't block the UI. Events with invalid signatures are
 * dropped (logged at warn). Used by both the primary and fallback read paths.
 */
async function verifyEventsBatched(events: NostrEvent[]): Promise<NostrEvent[]> {
  const VERIFY_BATCH = 50;
  const verified: NostrEvent[] = [];
  for (let i = 0; i < events.length; i += VERIFY_BATCH) {
    if (i > 0) await new Promise((r) => setTimeout(r, 0)); // yield
    const batch = events.slice(i, i + VERIFY_BATCH);
    for (const e of batch) {
      try {
        if (verifyEvent(e as Parameters<typeof verifyEvent>[0])) verified.push(e);
      } catch {
        log.warn("invalid signature, dropping event", e.id?.slice(0, 8));
      }
    }
  }
  return verified;
}

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

  // Throttle: skip if an identical query *succeeded* very recently and is no
  // longer in-flight. We only record the timestamp on success (see the
  // finally below), so a transient timeout/error never pins an empty result
  // for 2s — the next caller is free to retry immediately.
  const lastTime = lastQueryTime.get(key);
  if (lastTime && Date.now() - lastTime < MIN_QUERY_INTERVAL_MS) {
    log.debug("query throttled (duplicate within 2s)", filter.kinds);
    return [];
  }

  const doQuery = async (): Promise<NostrEvent[]> => {
    let succeeded = false;
    try {
      const p = getPool(relays);

      // Enforce the per-relay rate limit before issuing the call. Router sends
      // queries to primary only, so only primary's slot is consumed. Awaiting
      // here means a burst of effects is actually throttled (queued) rather
      // than hammering the relay and risking a ban. The timeout budget below
      // starts only once we hold a slot, so queued time doesn't eat into it.
      await acquireSlot(primaryRelay);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      log.time("query");

      const startedAt = Date.now();
      try {
        log.info(`relay query → ${primaryRelay} kinds=${filter.kinds?.join(",") ?? "*"}`);
        // NPool.query swallows errors (including AbortSignal aborts) and
        // returns partial results, so a timeout surfaces as a *resolved*
        // promise with controller.signal.aborted === true — NOT a throw.
        // Check the signal explicitly to decide whether the primary actually
        // answered or whether we need to fail over to the redundancy set.
        const events = await p.query([filter], { signal: controller.signal });
        if (!controller.signal.aborted) {
          log.info(`relay query ✓ ${primaryRelay} ${events.length} event(s)`);
          recordSuccess(primaryRelay, Date.now() - startedAt);
          const verified = await verifyEventsBatched(events);
          log.debug(`query returned ${verified.length}/${events.length} events`, filter.kinds);
          succeeded = true;
          return verified;
        }
        // Aborted (timeout) — fall through to the redundancy failover below.
        recordFailure(primaryRelay);
        log.warn("query timed out after", timeoutMs, "ms, kinds:", filter.kinds);
      } catch (err) {
        recordFailure(primaryRelay);
        log.error("query failed:", err);
      } finally {
        clearTimeout(timer);
      }

      // Read fallback: the primary timed out or errored. Try the redundancy
      // set — the user may have data on another relay we know about, and
      // querying primary-only would make the app behave as if they have no
      // data at all. Best-quality redundancy relays first; tighter per-attempt
      // budget so a string of dead relays can't blow past the caller's window.
      const fallbackBudgetMs = Math.min(5_000, timeoutMs);
      const fallbackTargets = sortRelaysByScore(redundancyRelays);
      for (const fbUrl of fallbackTargets) {
        try {
          await acquireSlot(fbUrl);
          const fbCtrl = new AbortController();
          const fbTimer = setTimeout(() => fbCtrl.abort(), fallbackBudgetMs);
          const fbStarted = Date.now();
          try {
            log.info(`relay query (fallback) → ${fbUrl} kinds=${filter.kinds?.join(",") ?? "*"}`);
            const fbEvents = await p.query([filter], { signal: fbCtrl.signal, relays: [fbUrl] });
            if (fbCtrl.signal.aborted) {
              recordFailure(fbUrl);
              log.debug(`relay query (fallback) ${fbUrl}: timed out, trying next`);
              continue;
            }
            recordSuccess(fbUrl, Date.now() - fbStarted);
            if (fbEvents.length > 0) {
              log.info(`relay query (fallback) ✓ ${fbUrl} ${fbEvents.length} event(s)`);
              const verified = await verifyEventsBatched(fbEvents);
              succeeded = true;
              return verified;
            }
            log.debug(`relay query (fallback) ${fbUrl}: 0 events, trying next`);
          } finally {
            clearTimeout(fbTimer);
          }
        } catch (fbErr) {
          recordFailure(fbUrl);
          log.debug(`relay query (fallback) ✗ ${fbUrl}: ${fbErr instanceof Error ? fbErr.message : String(fbErr)}`);
        }
      }
      return [];
    } finally {
      log.timeEnd("query");
      inflight.delete(key);
      // Only record the throttle timestamp on a *successful* query. Recording
      // it on timeout/error would suppress retries for 2s and pin an empty
      // result on a flaky network.
      if (succeeded) {
        const now = Date.now();
        lastQueryTime.set(key, now);
        // Prune stale entries to prevent unbounded growth — long sessions with
        // date-range filters that change every render would otherwise
        // accumulate indefinitely.
        if (lastQueryTime.size > 200) {
          for (const [k, ts] of lastQueryTime) {
            if (now - ts > QUERY_TIME_TTL_MS) lastQueryTime.delete(k);
          }
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
 * @param opts - `maxRetries` (default 3) caps in-function retries; pass 0 to
 *   make a single attempt (the outbox drain owns its own backoff and must not
 *   nest retry loops). `notifyOnFailure` (default true) controls whether
 *   exhausting attempts fires the publish-failure handlers — the outbox sets
 *   this false so a re-drain doesn't re-toast an already-reported failure.
 * @throws Error if all retry attempts to the primary are exhausted.
 */
/** Pull a human-useful reason out of NPool's publish rejection. NPool
 *  throws AggregateError whose inner errors carry the relay's OK-false
 *  message (or the socket/timeout failure); surface the first non-generic
 *  one so whitelist rejections and the like aren't flattened into
 *  "could not reach". */
function extractPublishReason(err: unknown): string {
  // Duck-typed AggregateError check — the project's TS lib target predates
  // the AggregateError global declaration.
  const maybeAgg = err as { errors?: unknown[] };
  const inner: unknown[] = Array.isArray(maybeAgg?.errors) ? maybeAgg.errors : [err];
  for (const e of inner) {
    const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "";
    if (msg && msg !== "All promises were rejected") return msg;
  }
  return err instanceof Error && err.message !== "All promises were rejected" ? err.message : "";
}

export async function publishToRelays(
  relays: string[],
  event: NostrEvent,
  timeoutMs = 10000,
  opts: { maxRetries?: number; notifyOnFailure?: boolean } = {}
): Promise<void> {
  const MAX_RETRIES = opts.maxRetries ?? 3;
  const notifyOnFailure = opts.notifyOnFailure ?? true;
  const RETRY_DELAY_MS = 2000;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const p = getPool(relays);

    // Enforce the per-relay rate limit (router sends to primary only). Awaited
    // so a publish burst is genuinely throttled rather than hammering the relay.
    await acquireSlot(primaryRelay);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const startedAt = Date.now();
    try {
      log.info(`relay publish → ${primaryRelay} kind=${event.kind} id=${event.id?.slice(0, 8)}`);
      await p.event(event, { signal: controller.signal });
      log.info(`relay publish ✓ ${primaryRelay} kind=${event.kind}`);
      recordSuccess(primaryRelay, Date.now() - startedAt);
      // Queue for background redundancy publish. Never awaited — caller
      // returns immediately once primary has accepted the event.
      scheduleRedundancy(event);
      return;
    } catch (err) {
      recordFailure(primaryRelay);
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_DELAY_MS * (attempt + 1);
        log.warn(`publish attempt ${attempt + 1}/${MAX_RETRIES + 1} failed, retrying in ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
      } else {
        log.error("publish failed after", MAX_RETRIES, "retries:", err);
        // The raw error from NPool is usually AggregateError("All promises
        // were rejected") which is cryptic in a user-facing toast. Wrap
        // with a friendlier message that names the relay so the user
        // knows what's unreachable — but keep the underlying reason when
        // there is one: a relay that REJECTS the event (OK false — e.g.
        // "blocked: not on whitelist") is a very different failure from
        // one that's unreachable, and hiding the reason made the outbox's
        // lastError useless for diagnosing exactly that.
        const reason = extractPublishReason(err);
        const friendly = new Error(
          `could not reach primary relay (${primaryRelay})${reason ? ` — ${reason}` : ""}`
        );
        if (notifyOnFailure) notifyPublishFailure(friendly, event);
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

/** Enqueue an event for idle-time broadcast to redundancy relays.
 *  Privacy note: private personal events never reach the relays at all
 *  (CalendarContext skips publish for them — they live only in the
 *  Blossom snapshot). Encrypted shared-calendar events use kind 30078
 *  (NIP-78 app-data) and are opaque ciphertext, safe to mirror. Public
 *  NIP-52 calendar events (31922/31923/31924/31925) are user-opted-in
 *  and SHOULD reach the redundancy set so other clients can index them. */
function scheduleRedundancy(event: NostrEvent): void {
  if (redundancyRelays.length === 0) return;
  redundancyQueue.push(event);
  while (redundancyQueue.length > MAX_REDUNDANCY_QUEUE) {
    redundancyQueue.shift();
  }
  requestIdleRun(() => { void drainRedundancy(); });
}

/** Handle of the pending idle/timeout callback scheduled by requestIdleRun,
 *  so closePool() can cancel a drain that would otherwise fire (with its
 *  30s timeout) long after logout. */
let idleHandle: { cancel: () => void } | null = null;

/** Run `fn` when the event loop is idle. Falls back to a short setTimeout
 *  on runtimes without requestIdleCallback (Safari, some older WebViews).
 *  Tracks the handle so it can be cancelled on closePool(). */
function requestIdleRun(fn: () => void): void {
  const wrapped = () => { idleHandle = null; fn(); };
  const g = globalThis as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  };
  if (typeof g.requestIdleCallback === "function") {
    const h = g.requestIdleCallback(wrapped, { timeout: 30_000 });
    idleHandle = { cancel: () => g.cancelIdleCallback?.(h) };
  } else {
    const h = setTimeout(wrapped, 1000);
    idleHandle = { cancel: () => clearTimeout(h) };
  }
}

/** Publish a single event to a single relay URL, recording per-target
 *  quality scores. Returns { ok: boolean, error?: Error } so the caller
 *  can build a structured per-mirror outcome report. */
async function publishToOne(event: NostrEvent, url: string): Promise<{ ok: boolean; error?: Error }> {
  if (!pool) return { ok: false, error: new Error("pool closed") };
  await acquireSlot(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REDUNDANCY_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    await pool.event(event, { signal: controller.signal, relays: [url] });
    recordSuccess(url, Date.now() - startedAt);
    return { ok: true };
  } catch (err) {
    recordFailure(url);
    return { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
  } finally {
    clearTimeout(timer);
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
      // Score-bias the redundancy order: relays that have been reliable
      // for this user go first. The downside relays still get mirrored
      // (this isn't a filter), but they queue up after the good ones so
      // the user-perceived latency for completion is lower.
      const targets = sortRelaysByScore(redundancyRelays);
      log.info(`relay mirror → [${targets.join(", ")}] kind=${event.kind} id=${event.id?.slice(0, 8)}`);

      // Publish to each target individually so we know per-target which
      // ones accepted. Aggregate the result into a ReplicationReport for
      // the UI and enqueue failed targets for retry.
      const mirrors: MirrorOutcome[] = [];
      const failed: string[] = [];
      for (const url of targets) {
        const result = await publishToOne(event, url);
        mirrors.push(result.ok
          ? { url, status: "ok" }
          : { url, status: "failed", error: result.error?.message ?? "unknown" });
        if (!result.ok) failed.push(url);
      }
      log.info(`relay mirror complete: ${mirrors.filter((m) => m.status === "ok").length}/${mirrors.length} ok`);

      recordReplication({
        kind: "relay",
        primary: primaryRelay,
        mirrors,
        at: Date.now(),
      });
      if (failed.length > 0) enqueueRelayMirrorRetry(event, failed);

      // Yield to the event loop between events so UI stays responsive.
      await new Promise((r) => setTimeout(r, 0));
    }
  } finally {
    redundancyDraining = false;
  }
}

// Register the retry drainer: mirror-retry.ts calls this when its
// background timer fires for a relay task. Returns the per-target ok/fail
// split so the retry queue can prune satisfied targets.
registerRelayMirrorDrainer(async (event, urls) => {
  const ok: string[] = [];
  const failedUrls: string[] = [];
  for (const url of urls) {
    const result = await publishToOne(event, url);
    if (result.ok) ok.push(url);
    else failedUrls.push(url);
  }
  return { ok, failed: failedUrls };
});

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
