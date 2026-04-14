/**
 * TasksContext — manages daily habits, task lists, and habit completions.
 *
 * Data is stored as NIP-78 app-data events (kind 30078) on Nostr relays,
 * optionally NIP-44 encrypted. Two separate d-tagged events are maintained:
 *   - Daily data: habits array + completions record (keyed "YYYY-MM-DD" -> habit id[])
 *   - Lists data: array of UserList objects, each containing ListItem[]
 *
 * Completions older than 90 days are automatically pruned before publishing
 * to keep the event payload small.
 */

import {
  createContext,
  useContext,
  useState,
  useRef,
  useCallback,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import { useNostr } from "./NostrContext";
import { useSettings } from "./SettingsContext";
import { isNip44Available, encryptEvent, decryptEvent, isEncryptedEvent } from "../lib/crypto";
import { generateDTag, KIND_APP_DATA, DTAG_DAILY, DTAG_LISTS, DTAG_LISTS_OLD } from "../lib/nostr";
import { queryEvents } from "../lib/relay";
import { logger } from "../lib/logger";

const log = logger("tasks");

// ── Types ──────────────────────────────────────────────────────────────

export interface DailyHabit {
  id: string;
  title: string;
  createdAt: number;
}

export interface ListItem {
  id: string;
  title: string;
  done: boolean;
  createdAt: number;
}

export interface UserList {
  id: string;
  name: string;
  items: ListItem[];
  createdAt: number;
}

interface DailyData {
  habits: DailyHabit[];
  completions: Record<string, string[]>; // "YYYY-MM-DD" → habit id[]
}

interface ListsData {
  lists: UserList[];
}

/**
 * Public API surface for the tasks context.
 * Provides CRUD operations for daily habits and task lists,
 * plus completion tracking and manual refresh.
 */
/** Statistics for a single habit over a given time window. */
export interface HabitStats {
  /** Number of days the habit was completed within the window. */
  completed: number;
  /** Total days in the window (capped to days since habit was created). */
  total: number;
  /** Completion rate as a percentage (0–100). */
  rate: number;
  /** Current consecutive-day streak (from today backward). */
  currentStreak: number;
  /** Longest consecutive-day streak within the window. */
  bestStreak: number;
}

/** Statistics for all habits over multiple time windows. */
export interface HabitStatsBundle {
  last7: HabitStats;
  last30: HabitStats;
  last365: HabitStats;
  allTime: HabitStats;
}

interface TasksContextValue {
  // Daily habits
  habits: DailyHabit[];
  completions: Record<string, string[]>;
  addHabit: (title: string) => Promise<void>;
  removeHabit: (id: string) => Promise<void>;
  renameHabit: (id: string, title: string) => Promise<void>;
  toggleHabitCompletion: (habitId: string, date: string) => Promise<void>;
  isHabitDone: (habitId: string, date: string) => boolean;
  reorderHabits: (fromIndex: number, toIndex: number) => Promise<void>;
  /** Compute statistics for a habit across 7d, 30d, 365d, and all-time windows. */
  getHabitStats: (habitId: string) => HabitStatsBundle;
  // Lists
  lists: UserList[];
  addList: (name: string) => Promise<void>;
  removeList: (id: string) => Promise<void>;
  renameList: (id: string, name: string) => Promise<void>;
  addListItem: (listId: string, title: string) => Promise<void>;
  removeListItem: (listId: string, itemId: string) => Promise<void>;
  toggleListItem: (listId: string, itemId: string) => Promise<void>;
  reorderListItems: (listId: string, fromIndex: number, toIndex: number) => Promise<void>;
  refreshTasks: () => Promise<void>;
  // Loading
  loading: boolean;
}

const TasksContext = createContext<TasksContextValue | null>(null);

export function useTasks() {
  const ctx = useContext(TasksContext);
  if (!ctx) throw new Error("useTasks must be used within TasksProvider");
  return ctx;
}

// ── Constants ──────────────────────────────────────────────────────────

const DAILY_D_TAG = DTAG_DAILY;
const LISTS_D_TAG = DTAG_LISTS;
const LISTS_D_TAG_OLD = DTAG_LISTS_OLD;

/** Keep only the last 400 days of completion data to support year-over-year statistics. */
const COMPLETION_RETENTION_DAYS = 400;

/**
 * Remove completion entries older than COMPLETION_RETENTION_DAYS.
 * This prevents the daily-data event payload from growing indefinitely.
 * Dates are compared lexicographically ("YYYY-MM-DD" strings sort correctly).
 */
function pruneCompletions(completions: Record<string, string[]>): Record<string, string[]> {
  // Calculate the earliest date we want to keep
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - COMPLETION_RETENTION_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10); // "YYYY-MM-DD"

  const pruned: Record<string, string[]> = {};
  for (const [date, ids] of Object.entries(completions)) {
    // ISO date strings are lexicographically comparable, so >= works correctly
    if (date >= cutoffStr) {
      pruned[date] = ids;
    }
  }
  return pruned;
}

