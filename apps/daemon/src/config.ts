/**
 * Load configuration from environment variables.
 */

import { getPublicKey } from "nostr-tools/pure";
import { nip19 } from "nostr-tools";

export interface Config {
  botPrivkey: Uint8Array;
  botPubkey: string;
  relays: string[];
  vapidPublicKey: string;
  vapidPrivateKey: string;
  vapidEmail: string;
  pushCheckIntervalSecs: number;
  /** Max hours a push data snapshot can be before it's considered stale. */
  maxStaleHours: number;
  caldavPort: number;
  /** When true, trust the X-Forwarded-For header for client IP detection.
   *  Only enable if the daemon is behind a trusted reverse proxy. */
  trustProxy: boolean;
}

/**
 * Parse a required-integer environment variable with optional range validation.
 * Throws on missing value, non-integer, or out-of-range value so
 * misconfiguration fails loudly at startup rather than silently misbehaving.
 */
function parseIntEnv(
  name: string,
  def: number,
  min?: number,
  max?: number
): number {
  const raw = process.env[name];
  if (!raw) return def;
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    throw new Error(`${name} must be an integer, got "${raw}"`);
  }
  if (min !== undefined && n < min) {
    throw new Error(`${name} must be >= ${min}, got ${n}`);
  }
  if (max !== undefined && n > max) {
    throw new Error(`${name} must be <= ${max}, got ${n}`);
  }
  return n;
}

export function loadConfig(): Config {
  const nsec = process.env.BOT_NSEC;
  if (!nsec) throw new Error("BOT_NSEC environment variable is required");

  let botPrivkey: Uint8Array;
  if (nsec.startsWith("nsec")) {
    const decoded = nip19.decode(nsec);
    if (decoded.type !== "nsec") throw new Error("Invalid BOT_NSEC");
    botPrivkey = decoded.data as Uint8Array;
  } else {
    botPrivkey = new Uint8Array(Buffer.from(nsec, "hex"));
  }

  const botPubkey = getPublicKey(botPrivkey);

  return {
    botPrivkey,
    botPubkey,
    relays: process.env.RELAYS
      ? process.env.RELAYS.split(",").map((r) => r.trim()).filter((r) => {
          if (!r) return false;
          if (!r.startsWith("wss://") && !r.startsWith("ws://")) {
            console.warn(`[config] ignoring invalid relay URL (must start with wss:// or ws://): ${r}`);
            return false;
          }
          return true;
        })
      : [
          "wss://relay.damus.io",
          "wss://relay.ditto.pub",
        ],
    vapidPublicKey: process.env.VAPID_PUBLIC_KEY || "",
    vapidPrivateKey: process.env.VAPID_PRIVATE_KEY || "",
    vapidEmail: process.env.VAPID_EMAIL || "mailto:admin@example.com",
    pushCheckIntervalSecs: parseIntEnv("PUSH_CHECK_INTERVAL_SECS", 60, 1, 3600),
    maxStaleHours: parseIntEnv("MAX_STALE_HOURS", 36, 1, 720),
    caldavPort: parseIntEnv("CALDAV_PORT", 0, 0, 65535), // 0 = disabled
    trustProxy: process.env.TRUST_PROXY === "1",
  };
}
