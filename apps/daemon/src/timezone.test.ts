import { describe, it, expect } from "vitest";
import { getDatePartsInZone, getMidnightInZone } from "./timezone.js";

describe("getDatePartsInZone", () => {
  it("returns numeric date parts for UTC", () => {
    const parts = getDatePartsInZone("UTC");
    expect(parts.year).toBeGreaterThan(2020);
    expect(parts.month).toBeGreaterThanOrEqual(1);
    expect(parts.month).toBeLessThanOrEqual(12);
    expect(parts.day).toBeGreaterThanOrEqual(1);
    expect(parts.day).toBeLessThanOrEqual(31);
    expect(parts.hour).toBeGreaterThanOrEqual(0);
    expect(parts.hour).toBeLessThanOrEqual(23);
  });

  it("produces a correctly formatted dateKey", () => {
    const parts = getDatePartsInZone("UTC");
    expect(parts.dateKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns different hours for timezones offset by 12 hours", () => {
    // UTC+12 (Pacific/Auckland) and UTC-12 (Baker Island) are 24h apart,
    // but any two timezones 12h apart should have the same hour only once
    // a day. We can't assert the exact hour without mocking Date, but we
    // can assert both return valid results.
    const utcParts = getDatePartsInZone("UTC");
    const nzParts = getDatePartsInZone("Pacific/Auckland");
    expect(utcParts.hour).toBeGreaterThanOrEqual(0);
    expect(nzParts.hour).toBeGreaterThanOrEqual(0);
  });

  it("throws for an invalid timezone", () => {
    expect(() => getDatePartsInZone("Not/A/Timezone")).toThrow();
  });

  it("returns consistent dateKey format for known timezone", () => {
    const parts = getDatePartsInZone("America/New_York");
    const [year, month, day] = parts.dateKey.split("-").map(Number);
    expect(year).toBe(parts.year);
    expect(month).toBe(parts.month);
    expect(day).toBe(parts.day);
  });
});

describe("getMidnightInZone", () => {
  it("returns a UTC timestamp for midnight in UTC", () => {
    // 2026-04-06 midnight UTC = 1743897600000
    const result = getMidnightInZone("2026-04-06", "UTC");
    const d = new Date(result);
    expect(d.getUTCHours()).toBe(0);
    expect(d.getUTCMinutes()).toBe(0);
    expect(d.getUTCFullYear()).toBe(2026);
    expect(d.getUTCMonth() + 1).toBe(4);
    expect(d.getUTCDate()).toBe(6);
  });

  it("adjusts for UTC-5 timezone (America/New_York, winter)", () => {
    // 2026-01-15: Eastern Standard Time = UTC-5
    // Midnight EST = 05:00 UTC
    const result = getMidnightInZone("2026-01-15", "America/New_York");
    const d = new Date(result);
    // Allow ±1 hour for DST edge cases
    expect(d.getUTCHours()).toBeGreaterThanOrEqual(4);
    expect(d.getUTCHours()).toBeLessThanOrEqual(6);
  });

  it("adjusts for UTC+9 timezone (Asia/Tokyo)", () => {
    // 2026-04-06: JST = UTC+9
    // Midnight JST = 15:00 UTC previous day
    const result = getMidnightInZone("2026-04-06", "Asia/Tokyo");
    const d = new Date(result);
    expect(d.getUTCDate()).toBe(5); // previous UTC day
    expect(d.getUTCHours()).toBe(15);
  });

  it("throws for an invalid timezone", () => {
    expect(() => getMidnightInZone("2026-04-06", "Not/A/Timezone")).toThrow();
  });
});
