/**
 * Per-relay quality scoring — track success/latency over time so that
 * relay choices (redundancy ordering, fallback picks) prefer the ones
 * that actually work for *this* user.
 *
 * This is a pragmatic stand-in for full Thompson Sampling. We track:
 *   - success EWMA (0–1, recency-weighted hit rate)
 *   - latency EWMA (ms, recency-weighted average for successes)
 *
 * EWMA is cheap (O(1) update, no history), survives across sessions
 * because we persist to localStorage, and is good enough to bias the
 * relay set toward known-good endpoints without needing to track
 * per-attempt arrays. Authority: nostr clients like Coracle/welshman
 * track similar metrics; the only fancy thing they add is online-policy
 * exploration vs exploitation, which we can layer on later.
 *
 * Scope: this affects redundancy ordering and tie-breaking only. The
 * primary relay is still user-chosen and never overridden.
 *
 * @module relayScore
 */
import { logger } from "./logger";

const log = logger("relay-score");

/** Smoothing factor for the EWMA. 0.2 = react in ~5 samples. */
const ALPHA = 0.2;

/** localStorage key holding the score map. */
const STORAGE_KEY = "nostr-planner-relay-scores";

interface RelayScore {
  /** EWMA of success (1 on success, 0 on failure). */
  success: number;
  /** EWMA latency for SUCCESSFUL operations, milliseconds. */
  latencyMs: number;
  /** Total observations (used to weight early estimates). */
  count: number;
  /** Unix millis of last update — stale entries decay back to neutral. */
  updatedAt: number;
}

/** In-memory cache backed by localStorage. */
const scores = new Map<string, RelayScore>();

/** Track whether we've already hydrated to avoid repeat reads. */
let hydrated = false;

function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, RelayScore>;
    for (const [url, s] of Object.entries(parsed)) {
      if (typeof s?.success === "number" && typeof s.latencyMs === "number") {
        scores.set(url, s);
      }
    }
  } catch {
    // Corrupt entry — drop it, start fresh.
  }
}

/** Persist current scores. Throttled so a burst of records doesn't
 *  thrash localStorage. */
let persistTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersist(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      const obj: Record<string, RelayScore> = {};
      for (const [url, s] of scores) obj[url] = s;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
    } catch (err) {
      log.debug("persist failed (non-fatal):", err);
    }
  }, 500);
}

/** Record a successful relay operation. */
export function recordSuccess(url: string, latencyMs: number): void {
  hydrate();
  const prev = scores.get(url);
  const next: RelayScore = prev
    ? {
        success: prev.success * (1 - ALPHA) + 1 * ALPHA,
        latencyMs: prev.latencyMs * (1 - ALPHA) + latencyMs * ALPHA,
        count: prev.count + 1,
        updatedAt: Date.now(),
      }
    : { success: 1, latencyMs, count: 1, updatedAt: Date.now() };
  scores.set(url, next);
  schedulePersist();
}

/** Record a failed relay operation. */
export function recordFailure(url: string): void {
  hydrate();
  const prev = scores.get(url);
  const next: RelayScore = prev
    ? {
        success: prev.success * (1 - ALPHA), // failure pushes toward 0
        latencyMs: prev.latencyMs,           // no info on failure latency
        count: prev.count + 1,
        updatedAt: Date.now(),
      }
    : { success: 0, latencyMs: 10_000, count: 1, updatedAt: Date.now() };
  scores.set(url, next);
  schedulePersist();
}

/** Get a composite score in [0, 1] for ranking. Higher = better.
 *  Combines success rate (primary signal) with latency normalized to a
 *  5-second budget (secondary signal). Unknown relays get a neutral 0.5
 *  so they aren't permanently disadvantaged against a single failure. */
export function getScore(url: string): number {
  hydrate();
  const s = scores.get(url);
  if (!s) return 0.5; // neutral prior for unseen relays
  // Latency component: 1 at 0ms, 0 at 5000+ms, linear in between.
  const latencyScore = Math.max(0, Math.min(1, 1 - s.latencyMs / 5000));
  // 70% success, 30% latency — success dominates.
  return 0.7 * s.success + 0.3 * latencyScore;
}

/** Sort an array of relay URLs in descending score order (best first).
 *  Returns a NEW array; the caller's array is unchanged. */
export function sortRelaysByScore(urls: readonly string[]): string[] {
  return [...urls].sort((a, b) => getScore(b) - getScore(a));
}

/** Read raw score for diagnostics / Settings UI. */
export function getRawScore(url: string): RelayScore | null {
  hydrate();
  return scores.get(url) ?? null;
}

/** Clear all scores. Called on logout to avoid carrying one user's
 *  relay-reliability data into another user's session. */
export function clearScores(): void {
  scores.clear();
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}
