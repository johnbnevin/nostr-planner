import { describe, it, expect } from "vitest";
import { exportToIcal, parseIcalFile } from "./ical";
import type { CalendarEvent } from "./nostr";

function baseEvent(over: Partial<CalendarEvent>): CalendarEvent {
  return {
    id: "id",
    pubkey: "pk",
    kind: 31922,
    dTag: "d1",
    title: "Trip",
    content: "",
    start: new Date(2026, 5, 1),
    end: undefined,
    allDay: true,
    hashtags: [],
    calendarRefs: [],
    tags: [],
    createdAt: 1700000000,
    ...over,
  };
}

// ── All-day DTEND exclusivity round-trip ──────────────────────────────

describe("all-day DTEND exclusivity", () => {
  it("exports inclusive end as exclusive (+1 day) DTEND", () => {
    // Mon Jun 1 → Wed Jun 3 inclusive (3-day trip).
    const ics = exportToIcal([baseEvent({ start: new Date(2026, 5, 1), end: new Date(2026, 5, 3) })]);
    expect(ics).toContain("DTSTART;VALUE=DATE:20260601");
    // Exclusive DTEND = day after the last covered day = Jun 4.
    expect(ics).toContain("DTEND;VALUE=DATE:20260604");
  });

  it("round-trips a multi-day all-day event back to the same inclusive span", () => {
    const ics = exportToIcal([baseEvent({ start: new Date(2026, 5, 1), end: new Date(2026, 5, 3) })]);
    const [parsed] = parseIcalFile(ics);
    expect(parsed.allDay).toBe(true);
    expect(parsed.start.getFullYear()).toBe(2026);
    expect(parsed.start.getMonth()).toBe(5);
    expect(parsed.start.getDate()).toBe(1);
    // Inclusive end restored to Jun 3 (not Jun 4).
    expect(parsed.end?.getDate()).toBe(3);
  });

  it("treats a single-day exclusive DTEND as no multi-day end", () => {
    // External single-day all-day event: DTSTART Jun 1, DTEND Jun 2 (exclusive).
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:x@y",
      "DTSTART;VALUE=DATE:20260601",
      "DTEND;VALUE=DATE:20260602",
      "SUMMARY:One day",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const [parsed] = parseIcalFile(ics);
    // −1 day → Jun 1 == start; not a multi-day span.
    expect(parsed.end?.getDate()).toBe(1);
  });
});

// ── TZID import ───────────────────────────────────────────────────────

describe("TZID import", () => {
  it("converts a zoned wall-clock to the correct UTC instant", () => {
    // 2026-06-01 09:00 America/New_York is EDT (UTC-4) → 13:00 UTC.
    const ics = [
      "BEGIN:VEVENT",
      "UID:tz@y",
      "DTSTART;TZID=America/New_York:20260601T090000",
      "SUMMARY:Zoned",
      "END:VEVENT",
    ].join("\r\n");
    const [parsed] = parseIcalFile(ics);
    expect(parsed.allDay).toBe(false);
    expect(parsed.start.toISOString()).toBe("2026-06-01T13:00:00.000Z");
  });

  it("parses a UTC (Z) datetime unchanged", () => {
    const ics = [
      "BEGIN:VEVENT",
      "UID:z@y",
      "DTSTART:20260601T090000Z",
      "SUMMARY:Utc",
      "END:VEVENT",
    ].join("\r\n");
    const [parsed] = parseIcalFile(ics);
    expect(parsed.start.toISOString()).toBe("2026-06-01T09:00:00.000Z");
  });
});

// ── Impossible dates ──────────────────────────────────────────────────

describe("impossible date rejection", () => {
  it("drops an event with an impossible DTSTART (Feb 31)", () => {
    const ics = [
      "BEGIN:VEVENT",
      "UID:bad@y",
      "DTSTART;VALUE=DATE:20260231",
      "SUMMARY:Impossible",
      "END:VEVENT",
    ].join("\r\n");
    // Invalid start → NaN date → event has no usable start → not emitted.
    const parsed = parseIcalFile(ics);
    expect(parsed.length).toBe(0);
  });
});

// ── RRULE import ──────────────────────────────────────────────────────

describe("RRULE import", () => {
  it("parses a recurrence rule from RRULE", () => {
    const ics = [
      "BEGIN:VEVENT",
      "UID:r@y",
      "DTSTART;VALUE=DATE:20260601",
      "RRULE:FREQ=WEEKLY;COUNT=4",
      "SUMMARY:Weekly",
      "END:VEVENT",
    ].join("\r\n");
    const [parsed] = parseIcalFile(ics);
    expect(parsed.recurrence).toEqual({ freq: "weekly", count: 4 });
  });
});
