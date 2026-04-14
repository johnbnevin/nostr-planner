import type { CalendarEvent } from "./nostr";
import { toRRule } from "./nostr";

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Escape special characters in iCal property values per RFC 5545 §3.3.11.
 * Also strips bare CR characters which could be used for CRLF injection.
 */
function escapeIcal(text: string): string {
  return text
    .replace(/\r/g, "")       // strip stray CR (prevents CRLF injection)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

/**
 * Format a Date for use in iCal output.
 *
 * All-day dates are stored as UTC midnight (new Date("YYYY-MM-DD") parses
 * as UTC), so we read UTC components to avoid a day-shift for users in
 * negative UTC-offset timezones (e.g. UTC-5 would see the local date as
 * the day before if we used local getDate()).
 *
 * Timed events are emitted as UTC datetime with a trailing 'Z' per
 * RFC 5545 §3.3.5. Without 'Z' the datetime is "floating" (localtime),
 * which causes calendar apps to show the wrong hour.
 */
function formatIcalDate(date: Date, allDay: boolean): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  if (allDay) {
    return (
      `${date.getUTCFullYear()}` +
      `${pad(date.getUTCMonth() + 1)}` +
      `${pad(date.getUTCDate())}`
    );
  }
  return (
    `${date.getUTCFullYear()}` +
    `${pad(date.getUTCMonth() + 1)}` +
    `${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}` +
    `${pad(date.getUTCMinutes())}` +
    `${pad(date.getUTCSeconds())}Z`
  );
}

/**
 * Fold iCal lines at 75 octets per RFC 5545 §3.1.
 * Continuation lines begin with a single SPACE.
 * Counts UTF-8 byte length (not character count) to handle multibyte chars.
 */
function foldLine(line: string): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(line);
  if (bytes.length <= 75) return line;
  const chunks: string[] = [];
  let pos = 0;
  let isFirst = true;
  while (pos < line.length) {
    const maxBytes = isFirst ? 75 : 74; // 74 + 1 leading space = 75
    let end = pos;
    let byteCount = 0;
    while (end < line.length) {
      const charBytes = encoder.encode(line[end]).length;
      if (byteCount + charBytes > maxBytes) break;
      byteCount += charBytes;
      end++;
    }
    if (end === pos) end = pos + 1; // always advance at least one char
    if (isFirst) {
      chunks.push(line.slice(pos, end));
      isFirst = false;
    } else {
      chunks.push(" " + line.slice(pos, end));
    }
    pos = end;
  }
  return chunks.join("\r\n");
}

/**
 * Validate and sanitize an RRULE string before embedding in iCal output.
 * Strips any CRLF sequences (injection guard) and verifies the value
 * starts with a recognized FREQ= parameter.
 * Returns null if the value is unsafe or malformed.
 */
function sanitizeRRule(rrule: string): string | null {
  // Strip any embedded CR/LF that could inject additional iCal properties
  const cleaned = rrule.replace(/[\r\n]/g, "");
  // Must start with FREQ= to be a valid RRULE
  if (!/^FREQ=(YEARLY|MONTHLY|WEEKLY|DAILY|HOURLY|MINUTELY|SECONDLY)/i.test(cleaned)) {
    return null;
  }
  return cleaned;
}

// ── Export ─────────────────────────────────────────────────────────────

export function exportToIcal(events: CalendarEvent[], calendarName = "Planner"): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    foldLine(`PRODID:-//Planner//EN`),
    foldLine(`X-WR-CALNAME:${escapeIcal(calendarName)}`),
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
  ];

  for (const event of events) {
    lines.push("BEGIN:VEVENT");
    lines.push(foldLine(`UID:${event.dTag}@nostr-planner`));

    const pad = (n: number) => String(n).padStart(2, "0");
    const now = new Date(event.createdAt * 1000);
    const dtstamp = (
      `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
      `T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`
    );
    lines.push(`DTSTAMP:${dtstamp}`);

    if (event.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${formatIcalDate(event.start, true)}`);
      if (event.end) {
        lines.push(`DTEND;VALUE=DATE:${formatIcalDate(event.end, true)}`);
      }
    } else {
      lines.push(`DTSTART:${formatIcalDate(event.start, false)}`);
      if (event.end) {
        lines.push(`DTEND:${formatIcalDate(event.end, false)}`);
      }
    }

    lines.push(foldLine(`SUMMARY:${escapeIcal(event.title)}`));

    if (event.content) {
      lines.push(foldLine(`DESCRIPTION:${escapeIcal(event.content)}`));
    }
    if (event.location) {
      lines.push(foldLine(`LOCATION:${escapeIcal(event.location)}`));
    }
    if (event.link && /^https?:\/\//i.test(event.link)) {
      // Only include http(s) URLs; strip bare CR/LF to prevent injection
      lines.push(foldLine(`URL:${event.link.replace(/[\r\n]/g, "")}`));
    }
    if (event.hashtags.length > 0) {
      lines.push(foldLine(`CATEGORIES:${event.hashtags.map(escapeIcal).join(",")}`));
    }
    if (event.recurrence) {
      const rrule = sanitizeRRule(toRRule(event.recurrence));
      if (rrule) lines.push(foldLine(`RRULE:${rrule}`));
    }

    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

