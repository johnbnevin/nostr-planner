/**
 * Unit tests for relay.ts — relay list parsing, pool management.
 */
import { describe, it, expect, afterEach } from "vitest";
import { parseRelayList, closePool, filterKey } from "./relay";

afterEach(() => {
  closePool();
});

describe("parseRelayList", () => {
  it("parses bare relay tags as both read and write", () => {
    const result = parseRelayList({
      tags: [
        ["r", "wss://relay.example.com"],
      ],
    });
    expect(result.read).toContain("wss://relay.example.com");
    expect(result.write).toContain("wss://relay.example.com");
    expect(result.all).toContain("wss://relay.example.com");
  });

  it("parses read-only relays", () => {
    const result = parseRelayList({
      tags: [
        ["r", "wss://read.example.com", "read"],
      ],
    });
    expect(result.read).toContain("wss://read.example.com");
    expect(result.write).not.toContain("wss://read.example.com");
  });

  it("parses write-only relays", () => {
    const result = parseRelayList({
      tags: [
        ["r", "wss://write.example.com", "write"],
      ],
    });
    expect(result.write).toContain("wss://write.example.com");
    expect(result.read).not.toContain("wss://write.example.com");
  });

  it("deduplicates in the all array", () => {
    const result = parseRelayList({
      tags: [
        ["r", "wss://relay.example.com", "read"],
        ["r", "wss://relay.example.com", "write"],
      ],
    });
    expect(result.all.filter((r) => r === "wss://relay.example.com")).toHaveLength(1);
  });

  it("ignores non-r tags", () => {
    const result = parseRelayList({
      tags: [
        ["p", "pubkey-value"],
        ["r", "wss://relay.example.com"],
        ["e", "event-id"],
      ],
    });
    expect(result.all).toHaveLength(1);
  });

  it("returns empty arrays for empty tags", () => {
    const result = parseRelayList({ tags: [] });
    expect(result.read).toHaveLength(0);
    expect(result.write).toHaveLength(0);
    expect(result.all).toHaveLength(0);
  });
});

// ── filterKey ────────────────────────────────────────────────────────────

describe("filterKey", () => {
  it("produces the same key regardless of property order", () => {
    const k1 = filterKey({ kinds: [31922, 31923], authors: ["abc", "def"] });
    const k2 = filterKey({ authors: ["abc", "def"], kinds: [31922, 31923] });
    expect(k1).toBe(k2);
  });

  it("produces the same key for differently-ordered array values", () => {
    const k1 = filterKey({ kinds: [31922, 31923] });
    const k2 = filterKey({ kinds: [31923, 31922] });
    expect(k1).toBe(k2);
  });

  it("produces different keys for genuinely different filters", () => {
    const k1 = filterKey({ kinds: [31922] });
    const k2 = filterKey({ kinds: [31923] });
    expect(k1).not.toBe(k2);
  });

  it("handles filters with tag arrays (e.g. #p)", () => {
    const k1 = filterKey({ kinds: [30078], "#p": ["aaa", "bbb"] });
    const k2 = filterKey({ kinds: [30078], "#p": ["bbb", "aaa"] });
    expect(k1).toBe(k2);
  });

  it("treats filters with different limits as different", () => {
    const k1 = filterKey({ kinds: [31922], limit: 100 });
    const k2 = filterKey({ kinds: [31922], limit: 500 });
    expect(k1).not.toBe(k2);
  });
});
