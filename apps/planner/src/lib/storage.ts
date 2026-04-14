/**
 * Safe localStorage wrapper.
 *
 * `localStorage.setItem()` throws `QuotaExceededError` when storage is full.
 * Calling it without a try/catch causes silent failures where settings,
 * deletions, and login state are never persisted. All writes should go
 * through `lsSet()` so the error is at least logged rather than swallowed.
 */

import { logger } from "./logger";

const log = logger("storage");

/**
 * Write a value to localStorage, logging a warning on quota errors.
 * Returns `true` on success, `false` on failure (quota exceeded or unavailable).
 */
export function lsSet(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (err) {
    // QuotaExceededError is the most common failure; log it so it's visible.
    log.warn(`localStorage.setItem failed for key "${key}":`, err);
    return false;
  }
}

/**
 * Remove a key from localStorage, silently ignoring errors.
 */
export function lsRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Ignore — removal failing is not actionable
  }
}

/**
 * Read a value from localStorage, returning null on any error.
 */
export function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