// ── Provider ───────────────────────────────────────────────────────────

export function TasksProvider({ children }: { children: ReactNode }) {
  const { pubkey, relays, signEvent, publishEvent, signer } = useNostr();
  const { shouldEncrypt } = useSettings();
  const [habits, setHabits] = useState<DailyHabit[]>([]);
  const [completions, setCompletions] = useState<Record<string, string[]>>({});
  const [lists, setLists] = useState<UserList[]>([]);
  const [loading, setLoading] = useState(true);

  // Refs that always hold the latest state values so action callbacks don't need
  // habits/completions/lists in their dependency arrays. This prevents all action
  // callbacks from being recreated (and their consumers re-rendered) on every state
  // change, and ensures rollback snapshots are taken at invocation time not at
  // callback-creation time.
  const habitsRef = useRef(habits);
  const completionsRef = useRef(completions);
  const listsRef = useRef(lists);
  // Sync refs on render (effects are too late — rapid sequential operations
  // would read stale ref values between setX() and the next effect cycle).
  habitsRef.current = habits;
  completionsRef.current = completions;
  listsRef.current = lists;

  // ── Fetch from relays ────────────────────────────────────────────

  /**
   * Fetch daily habits and task lists from relays.
   * Queries all app-data events for this user, keeps the newest per d-tag,
   * decrypts if needed, and populates local state.
   */
  const fetchData = useCallback(async () => {
    if (!pubkey) return;
    setLoading(true);

    try {
      const rawEvents = await queryEvents(relays, {
        kinds: [KIND_APP_DATA],
        authors: [pubkey],
        "#d": [DAILY_D_TAG, LISTS_D_TAG, LISTS_D_TAG_OLD],
      });

      // Keep the most recent event per d-tag
      const seen = new Map<string, { raw: typeof rawEvents[0]; createdAt: number }>();
      for (const raw of rawEvents) {
        const dTag = raw.tags.find((t: string[]) => t[0] === "d")?.[1];
        if (!dTag) continue;
        const existing = seen.get(dTag);
        if (!existing || raw.created_at > existing.createdAt) {
          seen.set(dTag, { raw, createdAt: raw.created_at });
        }
      }

      const nip44Ok = isNip44Available(signer);
      log.info(`fetched ${rawEvents.length} app-data events, d-tags: ${[...seen.keys()].join(", ") || "(none)"}`);

      // Parse daily habits
      const dailyEntry = seen.get(DAILY_D_TAG);
      if (dailyEntry) {
        const dailyRaw = dailyEntry.raw;
        let content = dailyRaw.content;
        if (isEncryptedEvent(dailyRaw.tags) && nip44Ok && signer) {
          try {
            const decrypted = await decryptEvent(pubkey, dailyRaw.content, dailyRaw.kind, DAILY_D_TAG, signer);
            content = decrypted.content;
          } catch (err) { log.warn("daily decrypt failed, using raw", err); }
        }
        try {
          const parsed: DailyData = JSON.parse(content);
          setHabits(parsed.habits || []);
          setCompletions(parsed.completions || {});
        } catch (err) { log.warn("daily data corrupt", err); }
      }

      // Parse lists (check current d-tag, fall back to old d-tag for backwards compat)
      const listsEntry = seen.get(LISTS_D_TAG) || seen.get(LISTS_D_TAG_OLD);
      if (listsEntry) {
        const listsRaw = listsEntry.raw;
        let content = listsRaw.content;
        if (isEncryptedEvent(listsRaw.tags) && nip44Ok && signer) {
          try {
            const decrypted = await decryptEvent(pubkey, listsRaw.content, listsRaw.kind, LISTS_D_TAG, signer);
            content = decrypted.content;
          } catch (err) { log.warn("lists decrypt failed, using raw", err); }
        }
        try {
          const parsed: ListsData = JSON.parse(content);
          setLists(parsed.lists || []);
        } catch (err) { log.warn("lists data corrupt", err); }
      }
    } catch (err) {
      log.error("fetch failed", err);
    } finally {
      setLoading(false);
    }
  }, [pubkey, relays, signer]);

  useEffect(() => {
    if (pubkey) fetchData();
  }, [pubkey, fetchData]);

  // ── Publish helpers ──────────────────────────────────────────────

  /**
   * Serialize and publish the daily habits + completions to relays.
   * Prunes stale completions and optionally NIP-44 encrypts before signing.
   */
  const publishDaily = useCallback(
    async (newHabits: DailyHabit[], newCompletions: Record<string, string[]>) => {
      if (!pubkey) return;
      // Prune old completions before publishing to keep payload small
      const pruned = pruneCompletions(newCompletions);
      const content = JSON.stringify({ habits: newHabits, completions: pruned });
      const tags: string[][] = [["d", DAILY_D_TAG]];

      const encrypt = shouldEncrypt([]);
      let finalTags = tags;
      let finalContent = content;

      if (encrypt && signer) {
        const encrypted = await encryptEvent(pubkey, KIND_APP_DATA, DAILY_D_TAG, tags, content, signer);
        finalTags = encrypted.tags;
        finalContent = encrypted.content;
      }

      const signed = await signEvent({
        kind: KIND_APP_DATA,
        created_at: Math.floor(Date.now() / 1000),
        tags: finalTags,
        content: finalContent,
      });
      await publishEvent(signed);
    },
    [pubkey, signEvent, publishEvent, shouldEncrypt, signer]
  );

  /**
   * Serialize and publish the task lists to relays.
   * Optionally NIP-44 encrypts before signing.
   */
  const publishLists = useCallback(
    async (newLists: UserList[]) => {
      if (!pubkey) return;
      const content = JSON.stringify({ lists: newLists });
      const tags: string[][] = [["d", LISTS_D_TAG]];

      const encrypt = shouldEncrypt([]);
      let finalTags = tags;
      let finalContent = content;

      if (encrypt && signer) {
        const encrypted = await encryptEvent(pubkey, KIND_APP_DATA, LISTS_D_TAG, tags, content, signer);
        finalTags = encrypted.tags;
        finalContent = encrypted.content;
      }

      const signed = await signEvent({
        kind: KIND_APP_DATA,
        created_at: Math.floor(Date.now() / 1000),
        tags: finalTags,
        content: finalContent,
      });
      await publishEvent(signed);
    },
    [pubkey, signEvent, publishEvent, shouldEncrypt, signer]
  );

  // ── Daily habit actions ──────────────────────────────────────────

  const addHabit = useCallback(
    async (title: string) => {
      const habit: DailyHabit = {
        id: generateDTag(),
        title,
        createdAt: Math.floor(Date.now() / 1000),
      };
      const prev = habitsRef.current;
      const next = [...prev, habit];
      setHabits(next);
      try {
        await publishDaily(next, completionsRef.current);
      } catch (err) {
        setHabits(prev);
        log.error("addHabit publish failed, rolling back", err);
      }
    },
    [publishDaily]
  );

  const removeHabit = useCallback(
    async (id: string) => {
      const prev = habitsRef.current;
      const next = prev.filter((h) => h.id !== id);
      setHabits(next);
      try {
        await publishDaily(next, completionsRef.current);
      } catch (err) {
        setHabits(prev);
        log.error("removeHabit publish failed, rolling back", err);
      }
    },
    [publishDaily]
  );

  const renameHabit = useCallback(
    async (id: string, title: string) => {
      const prev = habitsRef.current;
      const next = prev.map((h) => (h.id === id ? { ...h, title } : h));
      setHabits(next);
      try {
        await publishDaily(next, completionsRef.current);
      } catch (err) {
        setHabits(prev);
        log.error("renameHabit publish failed, rolling back", err);
      }
    },
    [publishDaily]
  );

  const toggleHabitCompletion = useCallback(
    async (habitId: string, date: string) => {
      const curCompletions = completionsRef.current;
      const dayCompletions = curCompletions[date] || [];
      const nextDay = dayCompletions.includes(habitId)
        ? dayCompletions.filter((id) => id !== habitId)
        : [...dayCompletions, habitId];
      const prev = curCompletions;
      const next = { ...curCompletions, [date]: nextDay };
      setCompletions(next);
      try {
        await publishDaily(habitsRef.current, next);
      } catch (err) {
        setCompletions(prev);
        log.error("toggleHabitCompletion publish failed, rolling back", err);
      }
    },
    [publishDaily]
  );

  const isHabitDone = useCallback(
    (habitId: string, date: string) => {
      return (completionsRef.current[date] || []).includes(habitId);
    },
    []
  );

  const getHabitStats = useCallback(
    (habitId: string): HabitStatsBundle => {
      const comps = completionsRef.current;
      const habit = habitsRef.current.find((h) => h.id === habitId);
      const createdAt = habit?.createdAt ?? 0;

      const computeForWindow = (days: number | null): HabitStats => {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        // Build the set of dates in this window
        let windowDays: number;
        let startDate: Date;
        if (days === null) {
          // All-time: from habit creation to today
          const created = new Date(createdAt * 1000);
          created.setHours(0, 0, 0, 0);
          windowDays = Math.max(1, Math.floor((today.getTime() - created.getTime()) / 86400000) + 1);
          startDate = created;
        } else {
          startDate = new Date(today);
          startDate.setDate(startDate.getDate() - (days - 1));
          // Cap to habit creation date
          if (createdAt > 0) {
            const created = new Date(createdAt * 1000);
            created.setHours(0, 0, 0, 0);
            if (startDate < created) startDate = created;
          }
          windowDays = Math.max(1, Math.floor((today.getTime() - startDate.getTime()) / 86400000) + 1);
        }

        // Count completions in window
        let completed = 0;
        const d = new Date(startDate);
        for (let i = 0; i < windowDays; i++) {
          const ds = d.toISOString().slice(0, 10);
          if ((comps[ds] || []).includes(habitId)) completed++;
          d.setDate(d.getDate() + 1);
        }

        // Current streak (from today backward)
        let currentStreak = 0;
        const streakDay = new Date(today);
        while (true) {
          const ds = streakDay.toISOString().slice(0, 10);
          if ((comps[ds] || []).includes(habitId)) {
            currentStreak++;
            streakDay.setDate(streakDay.getDate() - 1);
          } else {
            break;
          }
        }

        // Best streak in window
        let bestStreak = 0;
        let streak = 0;
        const scanDay = new Date(startDate);
        for (let i = 0; i < windowDays; i++) {
          const ds = scanDay.toISOString().slice(0, 10);
          if ((comps[ds] || []).includes(habitId)) {
            streak++;
            if (streak > bestStreak) bestStreak = streak;
          } else {
            streak = 0;
          }
          scanDay.setDate(scanDay.getDate() + 1);
        }

        const rate = windowDays > 0 ? Math.round((completed / windowDays) * 100) : 0;
        return { completed, total: windowDays, rate, currentStreak, bestStreak };
      };

      return {
        last7: computeForWindow(7),
        last30: computeForWindow(30),
        last365: computeForWindow(365),
        allTime: computeForWindow(null),
      };
    },
    []
  );

  const reorderHabits = useCallback(
    async (fromIndex: number, toIndex: number) => {
      const prev = habitsRef.current;
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      setHabits(next);
      try {
        await publishDaily(next, completionsRef.current);
      } catch (err) {
        setHabits(prev);
        log.error("reorderHabits publish failed, rolling back", err);
      }
    },
    [publishDaily]
  );

  // ── List actions ─────────────────────────────────────────────────

  const addList = useCallback(
    async (name: string) => {
      const list: UserList = {
        id: generateDTag(),
        name,
        items: [],
        createdAt: Math.floor(Date.now() / 1000),
      };
      const prev = listsRef.current;
      const next = [...prev, list];
      setLists(next);
      try {
        await publishLists(next);
      } catch (err) {
        setLists(prev);
        log.error("addList publish failed, rolling back", err);
      }
    },
    [publishLists]
  );

  const removeList = useCallback(
    async (id: string) => {
      const prev = listsRef.current;
      const next = prev.filter((l) => l.id !== id);
      setLists(next);
      try {
        await publishLists(next);
      } catch (err) {
        setLists(prev);
        log.error("removeList publish failed, rolling back", err);
      }
    },
    [publishLists]
  );

  const renameList = useCallback(
    async (id: string, name: string) => {
      const prev = listsRef.current;
      const next = prev.map((l) => (l.id === id ? { ...l, name } : l));
      setLists(next);
      try {
        await publishLists(next);
      } catch (err) {
        setLists(prev);
        log.error("renameList publish failed, rolling back", err);
      }
    },
    [publishLists]
  );

  const addListItem = useCallback(
    async (listId: string, title: string) => {
      const item: ListItem = {
        id: generateDTag(),
        title,
        done: false,
        createdAt: Math.floor(Date.now() / 1000),
      };
      const prev = listsRef.current;
      const next = prev.map((l) =>
        l.id === listId ? { ...l, items: [...l.items, item] } : l
      );
      setLists(next);
      try {
        await publishLists(next);
      } catch (err) {
        setLists(prev);
        log.error("addListItem publish failed, rolling back", err);
      }
    },
    [publishLists]
  );

  const removeListItem = useCallback(
    async (listId: string, itemId: string) => {
      const prev = listsRef.current;
      const next = prev.map((l) =>
        l.id === listId ? { ...l, items: l.items.filter((i) => i.id !== itemId) } : l
      );
      setLists(next);
      try {
        await publishLists(next);
      } catch (err) {
        setLists(prev);
        log.error("removeListItem publish failed, rolling back", err);
      }
    },
    [publishLists]
  );

  const toggleListItem = useCallback(
    async (listId: string, itemId: string) => {
      const prev = listsRef.current;
      const next = prev.map((l) =>
        l.id === listId
          ? { ...l, items: l.items.map((i) => (i.id === itemId ? { ...i, done: !i.done } : i)) }
          : l
      );
      setLists(next);
      try {
        await publishLists(next);
      } catch (err) {
        setLists(prev);
        log.error("toggleListItem publish failed, rolling back", err);
      }
    },
    [publishLists]
  );

  const reorderListItems = useCallback(
    async (listId: string, fromIndex: number, toIndex: number) => {
      const prev = listsRef.current;
      const next = prev.map((l) => {
        if (l.id !== listId) return l;
        const items = [...l.items];
        const [moved] = items.splice(fromIndex, 1);
        items.splice(toIndex, 0, moved);
        return { ...l, items };
      });
      setLists(next);
      try {
        await publishLists(next);
      } catch (err) {
        setLists(prev);
        log.error("reorderListItems publish failed, rolling back", err);
      }
    },
    [publishLists]
  );

  const contextValue = useMemo(() => ({
    habits,
    completions,
    addHabit,
    removeHabit,
    renameHabit,
    toggleHabitCompletion,
    isHabitDone,
    getHabitStats,
    reorderHabits,
    lists,
    addList,
    removeList,
    renameList,
    addListItem,
    removeListItem,
    toggleListItem,
    reorderListItems,
    refreshTasks: fetchData,
    loading,
  }), [habits, completions, addHabit, removeHabit, renameHabit, toggleHabitCompletion, isHabitDone, getHabitStats, reorderHabits, lists, addList, removeList, renameList, addListItem, removeListItem, toggleListItem, reorderListItems, fetchData, loading]);

  return (
    <TasksContext.Provider
      value={contextValue}
    >
      {children}
    </TasksContext.Provider>
  );
}
