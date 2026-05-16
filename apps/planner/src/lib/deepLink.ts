/**
 * Cross-platform deep-link handling for Nostr URIs.
 *
 * Schemes:
 *   - `bunker://` — NIP-46 bunker connection (from Amber, nsec.app, etc.)
 *   - `nostrconnect://` — NIP-46 nostrconnect handshake URI
 *
 * Sources:
 *   - **Web**: registered via `navigator.registerProtocolHandler` so the
 *     OS knows the planner can handle these schemes. When a user taps a
 *     bunker:// link, the browser launches the planner with the URI
 *     embedded in the location hash (via the redirect template). We also
 *     pick up bunker URIs from the initial page URL on startup.
 *   - **Tauri desktop / Android**: handled by `@tauri-apps/plugin-deep-link`,
 *     which registers OS-level intent filters (Android) and custom-scheme
 *     handlers (desktop). Subscribed via `onOpenUrl`. Apple platforms are
 *     deliberately not a target.
 *
 * Both paths emit through a single bus so LoginScreen and NostrContext
 * can react identically regardless of how the URI arrived.
 *
 * @module deepLink
 */
import { isTauri } from "./platform";
import { logger } from "./logger";

const log = logger("deep-link");

type Handler = (uri: string) => void;
const handlers = new Set<Handler>();

/** Subscribe to inbound deep-link URIs. */
export function onDeepLink(fn: Handler): () => void {
  handlers.add(fn);
  return () => { handlers.delete(fn); };
}

function emit(uri: string): void {
  log.info("deep-link received:", uri.slice(0, 40) + "…");
  for (const fn of handlers) {
    try { fn(uri); } catch (err) { log.warn("handler threw:", err); }
  }
}

/** Accept only the URI schemes the app knows how to act on. */
function isAcceptedUri(uri: string): boolean {
  return /^(bunker|nostrconnect):\/\//i.test(uri);
}

/** Initialize deep-link subscriptions for whichever platform we're on.
 *  Idempotent — calling multiple times is a no-op. Returns a cleanup
 *  function for the caller's lifecycle (root App effect). */
let initialized = false;
export function initDeepLinks(): () => void {
  if (initialized) return () => {};
  initialized = true;
  const cleanups: Array<() => void> = [];

  // Web path: registerProtocolHandler so the OS routes bunker:// /
  // nostrconnect:// URIs to the planner. Not available in Tauri (Tauri
  // owns the scheme registration via plugin-deep-link).
  if (!isTauri() && typeof navigator !== "undefined" && "registerProtocolHandler" in navigator) {
    try {
      // Spec requires %s placeholder where the URI lands. We route into
      // the location.hash so the app can pick it up below.
      navigator.registerProtocolHandler(
        "bunker",
        `${window.location.origin}${window.location.pathname}#deeplink=%s`,
      );
      navigator.registerProtocolHandler(
        "web+nostrconnect",
        `${window.location.origin}${window.location.pathname}#deeplink=%s`,
      );
    } catch (err) {
      // Some browsers refuse non-standard schemes; harmless.
      log.debug("registerProtocolHandler refused:", err);
    }

    // Pick up any URI already in the hash (we just got launched).
    try {
      const m = window.location.hash.match(/[#&]deeplink=([^&]+)/);
      if (m) {
        const uri = decodeURIComponent(m[1]);
        if (isAcceptedUri(uri)) {
          // Strip the deeplink fragment so reload doesn't re-fire it.
          window.location.hash = window.location.hash.replace(/(^|&)deeplink=[^&]+/, "");
          // Defer so subscribers can attach first.
          queueMicrotask(() => emit(uri));
        }
      }
    } catch (err) {
      log.debug("initial deeplink parse failed:", err);
    }

    // Also handle hashchange in case the user keeps the tab open and
    // taps a bunker:// link from another app on desktop.
    const onHash = () => {
      const m = window.location.hash.match(/[#&]deeplink=([^&]+)/);
      if (!m) return;
      const uri = decodeURIComponent(m[1]);
      if (isAcceptedUri(uri)) {
        window.location.hash = window.location.hash.replace(/(^|&)deeplink=[^&]+/, "");
        emit(uri);
      }
    };
    window.addEventListener("hashchange", onHash);
    cleanups.push(() => window.removeEventListener("hashchange", onHash));
  }

  // Tauri path: load the plugin lazily. It's the only viable channel for
  // Amber's Android intent (no web protocol handler can hit a Tauri app).
  if (isTauri()) {
    void (async () => {
      try {
        const mod = await import("@tauri-apps/plugin-deep-link");
        // onOpenUrl fires for every incoming deep link AND the cold-start
        // URI that launched the app, so we don't need to also call
        // getCurrent() — but we do anyway in case the listener attached
        // after the cold-start event fired.
        const off = await mod.onOpenUrl((urls: string[]) => {
          for (const u of urls) if (isAcceptedUri(u)) emit(u);
        });
        cleanups.push(() => { try { off(); } catch { /* ignore */ } });
        try {
          const current = await mod.getCurrent();
          if (Array.isArray(current)) {
            for (const u of current) if (isAcceptedUri(u)) emit(u);
          } else if (typeof current === "string" && isAcceptedUri(current)) {
            emit(current);
          }
        } catch (err) {
          log.debug("getCurrent failed (cold start):", err);
        }
      } catch (err) {
        log.warn("plugin-deep-link load failed:", err);
      }
    })();
  }

  return () => {
    while (cleanups.length > 0) {
      try { cleanups.pop()!(); } catch { /* ignore */ }
    }
    initialized = false;
  };
}
