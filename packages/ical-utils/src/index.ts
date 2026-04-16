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
