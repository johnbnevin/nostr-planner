/**
 * IndexedDB-based offline cache for calendar events.
 *
 * Caches the last known set of decrypted calendar events and collections
 * so the user sees their calendar immediately on load, even if relays
 * are unreachable. The cache is scoped by pubkey and overwritten on
 * every successful relay sync.
 *
 * @module eventCache
 */

import type { CalendarEvent, CalendarCollection } from "./nostr";
import { logger } from "./logger";

const log = logger("cache");

const DB_NAME = "nostr-planner-cache";
const DB_VERSION = 1;
const STORE_NAME = "calendar-data";

interface CachedData {
  pubkey: string;
  events: CalendarEvent[];
  calendars: CalendarCollection[];
  cachedAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "pubkey" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Store decrypted events and calendars in IndexedDB.
 * Overwrites any previous cache for this pubkey.
 */
export async function cacheCalendarData(
  pubkey: string,
  events: CalendarEvent[],
  calendars: CalendarCollection[]
): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    // IndexedDB structured clone preserves Date objects natively —
    // no need to manually map/spread events.
    const serialized: CachedData = {
      pubkey,
      events,
      calendars,
      cachedAt: Date.now(),
    };
    store.put(serialized);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    log.debug("cached", events.length, "events,", calendars.length, "calendars");
  } catch (err) {
    log.warn("cache write failed (non-fatal):", err);
  }
}

/**
 * Load cached events and calendars from IndexedDB.
 * Returns null if no cache exists or on error.
 */
export async function loadCachedCalendarData(
  pubkey: string
): Promise<{ events: CalendarEvent[]; calendars: CalendarCollection[] } | null> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(pubkey);
    const result = await new Promise<CachedData | undefined>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    if (!result) return null;
    // IndexedDB structured clone preserves Date objects, so no conversion needed
    log.debug("loaded cache:", result.events.length, "events,", result.calendars.length, "calendars (from", new Date(result.cachedAt).toLocaleTimeString(), ")");
    return { events: result.events, calendars: result.calendars };
  } catch (err) {
    log.warn("cache read failed (non-fatal):", err);
    return null;
  }
}

/**
 * Clear the cache for a given pubkey. Called on logout.
 */
export async function clearCalendarCache(pubkey: string): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(pubkey);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Best-effort
  }
}
