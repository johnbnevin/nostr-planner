/**
 * Unit tests for relayScore.ts — per-relay EWMA quality tracking.
 *
 * Node has no localStorage; the module fails the hydrate read and the
 * persist write silently, exercising the in-memory path (which is the
 * branch we care about for unit tests).
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  recordSuccess,
  recordFailure,
  getScore,
  sortRelaysByScore,
  getRawScore,
  clearScores,
} from "./relayScore";

describe("relayScore", () => {
  beforeEach(() => clearScores());

  it("returns a neutral score for unseen relays", () => {
    expect(getScore("wss://unseen.example")).toBe(0.5);
  });

  it("ranks a successful relay higher than a failed one", () => {
    recordSuccess("wss://good.example", 100);
    recordFailure("wss://bad.example");
    expect(getScore("wss://good.example")).toBeGreaterThan(getScore("wss://bad.example"));
  });

  it("EWMA-weights repeated observations", () => {
    recordSuccess("wss://x.example", 100);
    recordSuccess("wss://x.example", 100);
    recordSuccess("wss://x.example", 100);
    const s = getRawScore("wss://x.example");
    expect(s).not.toBeNull();
    expect(s!.count).toBe(3);
    expect(s!.success).toBeGreaterThan(0.4);
  });

  it("penalizes high latency", () => {
    recordSuccess("wss://fast.example", 100);
    recordSuccess("wss://slow.example", 4500);
    expect(getScore("wss://fast.example")).toBeGreaterThan(getScore("wss://slow.example"));
  });

  it("sortRelaysByScore puts best first", () => {
    recordSuccess("wss://good.example", 50);
    recordFailure("wss://bad.example");
    recordSuccess("wss://medium.example", 1000);
    const sorted = sortRelaysByScore([
      "wss://bad.example",
      "wss://medium.example",
      "wss://good.example",
    ]);
    expect(sorted[0]).toBe("wss://good.example");
    expect(sorted[sorted.length - 1]).toBe("wss://bad.example");
  });

  it("clearScores resets all state", () => {
    recordSuccess("wss://x.example", 100);
    clearScores();
    expect(getRawScore("wss://x.example")).toBeNull();
    expect(getScore("wss://x.example")).toBe(0.5);
  });
});