export function downloadIcalFile(events: CalendarEvent[], filename = "nostr-planner.ics") {
  const ical = exportToIcal(events);
  const blob = new Blob([ical], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Import (parse) ─────────────────────────────────────────────────────

export interface ParsedIcalEvent {
  title: string;
  description: string;
  location?: string;
  link?: string;
  start: Date;
  end?: Date;
  allDay: boolean;
  hashtags: string[];
}

function parseIcalDate(value: string, params: string): { date: Date; allDay: boolean } {
  const allDay = params.includes("VALUE=DATE") && !params.includes("VALUE=DATE-TIME");

  // Strip trailing Z for component parsing; we track whether it was present
  const isUtc = value.endsWith("Z");
  const clean = value.replace(/Z$/, "");

  if (allDay || clean.length === 8) {
    // YYYYMMDD — DATE type, no timezone, interpret as UTC midnight so the date
    // is stable across all client timezones (consistent with how we export them).
    const y = parseInt(clean.slice(0, 4));
    const mo = parseInt(clean.slice(4, 6));
    const d = parseInt(clean.slice(6, 8));
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return { date: new Date(NaN), allDay: true };
    return { date: new Date(Date.UTC(y, mo - 1, d)), allDay: true };
  }

  // YYYYMMDDTHHmmss[Z]
  const y = parseInt(clean.slice(0, 4));
  const mo = parseInt(clean.slice(4, 6));
  const d = parseInt(clean.slice(6, 8));
  const h = parseInt(clean.slice(9, 11));
  const min = parseInt(clean.slice(11, 13));
  const s = parseInt(clean.slice(13, 15)) || 0;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || min > 59 || s > 59) {
    return { date: new Date(NaN), allDay: false };
  }
  const m = mo - 1;

  if (isUtc) {
    return { date: new Date(Date.UTC(y, m, d, h, min, s)), allDay: false };
  }
  // Floating / local time — use local timezone (TZID handling not implemented)
  return { date: new Date(y, m, d, h, min, s), allDay: false };
}

function unescapeIcal(text: string): string {
  return text
    .replace(/\\n/g, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

export function parseIcalFile(icalText: string): ParsedIcalEvent[] {
  const events: ParsedIcalEvent[] = [];
  // Unfold continuation lines (lines starting with space or tab per RFC 5545 §3.1)
  const unfolded = icalText.replace(/\r?\n[ \t]/g, "");
  const lines = unfolded.split(/\r?\n/);

  let inEvent = false;
  let current: Partial<ParsedIcalEvent> = {};

  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      inEvent = true;
      current = { hashtags: [] };
      continue;
    }

    if (line === "END:VEVENT") {
      inEvent = false;
      if (current.title && current.start) {
        events.push({
          title: current.title,
          description: current.description || "",
          location: current.location,
          link: current.link,
          start: current.start,
          end: current.end,
          allDay: current.allDay ?? false,
          hashtags: current.hashtags || [],
        });
      }
      continue;
    }

    if (!inEvent) continue;

    // Split property;params:value
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    const propPart = line.slice(0, colonIdx);
    const value = line.slice(colonIdx + 1);
    const semiIdx = propPart.indexOf(";");
    const prop = semiIdx === -1 ? propPart : propPart.slice(0, semiIdx);
    const params = semiIdx === -1 ? "" : propPart.slice(semiIdx);

    switch (prop) {
      case "SUMMARY":
        current.title = unescapeIcal(value);
        break;
      case "DESCRIPTION":
        current.description = unescapeIcal(value);
        break;
      case "LOCATION":
        current.location = unescapeIcal(value);
        break;
      case "URL":
        // Only allow http(s) URLs to prevent javascript: injection
        if (/^https?:\/\//i.test(value)) {
          current.link = value;
        }
        break;
      case "DTSTART": {
        const parsed = parseIcalDate(value, params);
        current.start = parsed.date;
        current.allDay = parsed.allDay;
        break;
      }
      case "DTEND": {
        const parsed = parseIcalDate(value, params);
        current.end = parsed.date;
        break;
      }
      case "CATEGORIES":
        current.hashtags = value.split(",").map((c) => unescapeIcal(c.trim()));
        break;
    }
  }

  return events;
}
