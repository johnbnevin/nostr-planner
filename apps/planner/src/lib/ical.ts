import type { CalendarEvent } from "./nostr";
import { toRRule } from "./nostr";
import {
  escapeIcal,
  sanitizeRRule,
  foldLine,
  formatIcalDate,
} from "@nostr-planner/ical-utils";

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

    // DTSTAMP from created_at (UTC)
    const dtstamp = formatIcalDate(new Date(event.createdAt * 1000), false);
    lines.push(`DTSTAMP:${dtstamp}`);

    if (event.allDay) {
      // All-day dates stored as local midnight — use local accessors
      lines.push(`DTSTART;VALUE=DATE:${formatIcalDate(event.start, true, true)}`);
      if (event.end) {
        lines.push(`DTEND;VALUE=DATE:${formatIcalDate(event.end, true, true)}`);
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
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } finally {
    URL.revokeObjectURL(url);
  }
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
    // YYYYMMDD — DATE type. Parse as local midnight to match how nostr.ts
    // stores all-day dates (new Date("YYYY-MM-DDT00:00:00")). All-day dates
    // represent calendar dates, not moments in time, so local time is correct.
    const y = parseInt(clean.slice(0, 4));
    const mo = parseInt(clean.slice(4, 6));
    const d = parseInt(clean.slice(6, 8));
    if (y < 1 || y > 9999 || mo < 1 || mo > 12 || d < 1 || d > 31) return { date: new Date(NaN), allDay: true };
    return { date: new Date(y, mo - 1, d), allDay: true };
  }

  // YYYYMMDDTHHmmss[Z]
  const y = parseInt(clean.slice(0, 4));
  const mo = parseInt(clean.slice(4, 6));
  const d = parseInt(clean.slice(6, 8));
  const h = parseInt(clean.slice(9, 11));
  const min = parseInt(clean.slice(11, 13));
  const s = parseInt(clean.slice(13, 15)) || 0;
  if (y < 1 || y > 9999 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || min > 59 || s > 59) {
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
