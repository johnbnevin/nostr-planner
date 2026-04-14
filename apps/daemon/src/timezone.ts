/**
 * Timezone utilities using Intl.DateTimeFormat.
 *
 * Avoids the "locale-string hack" (new Date(new Date().toLocaleString("en-US", { timeZone })))
 * which is V8-specific and not spec-guaranteed. Intl.DateTimeFormat.formatToParts() is
 * part of the ECMAScript Internationalization API and works correctly on all engines.
 */

/**
 * Get date/time parts for the current moment in a specific IANA timezone.
 * Returns year/month/day/hour and a YYYY-MM-DD dateKey for comparisons.
 */
export function getDatePartsInZone(timezone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  dateKey: string;
} {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(new Date()).map(p => [p.type, p.value])
  );
  const year = parseInt(parts.year);
  const month = parseInt(parts.month);
  const day = parseInt(parts.day);
  const hour = parseInt(parts.hour) % 24; // h23 gives 0-23, guard against "24"
  if (isNaN(year) || isNaN(month) || isNaN(day) || isNaN(hour)) {
    throw new Error(`Failed to parse date parts for timezone "${timezone}"`);
  }
  return {
    year, month, day, hour,
    dateKey: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  };
}

/**
 * Get the UTC timestamp (ms) for midnight on a given date in a specific IANA timezone.
 *
 * Strategy: sample UTC noon on that date, measure the UTC↔local offset, then subtract
 * it from UTC midnight to find when midnight occurs locally.  Using noon as the probe
 * avoids DST ambiguity that can occur right around midnight itself.
 *
 * Example: "2026-04-04" + "America/New_York" (UTC-4) → UTC 2026-04-04 04:00:00.000Z
 */
export function getMidnightInZone(dateStr: string, timezone: string): number {
  const [year, month, day] = dateStr.split("-").map(Number);

  // Probe at UTC noon to avoid DST ambiguity near midnight
  const utcNoon = Date.UTC(year, month - 1, day, 12, 0, 0);

  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(new Date(utcNoon)).map(p => [p.type, p.value])
  );
  const localHour = parseInt(parts.hour) % 24;
  const localMin = parseInt(parts.minute);
  if (isNaN(localHour) || isNaN(localMin)) {
    throw new Error(`Failed to parse time parts for timezone "${timezone}"`);
  }

  // offsetMs = how many ms ahead local time is vs UTC at this moment
  // (positive = east of UTC, negative = west)
  const offsetMs = (localHour * 60 + localMin - 12 * 60) * 60_000;

  // UTC midnight for local midnight = Date.UTC(y,m-1,d,0,0,0) - offsetMs
  return Date.UTC(year, month - 1, day) - offsetMs;
}
