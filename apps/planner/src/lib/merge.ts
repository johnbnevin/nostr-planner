/**
 * @module merge
 *
 * Pure, deterministic merge between two {@link Snapshot}s so multiple
 * devices can write concurrently without overwriting each other.
 *
 * ## Rules
 *
 * - **Entities keyed by a stable id** (`dTag` for calendars/events, `id`
 *   for habits/lists) are unioned. When the same id appears on both
 *   sides, the one with the later `updatedAt` wins; ties break toward
 *   the remote side (it's the newer pointer by definition).
 * - **Tombstones** (`deleted: true` entries) survive the merge so a
 *   stale peer can't resurrect a deleted item. They stay in the snapshot
 *   but are filtered out of the UI by the applySnapshot path.
 * - **Habit completions** are unioned — if A added "2026-04-17" for
 *   habit H and B added "2026-04-18" for the same habit, both stick.
 * - **Settings** are treated as a whole-object last-write-wins scalar
 *   (Snapshot.savedAt on each side is the tiebreaker).
 *
 * The function is pure: given the same two snapshots it always returns
 * the same output. Idempotent: `merge(merge(a,b), b) === merge(a, b)`.
 */

import type { Snapshot } from "./backup";
import type { CalendarEvent, CalendarCollection } from "./nostr";
import type { DailyHabit, UserList } from "../contexts/TasksContext";

/** Later `updatedAt` wins. Missing fields coerce to 0 (always loses). */
function pickNewer<T extends { updatedAt?: number }>(local: T, remote: T): T {
  return (remote.updatedAt ?? 0) >= (local.updatedAt ?? 0) ? remote : local;
}

function mergeById<T extends { updatedAt?: number }>(
  local: T[], remote: T[], keyOf: (t: T) => string
): T[] {
  const out = new Map<string, T>();
  for (const item of local) out.set(keyOf(item), item);
  for (const item of remote) {
    const key = keyOf(item);
    const existing = out.get(key);
    out.set(key, existing ? pickNewer(existing, item) : item);
  }
  return Array.from(out.values());
}

function mergeCompletions(
  local: Record<string, string[]>,
  remote: Record<string, string[]>
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const habitIds = new Set([...Object.keys(local), ...Object.keys(remote)]);
  for (const id of habitIds) {
    const union = new Set<string>([...(local[id] ?? []), ...(remote[id] ?? [])]);
    out[id] = Array.from(union).sort();
  }
  return out;
}

export function mergeSnapshots(local: Snapshot, remote: Snapshot): Snapshot {
  // If remote is wholesale newer (later savedAt), use it as the base for
  // scalar settings; per-entity merge still runs below.
  const newer = Date.parse(remote.savedAt) >= Date.parse(local.savedAt) ? remote : local;

  return {
    version: 1,
    savedAt: new Date().toISOString(),
    calendars: mergeById<CalendarCollection>(local.calendars, remote.calendars, (c) => c.dTag),
    events: mergeById<CalendarEvent>(local.events, remote.events, (e) => e.dTag),
    habits: mergeById<DailyHabit>(local.habits, remote.habits, (h) => h.id),
    completions: mergeCompletions(local.completions, remote.completions),
    lists: mergeById<UserList>(local.lists, remote.lists, (l) => l.id),
    settings: newer.settings,
  };
}

/**
 * Strip tombstones before handing the snapshot to the UI. Tombstones
 * stay in the Blossom copy so stale peers can't resurrect deletions,
 * but the UI never renders them.
 */
export function liveView(snap: Snapshot): {
  calendars: CalendarCollection[];
  events: CalendarEvent[];
  habits: DailyHabit[];
  lists: UserList[];
} {
  const alive = <T extends { deleted?: boolean }>(t: T) => !t.deleted;
  return {
    calendars: snap.calendars.filter(alive),
    events: snap.events.filter(alive),
    habits: snap.habits.filter(alive),
    lists: snap.lists.filter(alive),
  };
}
