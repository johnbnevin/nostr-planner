/**
 * Unit tests for outbox.ts — IndexedDB-backed write queue.
 *
 * Node lacks IndexedDB, so `openDb()` calls fail and the outbox falls
 * back to its in-memory queue. These tests exercise that path: enqueue,
 * count, discard, change notifications. Full IndexedDB persistence
 * behavior is covered by integration testing in the browser.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NostrEvent } from "@nostrify/nostrify";
import {
  enqueueOutbox,
  countPending,
  discardOutboxEntry,
  clearOutbox,
  onOutboxChange,
  onOutboxStorageUnavailable,
  getOutboxDepth,
} from "./outbox";

const PK = "deadbeef".repeat(8); // 64-char hex placeholder
const PK2 = "feedface".repeat(8);

function makeEvent(id: string, kind = 31923): NostrEvent {
  return {
    id,
    pubkey: PK,
    created_at: Math.floor(Date.now() / 1000),
    kind,
    tags: [],
    content: "",
    sig: "00".repeat(64),
  };
}

describe("outbox in-memory fallback (no IndexedDB)", () => {
  beforeEach(async () => {
    // Reset state between tests by clearing both pubkeys' queues.
    await clearOutbox(PK);
    await clearOutbox(PK2);
  });

  afterEach(async () => {
    await clearOutbox(PK);
    await clearOutbox(PK2);
  });

  it("enqueues a failed publish and reports it in countPending", async () => {
    await enqueueOutbox(PK, makeEvent("a".repeat(64)), new Error("relay timeout"));
    const n = await countPending(PK);
    expect(n).toBeGreaterThanOrEqual(1);
  });

  it("scopes pending count by pubkey", async () => {
    await enqueueOutbox(PK, makeEvent("a".repeat(64)), new Error("x"));
    await enqueueOutbox(PK2, makeEvent("b".repeat(64)), new Error("x"));
    const nA = await countPending(PK);
    const nB = await countPending(PK2);
    expect(nA).toBeGreaterThanOrEqual(1);
    expect(nB).toBeGreaterThanOrEqual(1);
  });

  it("ignores events without an id", async () => {
    const before = await countPending(PK);
    const ev = makeEvent("x".repeat(64));
    delete (ev as Partial<NostrEvent>).id;
    await enqueueOutbox(PK, ev as NostrEvent, new Error("no id"));
    const after = await countPending(PK);
    expect(after).toBe(before);
  });

  it("discardOutboxEntry removes a specific entry", async () => {
    const eventId = "c".repeat(64);
    await enqueueOutbox(PK, makeEvent(eventId), new Error("x"));
    const before = await countPending(PK);
    expect(before).toBeGreaterThanOrEqual(1);
    await discardOutboxEntry(PK, eventId);
    const after = await countPending(PK);
    expect(after).toBe(before - 1);
  });

  it("clearOutbox wipes all entries for one pubkey", async () => {
    await enqueueOutbox(PK, makeEvent("d".repeat(64)), new Error("x"));
    await enqueueOutbox(PK, makeEvent("e".repeat(64)), new Error("x"));
    await enqueueOutbox(PK2, makeEvent("f".repeat(64)), new Error("x"));
    await clearOutbox(PK);
    const nA = await countPending(PK);
    const nB = await countPending(PK2);
    expect(nA).toBe(0);
    expect(nB).toBeGreaterThanOrEqual(1);
  });

  it("onOutboxStorageUnavailable fires when IndexedDB is missing", async () => {
    const handler = vi.fn();
    const off = onOutboxStorageUnavailable(handler);
    await enqueueOutbox(PK, makeEvent("g".repeat(64)), new Error("x"));
    // The in-memory fallback should have triggered the handler.
    expect(handler).toHaveBeenCalled();
    off();
  });

  it("getOutboxDepth reflects last observed count after debounce window", async () => {
    await enqueueOutbox(PK, makeEvent("h".repeat(64)), new Error("x"));
    // notifyChange is debounced 250ms — wait it out.
    await new Promise((r) => setTimeout(r, 300));
    expect(getOutboxDepth()).toBeGreaterThanOrEqual(1);
  });

  it("onOutboxChange listener receives debounced depth updates", async () => {
    const handler = vi.fn();
    const off = onOutboxChange(handler);
    await enqueueOutbox(PK, makeEvent("i".repeat(64)), new Error("x"));
    await new Promise((r) => setTimeout(r, 300));
    expect(handler).toHaveBeenCalled();
    off();
  });
});
