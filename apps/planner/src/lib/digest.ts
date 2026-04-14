/**
 * Push notification data — Nostr-native approach.
 *
 * The client prepares event data (today's events, tasks, habits) and publishes
 * it NIP-44 encrypted to a known bot pubkey. A separate daemon watches for
 * these events, decrypts them, and sends Web Push notifications before events start.
 *
 * Two event types (both kind 30078):
 *
 * 1. Push data (d-tag: planner-digest-data)
 *    Published automatically on each app load. Contains today's events, tasks, habits.
 *
 * 2. Push subscription (d-tag: planner-push-sub-{hash})
 *    Published when push notifications are enabled. Contains the browser push endpoint.
 */

import { startOfDay, addDays } from "date-fns";
import { KIND_APP_DATA } from "./nostr";
import type { CalendarEvent, CalendarCollection } from "./nostr";
import type { DailyHabit, UserList } from "../contexts/TasksContext";
import type { NostrSigner } from "./signer";
import { isTauri } from "./platform";

// ── Bot pubkey ────────────────────────────────────────────────────────

/** The digest daemon's Nostr public key. Config and data are encrypted to this key. */
export const DIGEST_BOT_PUBKEY =
  "027ba0376e3169044f2195809195d34cc05da14d243a34b5ae7f9ccf64c7a93c";

/** VAPID public key for Web Push subscriptions (base64url). */
export const VAPID_PUBLIC_KEY =
  "BNnezTj-7GrNOVTkWWLFA37q8Dv8su_r-OV9m7EcfxSilNSTdmYPzTF16oegmQ9gm3ogRzHuR_8G2R1OH32mrmU";

// ── Payload types ─────────────────────────────────────────────────────

export interface DigestEvent {
  title: string;
  start: string; // ISO date or datetime
  end?: string;
  allDay: boolean;
  location?: string;
  calendar?: string; // calendar name
}

export interface DigestTodo {
  listName: string;
  title: string;
  done: boolean;
}

export interface DigestHabit {
  title: string;
  doneToday: boolean;
}

export interface DigestDataPayload {
  v: 1;
  preparedAt: number; // unix seconds
  timezone: string;
  events: DigestEvent[];
  todos: DigestTodo[];
  habits: DigestHabit[];
}

// ── Helpers ───────────────────────────────────────────────────────────

function fmt(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ── Build digest data from in-memory state ────────────────────────────

export function buildDigestData(opts: {
  events: CalendarEvent[];
  calendars: CalendarCollection[];
  habits: DailyHabit[];
  completions: Record<string, string[]>;
  lists: UserList[];
  timezone: string;
}): DigestDataPayload {
  const { events, calendars, habits, completions, lists, timezone } = opts;
  const now = new Date();
  const today = startOfDay(now);
  const tomorrow = addDays(today, 1);
  const weekEnd = addDays(today, 7);

  const calMap = new Map(calendars.map((c) => [c.dTag, c.title]));

  // Collect events: today, tomorrow, and multi-day/all-day within 7 days
  const digestEvents: DigestEvent[] = [];

  for (const e of events) {
    const eventStart = startOfDay(e.start);
    const eventEnd = e.end ? startOfDay(e.end) : eventStart;

    // Include if:
    // - Event starts today or tomorrow
    // - Multi-day/all-day event overlaps the next 7 days
    const startsToday = eventStart.getTime() === today.getTime();
    const startsTomorrow = eventStart.getTime() === tomorrow.getTime();
    const overlapsWeek =
      (e.allDay || (e.end && e.end.getTime() - e.start.getTime() > 86400000)) &&
      eventStart < weekEnd &&
      eventEnd >= today;

    if (!startsToday && !startsTomorrow && !overlapsWeek) continue;

    const calName = e.calendarRefs.length > 0
      ? calMap.get(e.calendarRefs[0])
      : undefined;

    digestEvents.push({
      title: e.title,
      start: e.allDay ? fmt(e.start) : e.start.toISOString(),
      end: e.end ? (e.allDay ? fmt(e.end) : e.end.toISOString()) : undefined,
      allDay: e.allDay,
      location: e.location,
      calendar: calName,
    });
  }

  // Sort events by start
  digestEvents.sort((a, b) => a.start.localeCompare(b.start));

  // Collect todos (incomplete items first)
  const digestTodos: DigestTodo[] = [];
  for (const list of lists) {
    for (const item of list.items) {
      digestTodos.push({
        listName: list.name,
        title: item.title,
        done: item.done,
      });
    }
  }

  // Collect habits with today's completion
  const todayStr = fmt(now);
  const todayCompletions = completions[todayStr] || [];
  const digestHabits: DigestHabit[] = habits.map((h) => ({
    title: h.title,
    doneToday: todayCompletions.includes(h.id),
  }));

  return {
    v: 1,
    preparedAt: Math.floor(Date.now() / 1000),
    timezone,
    events: digestEvents,
    todos: digestTodos,
    habits: digestHabits,
  };
}

// ── Publish push data to Nostr ───────────────────────────────────────

export async function publishDigestData(opts: {
  payload: DigestDataPayload;
  nip44: NostrSigner["nip44"];
  signEvent: (e: { kind: number; created_at: number; tags: string[][]; content: string }) => Promise<{
    id: string; pubkey: string; created_at: number; kind: number; tags: string[][]; content: string; sig: string;
  }>;
  publishEvent: (e: {
    id: string; pubkey: string; created_at: number; kind: number; tags: string[][]; content: string; sig: string;
  }) => Promise<void>;
}): Promise<void> {
  const encrypted = await opts.nip44.encrypt(
    DIGEST_BOT_PUBKEY,
    JSON.stringify(opts.payload)
  );

  const signed = await opts.signEvent({
    kind: KIND_APP_DATA,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["d", "planner-digest-data"],
      ["p", DIGEST_BOT_PUBKEY],
    ],
    content: encrypted,
  });
  await opts.publishEvent(signed);
}

