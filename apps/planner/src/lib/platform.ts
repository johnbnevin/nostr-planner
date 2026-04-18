/**
 * Returns true when running inside a Tauri native window (desktop or mobile).
 *
 * We check for the presence of the `invoke` function on `__TAURI_INTERNALS__`
 * rather than just the key's existence — this guards against browser extensions
 * injecting an empty `window.__TAURI_INTERNALS__ = {}` object to spoof the
 * Tauri environment and trick the web build into showing nsec input fields.
 */
export function isTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in window &&
    "__TAURI__" in window &&
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    typeof (window as any).__TAURI_INTERNALS__?.invoke === "function"
  );
}

/**
 * Returns true when the page is running as a standalone PWA — e.g. launched
 * from a homescreen shortcut on iOS/Android, or the Chrome "Install app"
 * window on desktop. Used to surface platform-specific login guidance since
 * browser extensions (NIP-07) are unavailable in standalone mode.
 */
export function isStandalonePWA(): boolean {
  if (typeof window === "undefined") return false;
  // iOS Safari exposes navigator.standalone; other browsers use the
  // display-mode media query. Either is sufficient.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const iosStandalone = (window.navigator as any).standalone === true;
  const displayModeStandalone =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(display-mode: standalone)").matches;
  return iosStandalone || displayModeStandalone;
}
