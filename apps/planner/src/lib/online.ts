/**
 * Online/offline awareness — combines `navigator.onLine` with a periodic
 * lightweight reachability probe of the primary relay's HTTP origin.
 *
 * Why a probe in addition to navigator.onLine?
 * - On iOS Safari and inside some VPN/captive-portal setups, navigator.onLine
 *   stays `true` even when no traffic actually reaches the network. Without
 *   a probe, the UI would show "online" while every publish times out.
 * - The probe is a HEAD request to the primary relay's https:// origin
 *   (NPool's WebSocket is wss://, but the same host responds to HTTPS).
 *   It runs only while the document is visible — we never burn battery
 *   probing in the background.
 *
 * @module online
 */
import { useEffect, useState } from "react";
import { getPrimaryRelay } from "./relay";
import { logger } from "./logger";

const log = logger("online");

/** How often to run the reachability probe while the tab is visible. */
const PROBE_INTERVAL_MS = 30_000;

/** Per-probe timeout — short enough that one slow probe doesn't pin "offline" for long. */
const PROBE_TIMEOUT_MS = 5_000;

/** Current best-guess online state. Starts from navigator.onLine and is
 *  refined by each probe outcome. Defaults to `true` when navigator is
 *  absent or hasn't reported a value yet (Node test envs, some
 *  pre-hydration paths) — assume online until proven otherwise. */
let cachedOnline: boolean =
  typeof navigator === "undefined" || navigator.onLine !== false ? true : false;

/** Subscribers notified whenever cachedOnline changes. */
const listeners = new Set<(online: boolean) => void>();

/** Notify subscribers if the state actually changed. */
function setOnline(next: boolean): void {
  if (next === cachedOnline) return;
  cachedOnline = next;
  log.info("online state →", next ? "online" : "offline");
  for (const fn of listeners) {
    try { fn(next); } catch (err) { log.warn("listener threw:", err); }
  }
}

/**
 * Best-effort synchronous check of the current online state. Combines
 * `navigator.onLine` (cheap, but lies sometimes) with the latest probe
 * result. Returns false only when both signal offline.
 */
export function isProbablyOnline(): boolean {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
  return cachedOnline;
}

/** Convert a `wss://` URL to its `https://` origin for a HEAD probe. */
function relayHttpOrigin(wssUrl: string): string | null {
  try {
    const u = new URL(wssUrl);
    const httpProto = u.protocol === "wss:" ? "https:" : u.protocol === "ws:" ? "http:" : null;
    if (!httpProto) return null;
    return `${httpProto}//${u.host}/`;
  } catch {
    return null;
  }
}

/** Fire one probe; updates `cachedOnline` based on the outcome. */
async function probe(): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    setOnline(false);
    return;
  }
  const url = relayHttpOrigin(getPrimaryRelay());
  if (!url) {
    // No probeable URL — fall back to navigator.onLine.
    setOnline(typeof navigator === "undefined" ? true : navigator.onLine);
    return;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    // Most relays answer HEAD / with NIP-11 metadata or a plain HTTP
    // response. Even a 4xx counts as "reachable" — we only care about
    // whether the network round-trip completed.
    await fetch(url, { method: "HEAD", mode: "no-cors", signal: ctrl.signal, cache: "no-store" });
    setOnline(true);
  } catch {
    // Distinguish: navigator.onLine still true but the relay didn't answer.
    // We treat this as offline because publishes will fail the same way.
    setOnline(false);
  } finally {
    clearTimeout(timer);
  }
}

/** Probe timer handle. Null while not running (e.g. tab hidden). */
let probeTimer: ReturnType<typeof setInterval> | null = null;

function startProbing(): void {
  if (probeTimer) return;
  // Kick off an immediate probe so a returning tab gets a fresh signal
  // without waiting a full interval.
  void probe();
  probeTimer = setInterval(() => { void probe(); }, PROBE_INTERVAL_MS);
}

function stopProbing(): void {
  if (probeTimer) { clearInterval(probeTimer); probeTimer = null; }
}

/** Wire up browser online/offline events + visibility-gated probing.
 *  Idempotent — calling more than once is a no-op. */
let wired = false;
function ensureWired(): void {
  if (wired || typeof window === "undefined") return;
  wired = true;
  window.addEventListener("online", () => {
    setOnline(true);
    void probe(); // confirm with a real probe rather than trusting the OS
  });
  window.addEventListener("offline", () => setOnline(false));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") startProbing();
    else stopProbing();
  });
  if (typeof document === "undefined" || document.visibilityState === "visible") {
    startProbing();
  }
}

/** Subscribe to online-state transitions. Returns an unsubscribe fn.
 *  The probe loop is started lazily on first subscription and stopped
 *  when the last subscriber unsubscribes — long-lived tabs with
 *  components that come and go don't accumulate zombie timers. */
export function onOnlineChange(fn: (online: boolean) => void): () => void {
  ensureWired();
  listeners.add(fn);
  if (typeof document === "undefined" || document.visibilityState === "visible") {
    startProbing();
  }
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0) stopProbing();
  };
}

/** React hook variant of {@link onOnlineChange}. */
export function useOnline(): boolean {
  ensureWired();
  const [online, setState] = useState<boolean>(isProbablyOnline());
  useEffect(() => {
    // Subscribe; the listener fires (asynchronously) on any change.
    // We don't reconcile synchronously here because the initial value
    // came from the same source and any drift will be corrected by the
    // very next subscribe-triggered notification.
    return onOnlineChange(setState);
  }, []);
  return online;
}
