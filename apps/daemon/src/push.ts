/**
 * Push notification delivery — Web Push + FCM.
 *
 * Routes by `PushSubEntry.platform`:
 *   - "webpush": existing VAPID-signed Web Push (browsers + PWAs).
 *   - "fcm":     Firebase Cloud Messaging (Android Tauri builds).
 *
 * FCM requires a server-side `FCM_SERVER_KEY`. If it's absent, native
 * sends become no-ops with a one-time warning so the operator knows
 * native subscriptions are not being delivered.
 *
 * Apple platforms (APNs / iOS) are deliberately not supported: the
 * project's cypherpunk ethos rejects building against a closed gatekeeper
 * that controls who can ship software. Android sideloading + F-Droid
 * stay viable distribution paths; iOS does not.
 */

import webpush from "web-push";
import type { Config } from "./config.js";
import type { PushSubEntry, DigestEvent } from "./digest.js";

let fcmServerKey: string | null = null;
let warnedMissingFcm = false;

export function initWebPush(config: Config): void {
  if (!config.vapidPublicKey || !config.vapidPrivateKey) {
    console.warn("[push] VAPID keys not configured — Web Push disabled");
  } else {
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

  fcmServerKey = config.fcmServerKey || null;
  if (fcmServerKey) console.log("[push] FCM credentials configured");
}

export async function sendPushNotification(
  sub: PushSubEntry,
  event: DigestEvent
): Promise<boolean> {
  const timeStr = event.allDay ? "All day" : formatTime(event.start, sub.timezone);
  const body = event.location
    ? `${timeStr} — ${event.location}`
    : timeStr;

  const tagKey = `${event.start}\x00${event.title}\x00${event.location ?? ""}`;
  const tag = `planner-${tagKey.slice(0, 60)}`;

  switch (sub.platform) {
    case "fcm":
      return sendFcm(sub, event.title, body, tag);
    case "webpush":
    default:
      return sendWebPush(sub, event.title, body, tag);
  }
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

async function sendFcm(
  sub: PushSubEntry,
  title: string,
  body: string,
  tag: string,
): Promise<boolean> {
  if (!fcmServerKey) {
    if (!warnedMissingFcm) {
      console.warn("[push] FCM token registered but FCM_SERVER_KEY not set — skipping native Android delivery");
      warnedMissingFcm = true;
    }
    // Don't drop the subscription: the operator may wire FCM later.
    return true;
  }
  if (!sub.token) return false;
  // FCM HTTP v1 send via legacy server-key endpoint. Operators on newer
  // FCM v1 (OAuth2) should swap this for their preferred HTTP client.
  try {
    const res = await fetch("https://fcm.googleapis.com/fcm/send", {
      method: "POST",
      headers: {
        "Authorization": `key=${fcmServerKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to: sub.token,
        notification: { title, body, tag },
        data: { url: "/" },
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      // 404 / NotRegistered → token is stale, ask caller to drop it.
      if (res.status === 404 || /NotRegistered|InvalidRegistration/i.test(text)) {
        return false;
      }
      console.error("[push] fcm send failed:", res.status, text);
      return true;
    }
    return true;
  } catch (err) {
    console.error("[push] fcm send error:", err);
    return true; // transient
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