// ── Web Push subscription ─────────────────────────────────────────────

export interface PushSubscriptionPayload {
  v: 1;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  allDayMinsBefore: number;
  timedMinsBefore: number;
  timezone: string;
}

/** Register the Service Worker and subscribe to push notifications.
 *  Returns null on Tauri where service workers are not available. */
export async function registerPushSubscription(): Promise<PushSubscription | null> {
  if (isTauri()) return null;
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return null;

  const base = import.meta.env.BASE_URL || "/";
  const reg = await navigator.serviceWorker.register(`${base}sw.js`);
  await navigator.serviceWorker.ready;

  let sub = await reg.pushManager.getSubscription();
  if (sub) return sub;

  const vapidKey = urlBase64ToUint8Array(VAPID_PUBLIC_KEY);
  sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: vapidKey,
  });
  return sub;
}

/** Publish push subscription to Nostr, encrypted to the bot. */
export async function publishPushSubscription(opts: {
  subscription: PushSubscription;
  allDayMinsBefore: number;
  timedMinsBefore: number;
  timezone: string;
  nip44: NostrSigner["nip44"];
  signEvent: (e: { kind: number; created_at: number; tags: string[][]; content: string }) => Promise<{
    id: string; pubkey: string; created_at: number; kind: number; tags: string[][]; content: string; sig: string;
  }>;
  publishEvent: (e: {
    id: string; pubkey: string; created_at: number; kind: number; tags: string[][]; content: string; sig: string;
  }) => Promise<void>;
}): Promise<void> {
  const subJson = opts.subscription.toJSON();
  const payload: PushSubscriptionPayload = {
    v: 1,
    endpoint: subJson.endpoint!,
    keys: { p256dh: subJson.keys!.p256dh!, auth: subJson.keys!.auth! },
    allDayMinsBefore: opts.allDayMinsBefore,
    timedMinsBefore: opts.timedMinsBefore,
    timezone: opts.timezone,
  };

  const encrypted = await opts.nip44.encrypt(
    DIGEST_BOT_PUBKEY,
    JSON.stringify(payload)
  );

  // Deterministic d-tag per endpoint so each device gets its own replaceable event
  const endpointHash = await hashEndpoint(subJson.endpoint!);

  const signed = await opts.signEvent({
    kind: KIND_APP_DATA,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["d", `planner-push-sub-${endpointHash}`],
      ["p", DIGEST_BOT_PUBKEY],
    ],
    content: encrypted,
  });
  await opts.publishEvent(signed);
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from(rawData, (c) => c.charCodeAt(0));
}

async function hashEndpoint(endpoint: string): Promise<string> {
  const data = new TextEncoder().encode(endpoint);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
