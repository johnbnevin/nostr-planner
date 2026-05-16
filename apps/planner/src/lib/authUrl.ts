/**
 * Auth-url broadcast — surfaces NIP-46 `auth_url` requests to the UI so a
 * modal can prompt the user to approve in their signer app via a real
 * user gesture.
 *
 * Why: `window.open()` from the BunkerSigner's default `onauth` callback
 * is blocked in standalone PWA mode (no browser chrome to host the new
 * tab), and on mobile Safari it routes the user out of the PWA into a
 * regular Safari window — which often kills the PWA's relay subscription
 * before the approval can complete. Routing through a user-gesture
 * button preserves the PWA context and works on every platform.
 *
 * @module authUrl
 */
import { logger } from "./logger";

const log = logger("auth-url");

type Listener = (url: string) => void;
const listeners = new Set<Listener>();

/** Subscribe to incoming auth URL requests. */
export function onAuthUrl(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Called by the NIP-46 layer when the bunker requests user approval. */
export function emitAuthUrl(url: string): void {
  log.info("auth_url requested:", url);
  if (listeners.size === 0) {
    // No UI is listening (yet). As a last-resort fallback, log it so
    // the user sees something useful in dev tools.
    log.warn("no auth-url listener attached; user may not see prompt");
    return;
  }
  for (const fn of listeners) {
    try { fn(url); } catch (err) { log.warn("listener threw:", err); }
  }
}
