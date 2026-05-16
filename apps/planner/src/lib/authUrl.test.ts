/**
 * Unit tests for authUrl.ts — broadcaster for NIP-46 auth URLs.
 */
import { describe, it, expect, vi } from "vitest";
import { emitAuthUrl, onAuthUrl } from "./authUrl";

describe("authUrl broadcaster", () => {
  it("delivers an emitted URL to subscribers", () => {
    const listener = vi.fn();
    const off = onAuthUrl(listener);
    emitAuthUrl("https://signer.example/approve?req=abc");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith("https://signer.example/approve?req=abc");
    off();
  });

  it("delivers to multiple subscribers", () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = onAuthUrl(a);
    const offB = onAuthUrl(b);
    emitAuthUrl("https://x/y");
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    offA();
    offB();
  });

  it("stops delivering after unsubscribe", () => {
    const listener = vi.fn();
    const off = onAuthUrl(listener);
    off();
    emitAuthUrl("https://x/y");
    expect(listener).not.toHaveBeenCalled();
  });

  it("does not throw if a listener throws", () => {
    const bad = vi.fn(() => { throw new Error("boom"); });
    const good = vi.fn();
    const offA = onAuthUrl(bad);
    const offB = onAuthUrl(good);
    expect(() => emitAuthUrl("https://x/y")).not.toThrow();
    // The good listener should still receive the event.
    expect(good).toHaveBeenCalledTimes(1);
    offA();
    offB();
  });

  it("no-ops cleanly when there are no subscribers", () => {
    // No listeners yet — should just log and return without throwing.
    expect(() => emitAuthUrl("https://x/y")).not.toThrow();
  });
});
