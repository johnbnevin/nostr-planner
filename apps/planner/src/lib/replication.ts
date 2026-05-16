/**
 * Replication status + background mirror retry.
 *
 * Owns two concerns:
 *
 *   1. **Status reporting.** After every save (relay event publish or
 *      Blossom blob upload), the call site records the per-target
 *      outcome via `recordReplication()`. The UI subscribes via
 *      `onReplicationChange()` and renders a "✓ mirrored to N/M
 *      servers" line in the auto-backup tooltip.
 *
 *   2. **Mirror retry.** When a mirror fails, the call site queues it
 *      via `enqueueRelayMirrorRetry()` or `enqueueBlossomMirrorRetry()`.
 *      A background loop retries each pending mirror with exponential
 *      backoff. The primary copy is already durable (it accepted), so
 *      mirror retry is best-effort durability not blocking.
 *
 * Persistence: the retry queue is in-memory only. We don't persist
 * across tab kills because (a) the primary is still good and the data
 * will get re-mirrored on the next save anyway, (b) persisting the full
 * encrypted blob body in IndexedDB doubles storage cost for marginal
 * benefit, (c) the typical user pattern is many small saves and the
 * relevant retries are short-lived. The IndexedDB outbox handles the
 * "primary failed" case separately, which IS persisted.
 *
 * @module replication
 */
import type { NostrEvent } from "@nostrify/nostrify";
import { logger } from "./logger";
import { isProbablyOnline } from "./online";

const log = logger("replication");

// ── Status reporting ────────────────────────────────────────────────

export type MirrorStatus = "ok" | "failed";

export interface MirrorOutcome {
  /** Target URL (relay wss:// or Blossom https://). */
  url: string;
  /** ok = accepted (relay OK / Blossom 2xx with matching sha). */
  status: MirrorStatus;
  /** Free-form error description when status === "failed". */
  error?: string;
}

export interface ReplicationReport {
  /** Replication channel. Relay = Nostr events; Blossom = encrypted blobs. */
  kind: "relay" | "blossom";
  /** Server that confirmed the primary write. */
  primary: string;
  /** Per-mirror outcomes from the background fan-out. */
  mirrors: MirrorOutcome[];
  /** Unix ms when the save completed. */
  at: number;
}

let lastRelay: ReplicationReport | null = null;
let lastBlossom: ReplicationReport | null = null;

type Listener = (kind: "relay" | "blossom", report: ReplicationReport) => void;
const listeners = new Set<Listener>();

export function onReplicationChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function notify(kind: "relay" | "blossom", report: ReplicationReport): void {
  for (const fn of listeners) {
    try { fn(kind, report); } catch (err) { log.warn("listener threw:", err); }
  }
}

export function recordReplication(report: ReplicationReport): void {
  if (report.kind === "relay") lastRelay = report;
  else lastBlossom = report;
  const ok = report.mirrors.filter((m) => m.status === "ok").length;
  log.info(`${report.kind} replication: primary ${report.primary} + ${ok}/${report.mirrors.length} mirrors`);
  notify(report.kind, report);
}

export function getLastRelayReplication(): ReplicationReport | null { return lastRelay; }
export function getLastBlossomReplication(): ReplicationReport | null { return lastBlossom; }

// ── Mirror retry — relay events ─────────────────────────────────────

interface RelayMirrorTask {
  event: NostrEvent;
  /** Mirror URLs still owing a successful publish. */
  pending: Set<string>;
  attempts: number;
  /** Unix ms when this task is next eligible to retry. */
  nextAttemptAt: number;
}

const relayTasks = new Map<string, RelayMirrorTask>(); // keyed by event.id

/** Schedule of retry delays (ms). After exhausting, the task is dropped. */
const RETRY_DELAYS_MS = [10_000, 30_000, 60_000, 300_000, 600_000];

/**
 * Mark a set of relay mirror URLs as pending retry for this event.
 * Idempotent: existing pending URLs are merged. Replaces the task's
 * timer if there's already one running for this id.
 */
export function enqueueRelayMirrorRetry(event: NostrEvent, failedUrls: string[]): void {
  if (!event.id || failedUrls.length === 0) return;
  const now = Date.now();
  const existing = relayTasks.get(event.id);
  if (existing) {
    for (const u of failedUrls) existing.pending.add(u);
    log.debug(`relay mirror retry: ${event.id.slice(0, 8)} now pending [${[...existing.pending].join(", ")}]`);
  } else {
    relayTasks.set(event.id, {
      event,
      pending: new Set(failedUrls),
      attempts: 0,
      nextAttemptAt: now + RETRY_DELAYS_MS[0],
    });
    log.debug(`relay mirror retry: ${event.id.slice(0, 8)} queued for [${failedUrls.join(", ")}]`);
  }
  ensureTickerRunning();
}

// ── Mirror retry — Blossom blobs ────────────────────────────────────

interface BlossomMirrorTask {
  sha256: string;
  /** The raw blob body (encrypted envelope JSON, typically a few KB).
   *  Kept in memory only — not persisted across reloads. */
  body: Blob;
  /** Pre-signed BUD-02 upload auth header. Same one the primary used.
   *  Auths are 30-day TTL by default so a few minutes of retries are
   *  well within validity. */
  authHeader: string;
  pending: Set<string>;
  attempts: number;
  nextAttemptAt: number;
}

