import { addDays } from "date-fns";
import type { CalendarEvent, RecurrenceRule } from "./nostr";
import { toRRule, fromRRule } from "./nostr";
import { saveFile } from "./fileSave";
import {
  escapeIcal,
  foldLine,
  buildVEvent,
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
    // VEVENT assembly is shared with the daemon's CalDAV feed via ical-utils
    // so the two feeds can't drift. `end` is our inclusive last day; buildVEvent
    // emits the exclusive DTEND RFC 5545 requires. Local date accessors because
    // all-day events are stored at local midnight.
    lines.push(...buildVEvent({
      uid: event.dTag,
      dtstamp: new Date(event.createdAt * 1000),
      allDay: event.allDay,
      start: event.start,
      end: event.end,
      summary: event.title,
      description: event.content || undefined,
      location: event.location || undefined,
      url: event.link || undefined,
      categories: event.hashtags.length > 0 ? event.hashtags : undefined,
      rrule: event.recurrence ? toRRule(event.recurrence) : undefined,
      useLocalDates: true,
    }));
  }

  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

export async function downloadIcalFile(events: CalendarEvent[], filename = "nostr-planner.ics") {
  await saveFile(exportToIcal(events), filename, "text/calendar");
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
  /** Recurrence rule parsed from an RRULE property, if present. The importer
   *  materializes individual instances from this. */
  recurrence?: RecurrenceRule;
}

/**
 * Convert wall-clock components in an IANA timezone to the corresponding UTC
 * instant. Uses the standard Intl offset-probe: format a UTC guess in the
 * target zone, measure how far the zone's wall clock is from UTC at that
 * instant, and correct. Returns null for an unknown timezone. (Off by an hour
 * only for the rare ambiguous/nonexistent local times exactly at a DST
 * transition — acceptable for import.)
 */
function zonedWallClockToUtc(
  y: number, mo: number, d: number, h: number, min: number, s: number, tz: string
): Date | null {
  try {
    const guess = Date.UTC(y, mo, d, h, min, s);
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    const parts = dtf.formatToParts(new Date(guess));
    const get = (t: string) => parseInt(parts.find((p) => p.type === t)!.value, 10);
    const zoneView = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    const offset = zoneView - guess; // how far ahead of UTC the zone is
    return new Date(guess - offset);
  } catch {
    return null; // invalid TZID
  }
}

/** Extract a `TZID=...` parameter value from a property's params string. */
function extractTzid(params: string): string | null {
  const m = params.match(/TZID=([^;:]+)/i);
  return m ? m[1] : null;
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
    const date = new Date(y, mo - 1, d);
    // Reject impossible calendar dates (e.g. Feb 31 rolls over to Mar 3).
    if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) {
      return { date: new Date(NaN), allDay: true };
    }
    return { date, allDay: true };
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
  // Reject impossible calendar dates before they silently roll over.
  const probe = new Date(y, m, d);
  if (probe.getFullYear() !== y || probe.getMonth() !== m || probe.getDate() !== d) {
    return { date: new Date(NaN), allDay: false };
  }

  if (isUtc) {
    return { date: new Date(Date.UTC(y, m, d, h, min, s)), allDay: false };
  }
  // Zoned time: convert the wall-clock from the declared TZID to a UTC instant
  // so e.g. an America/New_York event imports at the correct moment regardless
  // of the importer's own timezone.
  const tzid = extractTzid(params);
  if (tzid) {
    const zoned = zonedWallClockToUtc(y, m, d, h, min, s, tzid);
    if (zoned) return { date: zoned, allDay: false };
    // Unknown TZID — fall through to floating/local interpretation.
  }
  // Floating / local time — interpret in the importer's local timezone.
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
      // A Date(NaN) is still truthy — require a *valid* start so events with
      // an impossible/malformed DTSTART are dropped rather than emitted with
      // an invalid date.
      if (current.title && current.start && !isNaN(current.start.getTime())) {
        // Drop a non-sensical end that landed before the start (can happen
        // after the all-day exclusive→inclusive −1 conversion on a degenerate
        // single-day DTEND), so downstream span math stays well-formed.
        let end = current.end;
        if (end && end.getTime() < current.start.getTime()) end = undefined;
        events.push({
          title: current.title,
          description: current.description || "",
          location: current.location,
          link: current.link,
          start: current.start,
          end,
          allDay: current.allDay ?? false,
          hashtags: current.hashtags || [],
          recurrence: current.recurrence,
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
        // RFC 5545 DATE DTEND is exclusive; convert to our inclusive internal
        // end by subtracting a day. Timed (DATE-TIME) ends are instants and
        // need no adjustment.
        if (parsed.allDay && !isNaN(parsed.date.getTime())) {
          current.end = addDays(parsed.date, -1);
        } else {
          current.end = parsed.date;
        }
        break;
      }
      case "RRULE": {
        // Preserve recurrence so export→import round-trips (and external
        // recurring events) don't silently collapse to a single occurrence.
        const rule = fromRRule(value);
        if (rule) current.recurrence = rule;
        break;
      }
      case "CATEGORIES":
        current.hashtags = value.split(",").map((c) => unescapeIcal(c.trim()));
        break;
    }
  }

  return events;
}
