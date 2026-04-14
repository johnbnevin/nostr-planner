/**
 * Relay connection using @nostrify/nostrify.
 */

import { NPool, NRelay1 } from "@nostrify/nostrify";
import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

const MAX_POOL_RELAYS = 5;

export function createPool(relays: string[]): NPool {
  if (relays.length > MAX_POOL_RELAYS) {
    console.warn(`[relay] Only first ${MAX_POOL_RELAYS} relays used, ignoring:`, relays.slice(MAX_POOL_RELAYS));
  }
  const active = relays.slice(0, MAX_POOL_RELAYS);
  return new NPool({
    open: (url) => new NRelay1(url, { backoff: false }),
    reqRouter: (filters) => {
      const map = new Map<string, NostrFilter[]>();
      for (const url of active) {
        map.set(url, filters);
      }
      return map;
    },
    eventRouter: () => active,
  });
}

export async function queryEvents(
  pool: NPool,
  filter: NostrFilter,
  timeoutMs = 15000
): Promise<NostrEvent[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await pool.query([filter], { signal: controller.signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      console.warn("[relay] query timed out");
      return [];
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export type { NostrEvent, NostrFilter };
