/**
 * Unit tests for digest.ts — UserRegistry schema validation and per-timezone
 * daily reset behavior for push notifications.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { UserRegistry } from "./digest.js";

// Mock signature verification — we test logic, not cryptography here
vi.mock("nostr-tools/pure", () => ({
  verifyEvent: vi.fn().mockReturnValue(true),
}));

// Mock decryption to be a transparent pass-through so tests can supply
// plaintext JSON directly as event.content
vi.mock("./decrypt.js", () => ({
  decryptFromUser: vi.fn((_priv: Uint8Array, _pub: string, content: string) => content),
}));

// ── Test fixtures ─────────────────────────────────────────────────────────

const TEST_PUBKEY = "a".repeat(64);
const BOT_PRIVKEY = new Uint8Array(32);
const BOT_PUBKEY = "b".repeat(64);

/** Build a minimal valid NostrEvent for a given d-tag and payload. */
function makeEvent(dTag: string, content: unknown) {
  return {
    id: "aa" + Math.random().toString(36).slice(2).padEnd(62, "0"),
    pubkey: TEST_PUBKEY,
    created_at: Math.floor(Date.now() / 1000),
    kind: 30078,
    tags: [["d", dTag]],
    content: JSON.stringify(content),
    sig: "00".repeat(32),
  };
}

/** A timed event whose alert window starts 5 minutes ago and ends 5 min from now. */
function alertWindowEvent() {
  const start = new Date(Date.now() + 5 * 60_000).toISOString(); // starts 5 min from now
  return {
    title: "Stand-up",
    start,
    allDay: false,
    location: "",
  };
}

const VALID_DATA = {
  v: 1,
  preparedAt: Math.floor(Date.now() / 1000),
  timezone: "UTC",
  events: [],
  todos: [],
  habits: [],
};

const VALID_PUSH_SUB = {
  v: 1,
  endpoint: "https://fcm.googleapis.com/fcm/send/tok-abc",
  keys: { p256dh: "cHVibGljS2V5", auth: "YXV0aA==" },
  allDayMinsBefore: 480,
  timedMinsBefore: 15,
  timezone: "America/New_York",
};

// ── handleData schema validation ──────────────────────────────────────────

describe("UserRegistry — handleData schema validation", () => {
  let registry: UserRegistry;

  beforeEach(() => {
    registry = new UserRegistry(BOT_PRIVKEY, BOT_PUBKEY);
  });

  it("stores valid push data", () => {
    registry.processEvent(makeEvent("planner-digest-data", VALID_DATA));
    expect(() => registry.getPendingPushNotifications(24)).not.toThrow();
  });

  it("rejects data when preparedAt is a string", () => {
    const bad = { ...VALID_DATA, preparedAt: "now" };
    registry.processEvent(makeEvent("planner-digest-data", bad));
    expect(registry.getPendingPushNotifications(24)).toHaveLength(0);
  });

  it("rejects data when events is not an array", () => {
    const bad = { ...VALID_DATA, events: "[]" };
    registry.processEvent(makeEvent("planner-digest-data", bad));
    expect(registry.getPendingPushNotifications(24)).toHaveLength(0);
  });

  it("rejects data when todos is null", () => {
    const bad = { ...VALID_DATA, todos: null };
    registry.processEvent(makeEvent("planner-digest-data", bad));
    expect(registry.getPendingPushNotifications(24)).toHaveLength(0);
  });

  it("rejects data when habits is missing", () => {
    const { habits: _, ...noHabits } = VALID_DATA;
    registry.processEvent(makeEvent("planner-digest-data", noHabits));
    expect(registry.getPendingPushNotifications(24)).toHaveLength(0);
  });

  it("rejects data when timezone is missing", () => {
    const { timezone: _, ...noTz } = VALID_DATA;
    registry.processEvent(makeEvent("planner-digest-data", noTz));
    expect(registry.getPendingPushNotifications(24)).toHaveLength(0);
  });
});

// ── handlePushSub schema validation ───────────────────────────────────────

