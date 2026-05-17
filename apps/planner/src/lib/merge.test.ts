/**
 * Tests for mergeSnapshots — including the new per-field LWW path.
 */
import { describe, it, expect } from "vitest";
import { mergeSnapshots } from "./merge";
import type { Snapshot } from "./backup";
import type { CalendarEvent } from "./nostr";

function baseEvent(partial: Partial<CalendarEvent>): CalendarEvent {
  return {
    id: "e1",
    pubkey: "p",
    kind: 31923,
    dTag: "evt-1",
    title: "Lunch",
    content: "",
    start: new Date("2026-05-15T12:00:00Z"),
    allDay: false,
    hashtags: [],
    calendarRefs: [],
    tags: [],
    createdAt: 100,
    ...partial,
  };
}

function snap(events: CalendarEvent[], savedAt = "2026-05-15T12:00:00Z"): Snapshot {
  return {
    version: 1,
    savedAt,
    calendars: [],
    events,
    habits: [],
    completions: {},
    lists: [],
    settings: {} as Snapshot["settings"],
  };
}

describe("mergeSnapshots — whole-entity LWW (backward compat)", () => {
  it("picks the entity with the later top-level updatedAt", () => {
    const local = snap([baseEvent({ title: "Lunch (local)", updatedAt: 100 })]);
    const remote = snap([baseEvent({ title: "Lunch (remote)", updatedAt: 200 })]);
    const merged = mergeSnapshots(local, remote);
    expect(merged.events).toHaveLength(1);
    expect(merged.events[0].title).toBe("Lunch (remote)");
  });

  it("local wins when remote is older", () => {
    const local = snap([baseEvent({ title: "Lunch (local)", updatedAt: 300 })]);
    const remote = snap([baseEvent({ title: "Lunch (remote)", updatedAt: 200 })]);
    const merged = mergeSnapshots(local, remote);
    expect(merged.events[0].title).toBe("Lunch (local)");
  });

  it("unions entities present on only one side", () => {
    const local = snap([baseEvent({ dTag: "a", updatedAt: 100 })]);
    const remote = snap([baseEvent({ dTag: "b", updatedAt: 100 })]);
    const merged = mergeSnapshots(local, remote);
    expect(merged.events.map((e) => e.dTag).sort()).toEqual(["a", "b"]);
  });
});

describe("mergeSnapshots — per-field LWW", () => {
  it("merges field-by-field when both sides have fieldUpdatedAt", () => {
    // Device A renamed the event at t=100.
    // Device B moved its location at t=200.
    // Neither edit should clobber the other.
    const local = snap([baseEvent({
      title: "Lunch with Alex",
      location: undefined,
      updatedAt: 100,
      fieldUpdatedAt: { title: 100 },
    })]);
    const remote = snap([baseEvent({
      title: "Lunch", // unchanged from base
      location: "Cafe Verdant",
      updatedAt: 200,
      fieldUpdatedAt: { location: 200 },
    })]);
    const merged = mergeSnapshots(local, remote);
    expect(merged.events).toHaveLength(1);
    const e = merged.events[0];
    expect(e.title).toBe("Lunch with Alex");
    expect(e.location).toBe("Cafe Verdant");
    // The merged fieldUpdatedAt map carries both edits forward.
    expect(e.fieldUpdatedAt?.title).toBe(100);
    expect(e.fieldUpdatedAt?.location).toBe(200);
  });

  it("falls back to whole-entity LWW for fields lacking metadata", () => {
    // local has fieldUpdatedAt for title but not for location;
    // remote has neither; remote wins on location via top-level updatedAt.
    const local = snap([baseEvent({
      title: "Lunch with Alex",
      location: "Old Cafe",
      updatedAt: 50,
      fieldUpdatedAt: { title: 100 },
    })]);
    const remote = snap([baseEvent({
      title: "Lunch",
      location: "Cafe Verdant",
      updatedAt: 200,
    })]);
    const merged = mergeSnapshots(local, remote);
    const e = merged.events[0];
    // title: 100 > remote.updatedAt? No, 100 < 200. So remote wins title.
    // Wait — title has fieldUpdatedAt=100 on local; remote has no field
    // metadata for title so we fall back to remote.updatedAt=200.
    // 200 >= 100, remote wins for title too.
    expect(e.title).toBe("Lunch");
    // location: no field metadata on local; fallback to local.updatedAt=50.
    // remote.updatedAt=200 > 50, so remote wins.
    expect(e.location).toBe("Cafe Verdant");
  });

  it("preserves the side with the higher per-field timestamp even when whole-entity older", () => {
    const local = snap([baseEvent({
      title: "Lunch with Alex",
      location: "Cafe Verdant",
      updatedAt: 50, // older whole-entity
      fieldUpdatedAt: { title: 500 }, // but title was edited recently
    })]);
    const remote = snap([baseEvent({
      title: "Lunch",
      location: "Other Cafe",
      updatedAt: 200,
      fieldUpdatedAt: { location: 200 },
    })]);
    const merged = mergeSnapshots(local, remote);
    const e = merged.events[0];
    // Title: local 500 > remote's fallback 200 → local wins.
    expect(e.title).toBe("Lunch with Alex");
    // Location: remote 200 > local's fallback 50 → remote wins.
    expect(e.location).toBe("Other Cafe");
  });
});

describe("mergeSnapshots — habit completions union", () => {
  it("unions completion dates per habit", () => {
    const local = snap([], "2026-05-15T12:00:00Z");
    local.completions = { h1: ["2026-04-17"] };
    const remote = snap([], "2026-05-15T12:00:00Z");
    remote.completions = { h1: ["2026-04-18"] };
    const merged = mergeSnapshots(local, remote);
    expect(merged.completions.h1.sort()).toEqual(["2026-04-17", "2026-04-18"]);
  });
});
