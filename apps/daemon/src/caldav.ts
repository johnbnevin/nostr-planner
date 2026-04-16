/**
 * Read-only CalDAV/iCal feed server.
 *
 * Serves a user's public Nostr calendar events as an iCal feed
 * that Google Calendar, Apple Calendar, and Outlook can subscribe to.
 *
 * URL pattern: http://localhost:{port}/cal/{npub}.ics
 *
 * Only serves PUBLIC calendar events (kinds 31922, 31923).
 * Private (encrypted) events are never exposed.
 */

import { createServer, type Server, type IncomingMessage } from "node:http";
import { nip19 } from "nostr-tools";
import { verifyEvent } from "nostr-tools/pure";
import type { NPool } from "@nostrify/nostrify";
import type { Config } from "./config.js";
import {
  escapeIcal,
  sanitizeRRule,
  foldLine,
  formatIcalDate,
} from "@nostr-planner/ical-utils";

const KIND_DATE_EVENT = 31922;
const KIND_TIME_EVENT = 31923;

/** Node.js byte-length function for foldLine (avoids TextEncoder in Node). */
const nodeByteLen = (s: string) => Buffer.byteLength(s, "utf-8");

/** Convenience: fold an iCal line using Node.js Buffer for byte counting. */
const fold = (line: string) => foldLine(line, nodeByteLen);

async function buildIcalFeed(pool: NPool, pubkey: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const raw = await pool.query(
      [{ kinds: [KIND_DATE_EVENT, KIND_TIME_EVENT], authors: [pubkey], limit: 5000 }],
      { signal: controller.signal }
    );

    // Verify Schnorr signatures to prevent malicious relay injection
    const events = raw.filter((e) => {
      try {
        return verifyEvent(e as Parameters<typeof verifyEvent>[0]);
      } catch {
        console.warn("[caldav] invalid signature, dropping event", e.id?.slice(0, 8));
        return false;
      }
    });

    const lines: string[] = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Nostr Planner//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
    ];

    for (const event of events) {
      const dTag = event.tags.find((t) => t[0] === "d")?.[1];
      const title = event.tags.find((t) => t[0] === "title")?.[1] || "Untitled";
      const startRaw = event.tags.find((t) => t[0] === "start")?.[1];
      const endRaw = event.tags.find((t) => t[0] === "end")?.[1];
      const location = event.tags.find((t) => t[0] === "location")?.[1];
      const link = event.tags.find((t) => t[0] === "r")?.[1];
      const rruleRaw = event.tags.find((t) => t[0] === "rrule")?.[1];
      const hashtags = event.tags.filter((t) => t[0] === "t" && typeof t[1] === "string").map((t) => t[1]);
      if (!dTag || !startRaw) continue;

      const allDay = event.kind === KIND_DATE_EVENT;

      lines.push("BEGIN:VEVENT");
      lines.push(fold(`UID:${escapeIcal(dTag)}@nostr-planner`));
      lines.push(fold(`DTSTAMP:${formatIcalDate(new Date(event.created_at * 1000), false)}`));

      if (allDay) {
        lines.push(fold(`DTSTART;VALUE=DATE:${startRaw.replace(/-/g, "")}`));
        if (endRaw) lines.push(fold(`DTEND;VALUE=DATE:${endRaw.replace(/-/g, "")}`));
      } else {
        const startSec = parseInt(startRaw, 10);
        if (isNaN(startSec)) continue;
        lines.push(fold(`DTSTART:${formatIcalDate(new Date(startSec * 1000), false)}`));
        if (endRaw) {
          const endSec = parseInt(endRaw, 10);
          if (!isNaN(endSec)) lines.push(fold(`DTEND:${formatIcalDate(new Date(endSec * 1000), false)}`));
        }
      }

      lines.push(fold(`SUMMARY:${escapeIcal(title)}`));
      if (event.content) lines.push(fold(`DESCRIPTION:${escapeIcal(event.content)}`));
      if (location) lines.push(fold(`LOCATION:${escapeIcal(location)}`));
      if (link && /^https?:\/\//i.test(link)) {
        lines.push(fold(`URL:${link.replace(/[\r\n]/g, "")}`));
      }
      if (hashtags.length > 0) {
        lines.push(fold(`CATEGORIES:${hashtags.map(escapeIcal).join(",")}`));
      }
      if (rruleRaw) {
        const rrule = sanitizeRRule(rruleRaw);
        if (rrule) lines.push(fold(`RRULE:${rrule}`));
      }

      lines.push("END:VEVENT");
    }

    lines.push("END:VCALENDAR");
    return lines.join("\r\n");
  } finally {
    clearTimeout(timer);
  }
}

