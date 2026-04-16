/**
 * Structured logger with debug mode support.
 *
 * All logs use a `[module]` prefix for easy grep filtering.
 * Debug messages are only shown when `localStorage.planner-debug === "true"`.
 *
 * Usage:
 *   import { logger } from "./logger";
 *   const log = logger("relay");
 *   log.info("connected to", url);        // always shown
 *   log.warn("timeout on query", filter); // always shown
 *   log.error("publish failed", err);     // always shown
 *   log.debug("raw response", data);      // only when debug mode is on
 *   log.time("query");                    // start a timer
 *   log.timeEnd("query");                 // log elapsed ms (debug only)
 *
 * Enable debug mode:
 *   localStorage.setItem("planner-debug", "true")
 *
 * Disable debug mode:
 *   localStorage.removeItem("planner-debug")
 */

let _debugCached: boolean | null = null;

function isDebug(): boolean {
  if (_debugCached !== null) return _debugCached;
  try {
    _debugCached = localStorage.getItem("planner-debug") === "true";
    return _debugCached;
  } catch {
    return false; // SSR or restricted storage
  }
}

// Re-check when storage changes (e.g. from DevTools or another tab)
try {
  window.addEventListener("storage", (e) => {
    if (e.key === "planner-debug") _debugCached = e.newValue === "true";
  });
} catch { /* SSR */ }

const MAX_TIMERS = 100;
const timers = new Map<string, number>();

export interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  /** Start a named timer. Pairs with timeEnd(). */
  time(label: string): void;
  /** Log elapsed time since time() was called. Debug-only. */
  timeEnd(label: string): void;
}

/**
 * Create a logger for a specific module.
 *
 * @param module - Short module name, e.g. "relay", "calendar", "crypto".
 *                 Appears as `[module]` prefix in all log output.
 */
export function logger(module: string): Logger {
  const prefix = `[${module}]`;

  return {
    info: (...args) => console.log(prefix, ...args),
    warn: (...args) => console.warn(prefix, ...args),
    error: (...args) => console.error(prefix, ...args),
    debug: (...args) => {
      if (isDebug()) console.log(prefix, "[debug]", ...args);
    },
    time: (label) => {
      if (timers.size >= MAX_TIMERS) {
        // Evict oldest entry to prevent unbounded growth
        const firstKey = timers.keys().next().value;
        if (firstKey !== undefined) timers.delete(firstKey);
      }
      timers.set(`${module}:${label}`, performance.now());
    },
    timeEnd: (label) => {
      const key = `${module}:${label}`;
      const start = timers.get(key);
      if (start !== undefined) {
        const elapsed = Math.round(performance.now() - start);
        timers.delete(key);
        if (isDebug()) {
          console.log(prefix, `${label} took ${elapsed}ms`);
        }
      }
    },
  };
}
