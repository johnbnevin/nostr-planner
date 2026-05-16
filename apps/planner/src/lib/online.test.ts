/**
 * Unit tests for online.ts — online/offline detection.
 *
 * The probe loop is browser-only (uses fetch + setInterval against the
 * primary relay's HTTPS origin). We test the parts that work in Node:
 * isProbablyOnline default value and the subscription mechanism.
 */
import { describe, it, expect, vi } from "vitest";
import { isProbablyOnline, onOnlineChange } from "./online";

describe("online detection", () => {
  it("treats the default state as online in test/Node environments", () => {
    // navigator is typically present but navigator.onLine is true in
    // most test runners. The function returns the cached value seeded
    // from navigator.onLine.
    expect(isProbablyOnline()).toBe(true);
  });

  it("subscribers can attach and detach without throwing", () => {
    const listener = vi.fn();
    const off = onOnlineChange(listener);
    expect(typeof off).toBe("function");
    // Listener is not invoked immediately on subscribe — only on transitions.
    expect(listener).not.toHaveBeenCalled();
    off();
  });

  it("multiple subscribers can coexist", () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = onOnlineChange(a);
    const offB = onOnlineChange(b);
    offA();
    offB();
    // Just verifying no crash on multiple add/remove cycles.
    expect(true).toBe(true);
  });
});
