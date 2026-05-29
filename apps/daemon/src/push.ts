/**
 * Push notification delivery — Web Push (VAPID) only.
 *
 * Web/PWA reminders use the W3C Web Push standard. There is intentionally no
 * FCM/APNs path:
 *   - Native (Tauri desktop/mobile, incl. GrapheneOS) does not use server push
 *     at all — it schedules OS-level *local* notifications on-device, which
 *     need no server and no Google Play Services.
 *   - FCM would impose a Google dependency that the project's ethos rejects and
 *     that doesn't work on de-Googled devices anyway.
 *   - Apple platforms (APNs / iOS) are likewise unsupported: building against a
 *     closed gatekeeper conflicts with the project's distribution stance.
 */

import webpush from "web-push";
import type { Config } from "./config.js";
import { pushDedupKey, type PushSubEntry, type DigestEvent } from "./digest.js";

export function initWebPush(config: Config): void {
  if (!config.vapidPublicKey || !config.vapidPrivateKey) {
    console.warn("[push] VAPID keys not configured — Web Push disabled");
    return;
  }
  try {
    webpush.setVapidDetails(
      config.vapidEmail,
      config.vapidPublicKey,
      config.vapidPrivateKey
    );
    console.log("[push] VAPID configured");
  } catch (err) {
    throw new Error(
      `[push] Invalid VAPID keys — check format (base64url). Details: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export async function sendPushNotification(
  sub: PushSubEntry,
  event: DigestEvent
): Promise<boolean> {
  const timeStr = event.allDay ? "All day" : formatTime(event.start, sub.timezone);
  const body = event.location
    ? `${timeStr} — ${event.location}`
    : timeStr;

  const tag = `planner-${pushDedupKey(event).slice(0, 60)}`;
  return sendWebPush(sub, event.title, body, tag);
}

async function sendWebPush(
  sub: PushSubEntry,
  title: string,
  body: string,
  tag: string,
): Promise<boolean> {
  const payload = JSON.stringify({ title, body, tag, url: "/" });
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: sub.keys },
      payload,
      { TTL: 3600 }
    );
    return true;
  } catch (err: unknown) {
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (statusCode === 410 || statusCode === 404) {
      // Subscription expired or invalid
      return false;
    }
    console.error("[push] webpush send failed:", err);
    return true; // don't remove sub for transient errors
  }
}

function formatTime(isoStr: string, timezone: string): string {
  try {
    const d = new Date(isoStr);
    return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: timezone });
  } catch {
    return isoStr;
  }
}
