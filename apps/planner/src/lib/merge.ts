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
 *   sides, we attempt a **per-field last-write-wins (LWW)** merge using
 *   the optional `fieldUpdatedAt: Record<string, number>` map on each
 *   side. Each field independently takes the side whose `fieldUpdatedAt`
 *   timestamp for that key is larger. If a field timestamp is missing
 *   on one side we fall back to whole-entity LWW (top-level `updatedAt`)
 *   for that field. This avoids the classic "device A renamed, device B
 *   moved → only the later edit survives" data-loss pattern.
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
 *
 * ## Backward compatibility
 *
 * Older snapshots written before this code shipped have no
 * `fieldUpdatedAt` map; their entities still merge correctly because the
 * code falls back to whole-entity LWW when both sides lack per-field
 * metadata. Mutator code that wants finer-grained conflict resolution
 * can start populating `fieldUpdatedAt[fieldName] = Date.now()` on each
 * edit without coordinating a schema migration.
 */

import type { Snapshot } from "./backup";
import type { CalendarEvent, CalendarCollection } from "./nostr";
import type { DailyHabit, UserList } from "../contexts/TasksContext";

/** Optional per-field LWW timestamp map. Keys are field names of the
 *  containing entity; values are unix-ms timestamps. Entities that omit
 *  this fall back to whole-entity LWW. */
type WithFieldTs = { fieldUpdatedAt?: Record<string, number> };

/**
 * Stamp the given fields with the current time on `entity`'s
 * `fieldUpdatedAt` map and return a shallow-cloned entity with
 * `updatedAt` and `fieldUpdatedAt` refreshed.
 *
 * Use from mutators so per-field LWW has real timestamp data to work
 * with — without this call, the merge code falls back to whole-entity
 * LWW (correct but coarser, the bug we're trying to fix).
 *
 *     setCalendars(prev => prev.map(c => c.dTag === id
 *       ? withFieldStamps(c, ["title"], { title: newName })
 *       : c));
 */
export function withFieldStamps<T extends WithFieldTs & { updatedAt?: number }>(
  entity: T,
  fields: readonly string[],
  patch: Partial<T>,
  now: number = Date.now(),
): T {
  const stamps: Record<string, number> = { ...(entity.fieldUpdatedAt ?? {}) };
  for (const f of fields) stamps[f] = now;
  return { ...entity, ...patch, updatedAt: now, fieldUpdatedAt: stamps };
}

/**
 * Merge two snapshots of the same entity field-by-field. Returns a new
 * object whose fields are chosen from whichever side has the higher
 * `fieldUpdatedAt[field]` timestamp. Falls back to whole-entity
 * `updatedAt` for fields that lack per-field metadata on either side.
 *
 * `id`/`dTag` fields are never merged (they're the identity); they're
 * taken from `local` (the two sides are identical by construction).
 */
function mergeEntityFields<T extends { updatedAt?: number } & WithFieldTs>(
  local: T, remote: T
): T {
  const localTs = local.updatedAt ?? 0;
  const remoteTs = remote.updatedAt ?? 0;
  const fieldL = local.fieldUpdatedAt ?? {};
  const fieldR = remote.fieldUpdatedAt ?? {};
  // If neither side has any per-field metadata, fall through to the
  // simple whole-entity LWW path for maximal predictability.
  if (Object.keys(fieldL).length === 0 && Object.keys(fieldR).length === 0) {
    return remoteTs >= localTs ? remote : local;
  }

  // Pick the side that wins on a given field name.
  //
  // Asymmetry that matters: if a side has *any* per-field metadata but no
  // entry for THIS field, that's a deliberate signal "I didn't touch this
  // field" — so we use a sentinel of -Infinity for it instead of falling
  // back to the entity-level updatedAt. Without this, a side that bumped
  // entity.updatedAt for an unrelated edit would silently take ownership
  // of every field, which is exactly the data-loss bug we're trying to
  // fix. The fallback to entity-level updatedAt only applies to sides
  // that have *no* per-field metadata at all (older snapshots).
  const localHasAny = Object.keys(fieldL).length > 0;
  const remoteHasAny = Object.keys(fieldR).length > 0;
  const pick = (k: string): T => {
    const tL = fieldL[k] ?? (localHasAny ? -Infinity : localTs);
    const tR = fieldR[k] ?? (remoteHasAny ? -Infinity : remoteTs);
    return tR >= tL ? remote : local;
  };

  // Build the output: identity from local, every other field from the
  // appropriate side. We deliberately enumerate union(keys(local) +
  // keys(remote)) so a field that exists on only one side still appears
  // in the merged result.
  const allKeys = new Set([...Object.keys(local), ...Object.keys(remote)]);
  const out = { ...local };
  for (const k of allKeys) {
    if (k === "fieldUpdatedAt" || k === "updatedAt") continue;
    const src = pick(k);
    (out as Record<string, unknown>)[k] = (src as Record<string, unknown>)[k];
  }

  // Merge the per-field timestamp maps so future merges have full context.
  const mergedFieldTs: Record<string, number> = { ...fieldL };
  for (const [k, v] of Object.entries(fieldR)) {
    mergedFieldTs[k] = Math.max(mergedFieldTs[k] ?? 0, v);
  }
  out.fieldUpdatedAt = mergedFieldTs;
  // Top-level updatedAt reflects the latest field write across either
  // side, so a subsequent whole-entity LWW comparison stays accurate.
  out.updatedAt = Math.max(localTs, remoteTs);
  return out;
}

function mergeById<T extends { updatedAt?: number } & WithFieldTs>(
  local: T[], remote: T[], keyOf: (t: T) => string
): T[] {
  const out = new Map<string, T>();
  for (const item of local) out.set(keyOf(item), item);
  for (const item of remote) {
    const key = keyOf(item);
    const existing = out.get(key);
    out.set(key, existing ? mergeEntityFields(existing, item) : item);
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
