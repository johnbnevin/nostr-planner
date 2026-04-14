/**
 * Cross-platform notification abstraction.
 *
 * - Web: uses the browser Notification API
 * - Tauri (desktop/mobile): uses @tauri-apps/plugin-notification
 */

import { isTauri } from "./platform";

let tauriNotification: typeof import("@tauri-apps/plugin-notification") | null =
  null;

/** Lazy-load Tauri notification module (only in Tauri builds). */
async function getTauriNotification() {
  if (tauriNotification) return tauriNotification;
  if (!isTauri()) return null;
  try {
    tauriNotification = await import("@tauri-apps/plugin-notification");
    return tauriNotification;
  } catch {
    return null;
  }
}

/**
 * Request notification permission on the current platform.
 * Returns true if granted.
 */
export async function requestPermission(): Promise<boolean> {
  const tauri = await getTauriNotification();
  if (tauri) {
    let granted = await tauri.isPermissionGranted();
    if (!granted) {
      const result = await tauri.requestPermission();
      granted = result === "granted";
    }
    return granted;
  }

  // Web fallback
  if (typeof Notification === "undefined") return false;
  if (Notification.permission === "granted") return true;
  const result = await Notification.requestPermission();
  return result === "granted";
}

/**
 * Check if notification permission is already granted.
 */
export async function isPermissionGranted(): Promise<boolean> {
  const tauri = await getTauriNotification();
  if (tauri) return tauri.isPermissionGranted();

  if (typeof Notification === "undefined") return false;
  return Notification.permission === "granted";
}

/**
 * Send a local notification on any platform.
 */
export async function sendNotification(opts: {
  title: string;
  body: string;
  tag?: string;
}): Promise<void> {
  const tauri = await getTauriNotification();
  if (tauri) {
    const granted = await tauri.isPermissionGranted();
    if (!granted) {
      const result = await tauri.requestPermission();
      if (result !== "granted") return;
    }
    tauri.sendNotification({ title: opts.title, body: opts.body });
    return;
  }

  // Web fallback
  if (typeof Notification === "undefined") return;
  if (Notification.permission !== "granted") {
    Notification.requestPermission();
    return;
  }
  new Notification(opts.title, {
    body: opts.body,
    icon: "/calendar.svg",
    tag: opts.tag ?? opts.title,
  });
}