describe("UserRegistry — handlePushSub schema validation", () => {
  let registry: UserRegistry;

  beforeEach(() => {
    registry = new UserRegistry(BOT_PRIVKEY, BOT_PUBKEY);
  });

  it("registers a push sub for a valid payload", () => {
    registry.processEvent(makeEvent("planner-push-sub-device1", VALID_PUSH_SUB));
    expect(() => registry.getPendingPushNotifications(24)).not.toThrow();
  });

  it("rejects push sub when endpoint is not https://", () => {
    const bad = { ...VALID_PUSH_SUB, endpoint: "http://insecure.example.com/push" };
    registry.processEvent(makeEvent("planner-push-sub-device1", bad));
    expect(registry.getPendingPushNotifications(24)).toHaveLength(0);
  });

  it("rejects push sub when endpoint is not a string", () => {
    const bad = { ...VALID_PUSH_SUB, endpoint: 42 };
    registry.processEvent(makeEvent("planner-push-sub-device1", bad));
    expect(registry.getPendingPushNotifications(24)).toHaveLength(0);
  });

  it("rejects push sub when keys.p256dh is missing", () => {
    const bad = { ...VALID_PUSH_SUB, keys: { auth: "YXV0aA==" } };
    registry.processEvent(makeEvent("planner-push-sub-device1", bad));
    expect(registry.getPendingPushNotifications(24)).toHaveLength(0);
  });

  it("rejects push sub when allDayMinsBefore is a string", () => {
    const bad = { ...VALID_PUSH_SUB, allDayMinsBefore: "480" };
    registry.processEvent(makeEvent("planner-push-sub-device1", bad));
    expect(registry.getPendingPushNotifications(24)).toHaveLength(0);
  });

  it("rejects push sub when timezone is missing", () => {
    const { timezone: _, ...noTz } = VALID_PUSH_SUB;
    registry.processEvent(makeEvent("planner-push-sub-device1", noTz));
    expect(registry.getPendingPushNotifications(24)).toHaveLength(0);
  });

  it("rejects an empty payload", () => {
    registry.processEvent(makeEvent("planner-push-sub-device1", {}));
    expect(registry.getPendingPushNotifications(24)).toHaveLength(0);
  });
});

// ── Per-timezone daily deduplication reset ────────────────────────────────

describe("UserRegistry — per-timezone daily reset", () => {
  let registry: UserRegistry;

  beforeEach(() => {
    registry = new UserRegistry(BOT_PRIVKEY, BOT_PUBKEY);

    // Push data with one event in the alert window
    const data = {
      v: 1,
      preparedAt: Math.floor(Date.now() / 1000),
      timezone: "America/New_York",
      events: [alertWindowEvent()],
      todos: [],
      habits: [],
    };
    registry.processEvent(makeEvent("planner-digest-data", data));
    registry.processEvent(makeEvent("planner-push-sub-device1", VALID_PUSH_SUB));
  });

  it("fires a notification for an event in the alert window", () => {
    const pending = registry.getPendingPushNotifications(24);
    expect(pending).toHaveLength(1);
    expect(pending[0].event.title).toBe("Stand-up");
  });

  it("does not re-fire after the event is marked sent", () => {
    const pending = registry.getPendingPushNotifications(24);
    expect(pending).toHaveLength(1);

    const { sub, event } = pending[0];
    const key = `${event.start}\x00${event.title}\x00${event.location ?? ""}`;
    registry.markPushSent(sub, key);

    const pending2 = registry.getPendingPushNotifications(24);
    expect(pending2).toHaveLength(0);
  });

  it("re-fires after the local date rolls over (notifiedDateKey becomes stale)", () => {
    const pending = registry.getPendingPushNotifications(24);
    expect(pending).toHaveLength(1);

    const { sub, event } = pending[0];
    const key = `${event.start}\x00${event.title}\x00${event.location ?? ""}`;
    registry.markPushSent(sub, key);

    // Simulate a new local day by resetting the date key to a past value
    sub.notifiedDateKey = "1970-01-01";

    // On next check, getPendingPushNotifications detects the stale key and
    // clears notifiedToday — the event becomes eligible again
    const pending2 = registry.getPendingPushNotifications(24);
    expect(pending2).toHaveLength(1);
  });

  it("clears notifiedToday and updates notifiedDateKey when the date rolls over", () => {
    const pending = registry.getPendingPushNotifications(24);
    const { sub, event } = pending[0];
    const key = `${event.start}\x00${event.title}\x00`;
    registry.markPushSent(sub, key);

    expect(sub.notifiedToday.size).toBe(1);

    // Force a day rollover
    sub.notifiedDateKey = "1970-01-01";
    registry.getPendingPushNotifications(24);

    // notifiedToday was cleared by the lazy reset
    expect(sub.notifiedDateKey).not.toBe("1970-01-01");
    expect(sub.notifiedToday.size).toBe(0);
  });
});