const blossomTasks = new Map<string, BlossomMirrorTask>(); // keyed by sha256

export function enqueueBlossomMirrorRetry(
  sha256: string,
  body: Blob,
  authHeader: string,
  failedServers: string[],
): void {
  if (failedServers.length === 0) return;
  const now = Date.now();
  const existing = blossomTasks.get(sha256);
  if (existing) {
    for (const s of failedServers) existing.pending.add(s);
    log.debug(`blossom mirror retry: ${sha256.slice(0, 8)} now pending [${[...existing.pending].join(", ")}]`);
  } else {
    blossomTasks.set(sha256, {
      sha256,
      body,
      authHeader,
      pending: new Set(failedServers),
      attempts: 0,
      nextAttemptAt: now + RETRY_DELAYS_MS[0],
    });
    log.debug(`blossom mirror retry: ${sha256.slice(0, 8)} queued for [${failedServers.join(", ")}]`);
  }
  ensureTickerRunning();
}

// ── Drain loop ──────────────────────────────────────────────────────

let ticker: ReturnType<typeof setInterval> | null = null;

/**
 * Set of injected drainers. Live in this module rather than imported
 * from relay.ts / backup.ts to avoid circular deps. The publish paths
 * register their drainers once at module init.
 */
let relayDrainer: ((event: NostrEvent, urls: string[]) => Promise<{ ok: string[]; failed: string[] }>) | null = null;
let blossomDrainer: ((sha256: string, body: Blob, authHeader: string, urls: string[]) => Promise<{ ok: string[]; failed: string[] }>) | null = null;

export function registerRelayMirrorDrainer(fn: NonNullable<typeof relayDrainer>): void {
  relayDrainer = fn;
}

export function registerBlossomMirrorDrainer(fn: NonNullable<typeof blossomDrainer>): void {
  blossomDrainer = fn;
}

function ensureTickerRunning(): void {
  if (ticker) return;
  ticker = setInterval(() => { void drainTick(); }, 5_000);
}

function stopTickerIfIdle(): void {
  if (relayTasks.size === 0 && blossomTasks.size === 0 && ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}

async function drainTick(): Promise<void> {
  if (!isProbablyOnline()) return;
  const now = Date.now();

  // ── Relay tasks ──
  for (const [id, task] of relayTasks) {
    if (now < task.nextAttemptAt) continue;
    if (!relayDrainer) break;
    const targets = [...task.pending];
    try {
      const result = await relayDrainer(task.event, targets);
      for (const url of result.ok) task.pending.delete(url);
      if (task.pending.size === 0) {
        log.info(`relay mirror retry ✓ ${id.slice(0, 8)} — all targets caught up`);
        relayTasks.delete(id);
      } else {
        task.attempts++;
        if (task.attempts >= RETRY_DELAYS_MS.length) {
          log.warn(`relay mirror retry exhausted for ${id.slice(0, 8)} — leaving on primary only`);
          relayTasks.delete(id);
        } else {
          task.nextAttemptAt = now + RETRY_DELAYS_MS[task.attempts];
        }
      }
    } catch (err) {
      log.warn(`relay mirror retry threw for ${id.slice(0, 8)}:`, err);
      task.attempts++;
      if (task.attempts >= RETRY_DELAYS_MS.length) {
        relayTasks.delete(id);
      } else {
        task.nextAttemptAt = now + RETRY_DELAYS_MS[task.attempts];
      }
    }
  }

  // ── Blossom tasks ──
  for (const [sha, task] of blossomTasks) {
    if (now < task.nextAttemptAt) continue;
    if (!blossomDrainer) break;
    const targets = [...task.pending];
    try {
      const result = await blossomDrainer(task.sha256, task.body, task.authHeader, targets);
      for (const url of result.ok) task.pending.delete(url);
      if (task.pending.size === 0) {
        log.info(`blossom mirror retry ✓ ${sha.slice(0, 8)} — all targets caught up`);
        blossomTasks.delete(sha);
      } else {
        task.attempts++;
        if (task.attempts >= RETRY_DELAYS_MS.length) {
          log.warn(`blossom mirror retry exhausted for ${sha.slice(0, 8)} — leaving on primary only`);
          blossomTasks.delete(sha);
        } else {
          task.nextAttemptAt = now + RETRY_DELAYS_MS[task.attempts];
        }
      }
    } catch (err) {
      log.warn(`blossom mirror retry threw for ${sha.slice(0, 8)}:`, err);
      task.attempts++;
      if (task.attempts >= RETRY_DELAYS_MS.length) {
        blossomTasks.delete(sha);
      } else {
        task.nextAttemptAt = now + RETRY_DELAYS_MS[task.attempts];
      }
    }
  }

  stopTickerIfIdle();
}

/** Clear all in-flight retries. Called on logout so a stale task can't
 *  fire after identity change. */
export function clearReplicationState(): void {
  relayTasks.clear();
  blossomTasks.clear();
  lastRelay = null;
  lastBlossom = null;
  if (ticker) { clearInterval(ticker); ticker = null; }
}

/** Diagnostic only — pending counts. */
export function getPendingMirrorCounts(): { relays: number; blossom: number } {
  let r = 0;
  for (const t of relayTasks.values()) r += t.pending.size;
  let b = 0;
  for (const t of blossomTasks.values()) b += t.pending.size;
  return { relays: r, blossom: b };
}
