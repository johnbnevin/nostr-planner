/**
 * Unit tests for nostr.ts — event parsing, RRULE handling, collection parsing.
 */
import { describe, it, expect } from "vitest";
import {
  fromRRule,
  toRRule,
  parseCalendarEvent,
  parseCalendarCollection,
  advanceDate,
  generateDTag,
  KIND_DATE_EVENT,
  KIND_TIME_EVENT,
} from "./nostr";

// ── RRULE parsing ──────────────────────────────────────────────────────

describe("fromRRule", () => {
  it("parses a basic weekly rule", () => {
    const rule = fromRRule("FREQ=WEEKLY;COUNT=10");
    expect(rule).toEqual({ freq: "weekly", count: 10 });
  });

  it("parses case-insensitively", () => {
    const rule = fromRRule("freq=daily;count=5");
    expect(rule).toEqual({ freq: "daily", count: 5 });
  });

  it("defaults COUNT to 52 when missing", () => {
    const rule = fromRRule("FREQ=MONTHLY");
    expect(rule).toEqual({ freq: "monthly", count: 52 });
  });

  it("returns null for unknown FREQ", () => {
    expect(fromRRule("FREQ=BIWEEKLY;COUNT=3")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(fromRRule("")).toBeNull();
  });

  it("caps COUNT at 365", () => {
    const rule = fromRRule("FREQ=DAILY;COUNT=999999");
    expect(rule).toEqual({ freq: "daily", count: 365 });
  });

  it("floors COUNT at 1", () => {
    const rule = fromRRule("FREQ=DAILY;COUNT=0");
    // 0 is falsy, fallback to 52, clamped
    expect(rule!.count).toBeGreaterThanOrEqual(1);
  });

  it("handles NaN COUNT gracefully", () => {
    const rule = fromRRule("FREQ=WEEKLY;COUNT=abc");
    // parseInt("abc") = NaN, fallback to 52
    expect(rule!.count).toBe(52);
  });
});

describe("toRRule", () => {
  it("round-trips through fromRRule", () => {
    const original = { freq: "weekly" as const, count: 10 };
    const rrule = toRRule(original);
    const parsed = fromRRule(rrule);
    expect(parsed).toEqual(original);
  });
});

// ── parseCalendarEvent ─────────────────────────────────────────────────

describe("parseCalendarEvent", () => {
  const baseDateEvent = {
    id: "abc123",
    pubkey: "a".repeat(64),
    kind: KIND_DATE_EVENT,
    tags: [
      ["d", "test-dtag"],
      ["title", "Team Lunch"],
      ["start", "2025-06-15"],
    ],
    content: "",
    created_at: 1718000000,
  };

  it("parses a valid date event", () => {
    const result = parseCalendarEvent(baseDateEvent);
    expect(result).not.toBeNull();
    expect(result!.title).toBe("Team Lunch");
    expect(result!.allDay).toBe(true);
    expect(result!.start.getFullYear()).toBe(2025);
    expect(result!.start.getMonth()).toBe(5); // June = 5
    expect(result!.start.getDate()).toBe(15);
  });

  it("returns null when d tag is missing", () => {
    const event = {
      ...baseDateEvent,
      tags: [["title", "No DTag"], ["start", "2025-06-15"]],
    };
    expect(parseCalendarEvent(event)).toBeNull();
  });

  it("returns null when start tag is missing", () => {
    const event = {
      ...baseDateEvent,
      tags: [["d", "test"], ["title", "No Start"]],
    };
    expect(parseCalendarEvent(event)).toBeNull();
  });

  it("parses a valid time event", () => {
    const unixTime = Math.floor(new Date("2025-06-15T14:30:00Z").getTime() / 1000);
    const event = {
      id: "def456",
      pubkey: "b".repeat(64),
      kind: KIND_TIME_EVENT,
      tags: [
        ["d", "time-test"],
        ["title", "Meeting"],
        ["start", String(unixTime)],
      ],
      content: "",
      created_at: 1718000000,
    };
    const result = parseCalendarEvent(event);
    expect(result).not.toBeNull();
    expect(result!.allDay).toBe(false);
    expect(result!.start.getTime()).toBe(unixTime * 1000);
  });

  it("rejects time events with negative unix timestamp", () => {
    const event = {
      ...baseDateEvent,
      kind: KIND_TIME_EVENT,
      tags: [
        ["d", "neg-test"],
        ["title", "Bad Time"],
        ["start", "-1"],
      ],
    };
    expect(parseCalendarEvent(event)).toBeNull();
  });

  it("sanitizes overly long titles", () => {
    const event = {
      ...baseDateEvent,
      tags: [
        ["d", "long-title"],
        ["title", "x".repeat(1000)],
        ["start", "2025-06-15"],
      ],
    };
    const result = parseCalendarEvent(event);
    expect(result!.title.length).toBeLessThanOrEqual(300);
  });

  it("rejects javascript: URIs in link tags", () => {
    const event = {
      ...baseDateEvent,
      tags: [
        ...baseDateEvent.tags,
        ["r", "javascript:alert(1)"],
      ],
    };
    const result = parseCalendarEvent(event);
    expect(result!.link).toBeUndefined();
  });

  it("accepts https links", () => {
    const event = {
      ...baseDateEvent,
      tags: [
        ...baseDateEvent.tags,
        ["r", "https://example.com/event"],
      ],
    };
    const result = parseCalendarEvent(event);
    expect(result!.link).toBe("https://example.com/event");
  });

  it("collects hashtags from t tags", () => {
    const event = {
      ...baseDateEvent,
      tags: [
        ...baseDateEvent.tags,
        ["t", "work"],
        ["t", "meeting"],
      ],
    };
    const result = parseCalendarEvent(event);
    expect(result!.hashtags).toEqual(["work", "meeting"]);
  });

  it("parses recurrence from rrule tag", () => {
    const event = {
      ...baseDateEvent,
      tags: [
        ...baseDateEvent.tags,
        ["rrule", "FREQ=WEEKLY;COUNT=4"],
      ],
    };
    const result = parseCalendarEvent(event);
    expect(result!.recurrence).toEqual({ freq: "weekly", count: 4 });
  });

  it("parses recurrence from JSON content as fallback", () => {
    const event = {
      ...baseDateEvent,
      content: JSON.stringify({
        description: "test",
        recurrence: { freq: "daily", count: 7 },
      }),
    };
    const result = parseCalendarEvent(event);
    expect(result!.recurrence).toEqual({ freq: "daily", count: 7 });
  });
});

// ── parseCalendarCollection ────────────────────────────────────────────

describe("parseCalendarCollection", () => {
  it("parses a valid collection", () => {
    const validATag = `31922:${"a".repeat(64)}:some-dtag`;
    const result = parseCalendarCollection({
      tags: [
        ["d", "cal-1"],
        ["title", "Work Calendar"],
        ["a", validATag],
        ["color", "#ff0000"],
      ],
      content: "",
    });
    expect(result).not.toBeNull();
    expect(result!.dTag).toBe("cal-1");
    expect(result!.title).toBe("Work Calendar");
    expect(result!.eventRefs).toEqual([validATag]);
    expect(result!.color).toBe("#ff0000");
  });

  it("returns null when d tag is missing", () => {
    const result = parseCalendarCollection({
      tags: [["title", "No DTag"]],
      content: "",
    });
    expect(result).toBeNull();
  });

  it("defaults title to 'Untitled Calendar'", () => {
    const result = parseCalendarCollection({
      tags: [["d", "no-title"]],
      content: "",
    });
    expect(result!.title).toBe("Untitled Calendar");
  });

  it("rejects malformed a-tags", () => {
    const result = parseCalendarCollection({
      tags: [
        ["d", "cal-2"],
        ["a", "not-a-valid-atag"],
        ["a", `31922:${"a".repeat(64)}:valid`],
      ],
      content: "",
    });
    expect(result!.eventRefs).toHaveLength(1);
    expect(result!.eventRefs[0]).toContain("valid");
  });
});

// ── advanceDate ────────────────────────────────────────────────────────

describe("advanceDate", () => {
  const base = new Date("2025-01-15T10:00:00Z");

  it("advances daily", () => {
    const result = advanceDate(base, "daily", 3);
    expect(result.getDate()).toBe(18);
  });

  it("advances weekly", () => {
    const result = advanceDate(base, "weekly", 2);
    expect(result.getDate()).toBe(29);
  });

  it("advances monthly", () => {
    const result = advanceDate(base, "monthly", 1);
    expect(result.getMonth()).toBe(1); // February
  });

  it("advances yearly", () => {
    const result = advanceDate(base, "yearly", 1);
    expect(result.getFullYear()).toBe(2026);
  });

  it("returns original date for offset 0", () => {
    const result = advanceDate(base, "daily", 0);
    expect(result.getTime()).toBe(base.getTime());
  });
});

// ── Timestamp bounds warning ────────────────────────────────────────────

describe("parseCalendarEvent timestamp bounds warning", () => {
  it("still parses a timed event with a far-future start (warns but does not reject)", () => {
    // ~11 years into the future — beyond the 10-year MAX_FUTURE_S threshold
    const farFuture = Math.floor(Date.now() / 1000) + 11 * 365 * 24 * 3600;
    const result = parseCalendarEvent({
      id: "ts-future",
      pubkey: "a".repeat(64),
      kind: KIND_TIME_EVENT,
      tags: [
        ["d", "far-future"],
        ["title", "Far Future Event"],
        ["start", String(farFuture)],
      ],
      content: "",
      created_at: Math.floor(Date.now() / 1000),
    });
    expect(result).not.toBeNull();
    expect(result!.title).toBe("Far Future Event");
  });

  it("still parses a timed event with an ancient start (warns but does not reject)", () => {
    // ~31 years ago — beyond the 30-year MAX_AGE_S threshold
    const ancient = Math.floor(Date.now() / 1000) - 31 * 365 * 24 * 3600;
    const result = parseCalendarEvent({
      id: "ts-ancient",
      pubkey: "a".repeat(64),
      kind: KIND_TIME_EVENT,
      tags: [
        ["d", "ancient"],
        ["title", "Ancient Event"],
        ["start", String(ancient)],
      ],
      content: "",
      created_at: Math.floor(Date.now() / 1000),
    });
    expect(result).not.toBeNull();
    expect(result!.title).toBe("Ancient Event");
  });

  it("parses a timed event within normal range without warning", () => {
    const normal = Math.floor(Date.now() / 1000) + 7 * 24 * 3600; // 1 week ahead
    const result = parseCalendarEvent({
      id: "ts-normal",
      pubkey: "a".repeat(64),
      kind: KIND_TIME_EVENT,
      tags: [
        ["d", "normal"],
        ["title", "Normal Event"],
        ["start", String(normal)],
      ],
      content: "",
      created_at: Math.floor(Date.now() / 1000),
    });
    expect(result).not.toBeNull();
  });
});

// ── a-tag cap ───────────────────────────────────────────────────────────

describe("parseCalendarCollection a-tag cap", () => {
  it("caps eventRefs at 1000 when given more than 1000 a-tags", () => {
    const validATag = (i: number) => `31922:${"a".repeat(64)}:event-${i}`;
    const result = parseCalendarCollection({
      tags: [
        ["d", "large-cal"],
        ["title", "Large Calendar"],
        ...Array.from({ length: 1500 }, (_, i) => ["a", validATag(i)]),
      ],
      content: "",
    });
    expect(result).not.toBeNull();
    expect(result!.eventRefs).toHaveLength(1000);
  });

  it("returns all refs when count is below the cap", () => {
    const validATag = (i: number) => `31922:${"a".repeat(64)}:event-${i}`;
    const result = parseCalendarCollection({
      tags: [
        ["d", "small-cal"],
        ...Array.from({ length: 5 }, (_, i) => ["a", validATag(i)]),
      ],
      content: "",
    });
    expect(result).not.toBeNull();
    expect(result!.eventRefs).toHaveLength(5);
  });

  it("caps exactly at 1000 when given exactly 1000 a-tags", () => {
    const validATag = (i: number) => `31922:${"a".repeat(64)}:event-${i}`;
    const result = parseCalendarCollection({
      tags: [
        ["d", "exact-cal"],
        ...Array.from({ length: 1000 }, (_, i) => ["a", validATag(i)]),
      ],
      content: "",
    });
    expect(result!.eventRefs).toHaveLength(1000);
  });
});

// ── generateDTag ───────────────────────────────────────────────────────

describe("generateDTag", () => {
  it("generates unique values", () => {
    const tags = new Set(Array.from({ length: 100 }, () => generateDTag()));
    expect(tags.size).toBe(100);
  });

  it("generates hex strings", () => {
    const tag = generateDTag();
    expect(tag).toMatch(/^[0-9a-f]+$/);
  });
});
