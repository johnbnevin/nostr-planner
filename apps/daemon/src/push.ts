/**
 * Web Push notification sending.
 */

import webpush from "web-push";
import type { Config } from "./config.js";
import type { PushSubEntry, DigestEvent } from "./digest.js";

export function initWebPush(config: Config): void {
  if (!config.vapidPublicKey || !config.vapidPrivateKey) {
    console.warn("[push] VAPID keys not configured — push notifications disabled");
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

  // Use null-byte-separated key (same as digest.ts dedup) for stable tag identity.
  // Truncate to keep the Web Push payload compact.
  const tagKey = `${event.start}\x00${event.title}\x00${event.location ?? ""}`;
  const tag = `planner-${tagKey.slice(0, 60)}`;

  const payload = JSON.stringify({
    title: event.title,
    body,
    tag,
    url: "/",
  });

  try {
    await webpush.sendNotification(
      {
        endpoint: sub.endpoint,
        keys: sub.keys,
      },
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
    console.error("[push] send failed:", err);
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