// ── Size-bounded in-memory rate limiter ───────────────────────────────
// Allows at most 1 request per (IP + npub) per 5 minutes to prevent relay
// hammering and DoS via the feed endpoint.
//
// The map is bounded to MAX_RL_ENTRIES to prevent unbounded memory growth
// under adversarial IP rotation. Map preserves insertion order, so evicting
// the first entry (keys().next().value) always removes the oldest entry —
// a minimal O(1) LRU approximation without any extra data structures.

const rateLimitMap = new Map<string, number>();
const RATE_LIMIT_MS = 5 * 60_000; // 5 minutes
const MAX_RL_ENTRIES = 10_000;

// Periodically evict expired entries (belt-and-suspenders alongside size cap).
setInterval(() => {
  const now = Date.now();
  for (const [k, ts] of rateLimitMap) {
    if (now - ts > RATE_LIMIT_MS) rateLimitMap.delete(k);
  }
}, 5 * 60_000);

function isRateLimited(ip: string, npub: string): boolean {
  const key = `${ip}:${npub}`;
  const last = rateLimitMap.get(key);
  const now = Date.now();
  if (last && now - last < RATE_LIMIT_MS) return true;
  // Evict oldest entry when at capacity to keep memory bounded
  if (rateLimitMap.size >= MAX_RL_ENTRIES) {
    const oldest = rateLimitMap.keys().next().value;
    if (oldest !== undefined) rateLimitMap.delete(oldest);
  }
  // Delete + re-insert to move key to end of insertion order (LRU refresh)
  rateLimitMap.delete(key);
  rateLimitMap.set(key, now);
  return false;
}

/**
 * Extract the client IP address from the request.
 * Only reads X-Forwarded-For if trustProxy is enabled — otherwise an
 * attacker could spoof the header to bypass rate limiting.
 */
function getClientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded === "string") return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

export function startCaldavServer(config: Config, pool: NPool): Server | null {
  if (!config.caldavPort) return null;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${config.caldavPort}`);
    const match = url.pathname.match(/^\/cal\/([a-z0-9]+)\.ics$/);

    if (!match) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found. Use /cal/{npub}.ics");
      return;
    }

    const npubOrHex = match[1];
    let pubkey: string;
    try {
      if (npubOrHex.startsWith("npub")) {
        const decoded = nip19.decode(npubOrHex);
        if (decoded.type !== "npub") throw new Error("Not an npub");
        pubkey = decoded.data as string;
      } else if (/^[0-9a-f]{64}$/.test(npubOrHex)) {
        pubkey = npubOrHex;
      } else {
        throw new Error("Invalid identifier");
      }
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Invalid pubkey format");
      return;
    }

    const clientIp = getClientIp(req, config.trustProxy);
    // Always rate-limit on the normalized hex pubkey to prevent bypass
    // via different representations (npub vs hex) of the same key.
    if (isRateLimited(clientIp, pubkey)) {
      res.writeHead(429, { "Content-Type": "text/plain", "Retry-After": "300" });
      res.end("Too many requests. Try again in 5 minutes.");
      return;
    }

    try {
      const ical = await buildIcalFeed(pool, pubkey);
      res.writeHead(200, {
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": "inline",
        "Cache-Control": "public, max-age=300",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Content-Security-Policy": "default-src 'none'",
      });
      res.end(ical);
    } catch (err) {
      console.error("[caldav] feed generation failed:", err);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal server error");
    }
  });

  server.listen(config.caldavPort, () => {
    console.log(`[caldav] iCal feed server on http://localhost:${config.caldavPort}/cal/{npub}.ics`);
  });

  return server;
}
