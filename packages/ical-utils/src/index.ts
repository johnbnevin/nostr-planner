/**
 * Shared iCal/RFC 5545 utilities.
 *
 * Used by both the planner app (ical.ts export/import) and the daemon
 * (caldav.ts feed generation). Keeping these in one place ensures both
 * codebases produce identical iCal output and apply identical security
 * sanitisation rules.
 *
 * @module ical-utils
 */

/**
 * Escape special characters in iCal property values per RFC 5545 section 3.3.11.
 * Also strips bare CR characters which could be used for CRLF injection.
 */
export function escapeIcal(text: string): string {
  return text
    .replace(/\r/g, "")       // strip stray CR (prevents CRLF injection)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

/**
 * Validate and sanitize an RRULE string before embedding in iCal output.
 *
 * Strips any CRLF sequences (injection guard), verifies the value starts with
 * a recognized FREQ= parameter, and ensures the remainder contains only safe
 * RRULE characters (letters, digits, =, comma, plus, hyphen, semicolon).
 * Returns null if the value is unsafe or malformed.
 */
export function sanitizeRRule(rrule: string): string | null {
  const cleaned = rrule.replace(/[\r\n]/g, "");
  if (!/^FREQ=(YEARLY|MONTHLY|WEEKLY|DAILY|HOURLY|MINUTELY|SECONDLY)(;[A-Z0-9=,+\-]+)*$/i.test(cleaned)) {
    return null;
  }
  return cleaned;
}

/**
 * Fold iCal lines at 75 octets per RFC 5545 section 3.1.
 * Continuation lines begin with a single SPACE.
 *
 * Uses byte-level counting to correctly handle multibyte UTF-8 characters
 * (e.g. emoji in event titles). The `encode` function parameter allows
 * both browser (TextEncoder) and Node.js (Buffer) environments.
 *
 * @param line - The unfolded iCal line.
 * @param encode - A function returning byte length of a string. Defaults to TextEncoder.
 */
export function foldLine(
  line: string,
  encode?: (s: string) => number
): string {
  const byteLen = encode ?? ((s: string) => new TextEncoder().encode(s).length);
  if (byteLen(line) <= 75) return line;

  const chunks: string[] = [];
  let pos = 0;
  let isFirst = true;

  while (pos < line.length) {
    const maxBytes = isFirst ? 75 : 74; // 74 + 1 leading space = 75
    let end = pos;
    let byteCount = 0;
    while (end < line.length) {
      const charBytes = byteLen(line[end]);
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
 * Format a UTC Date as an iCal date or datetime string.
 *
 * - All-day: YYYYMMDD (DATE value, no time component)
 * - Timed: YYYYMMDDTHHmmssZ (UTC datetime per RFC 5545 section 3.3.5)
 *
 * For all-day dates, uses the provided accessor functions to read date parts.
 * This allows the caller to choose UTC vs local accessors depending on context:
 * - Export from parsed CalendarEvent (local midnight) -> use local accessors
 * - Export from raw unix timestamp (daemon CalDAV) -> use UTC accessors
 */
export function formatIcalDate(
  date: Date,
  allDay: boolean,
  useLocal = false
): string {
  const pad = (n: number) => String(n).padStart(2, "0");

  if (allDay) {
    const y = useLocal ? date.getFullYear() : date.getUTCFullYear();
    const m = useLocal ? date.getMonth() + 1 : date.getUTCMonth() + 1;
    const d = useLocal ? date.getDate() : date.getUTCDate();
    return `${y}${pad(m)}${pad(d)}`;
  }

  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

/** Return calendar-day + 1, DST-safe, in local or UTC space. Used to convert
 *  our inclusive internal all-day `end` to the exclusive DATE DTEND RFC 5545
 *  mandates. Adding a fixed 24h would be wrong on DST-length days. */
function addOneCalendarDay(d: Date, useLocal: boolean): Date {
  return useLocal
    ? new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)
    : new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
}

/** Normalized input for {@link buildVEvent}. `end` is the INCLUSIVE last day
 *  for all-day events (our internal convention) — buildVEvent emits the
 *  exclusive DTEND that RFC 5545 requires. */
export interface VEventInput {
  uid: string;
  dtstamp: Date;
  allDay: boolean;
  start: Date;
  end?: Date;
  summary: string;
  description?: string;
  location?: string;
  url?: string;
  categories?: string[];
  /** Raw RRULE string; sanitized (and dropped if unsafe) before emission. */
  rrule?: string;
  /** Read all-day date parts in local time (planner export) vs UTC (daemon). */
  useLocalDates?: boolean;
}

/**
 * Build the `BEGIN:VEVENT … END:VEVENT` line block for one event.
 *
 * Single source of truth shared by the planner's iCal export and the daemon's
 * CalDAV feed so the two can't drift (UID escaping, DTEND exclusivity, URL
 * sanitisation, folding). Every text value is escaped per RFC 5545; the URL
 * is restricted to http(s) and escaped (preventing both scheme- and
 * property-injection).
 *
 * @param encode - byte-length function for folding (TextEncoder in browser,
 *   Buffer.byteLength in Node). Defaults to TextEncoder via foldLine.
 */
export function buildVEvent(ev: VEventInput, encode?: (s: string) => number): string[] {
  const fold = (line: string) => foldLine(line, encode);
  const lines: string[] = ["BEGIN:VEVENT"];
  lines.push(fold(`UID:${escapeIcal(ev.uid)}@nostr-planner`));
  lines.push(`DTSTAMP:${formatIcalDate(ev.dtstamp, false)}`);

  if (ev.allDay) {
    lines.push(`DTSTART;VALUE=DATE:${formatIcalDate(ev.start, true, ev.useLocalDates)}`);
    if (ev.end) {
      const exclusive = addOneCalendarDay(ev.end, !!ev.useLocalDates);
      lines.push(`DTEND;VALUE=DATE:${formatIcalDate(exclusive, true, ev.useLocalDates)}`);
    }
  } else {
    lines.push(`DTSTART:${formatIcalDate(ev.start, false)}`);
    if (ev.end) lines.push(`DTEND:${formatIcalDate(ev.end, false)}`);
  }

  lines.push(fold(`SUMMARY:${escapeIcal(ev.summary)}`));
  if (ev.description) lines.push(fold(`DESCRIPTION:${escapeIcal(ev.description)}`));
  if (ev.location) lines.push(fold(`LOCATION:${escapeIcal(ev.location)}`));
  if (ev.url && /^https?:\/\//i.test(ev.url)) {
    // escapeIcal (not just CR/LF strip) so semicolons/commas/backslashes in
    // the URL can't smuggle parameters into the property value.
    lines.push(fold(`URL:${escapeIcal(ev.url)}`));
  }
  if (ev.categories && ev.categories.length > 0) {
    lines.push(fold(`CATEGORIES:${ev.categories.map(escapeIcal).join(",")}`));
  }
  if (ev.rrule) {
    const r = sanitizeRRule(ev.rrule);
    if (r) lines.push(fold(`RRULE:${r}`));
  }

  lines.push("END:VEVENT");
  return lines;
}
