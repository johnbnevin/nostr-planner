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
 *
 * **Debounced publishing:** State updates are instant (optimistic UI), but
 * relay publishes are debounced — rapid clicks coalesce into a single write.
 * The debounce window is 1.5 s; on unmount any pending write flushes immediately.
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

// ── Types ─────────────────────────────────────────────────────────────

export interface DailyHabit {
  id: string;
  title: string;
  createdAt: number; // unix seconds
}

interface DailyData {
  habits: DailyHabit[];
  completions: Record<string, string[]>;
}

export interface ListItem {
  id: string;
  title: string;
  done: boolean;
  createdAt: number; // unix seconds
}

export interface UserList {
  id: string;
  name: string;
  items: ListItem[];
  createdAt: number; // unix seconds
}

interface ListsData {
  lists: UserList[];
}

interface HabitStats {
  completed: number;
  total: number;
  rate: number;
  currentStreak: number;
  bestStreak: number;
}

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
  addHabit: (title: string) => void;
  removeHabit: (id: string) => void;
  renameHabit: (id: string, title: string) => void;
  toggleHabitCompletion: (habitId: string, date: string) => void;
  isHabitDone: (habitId: string, date: string) => boolean;
  reorderHabits: (fromIndex: number, toIndex: number) => void;
  /** Compute statistics for a habit across 7d, 30d, 365d, and all-time windows. */
  getHabitStats: (habitId: string) => HabitStatsBundle;
  // Lists
  lists: UserList[];
  addList: (name: string) => void;
  removeList: (id: string) => void;
  renameList: (id: string, name: string) => void;
  addListItem: (listId: string, title: string) => void;
  removeListItem: (listId: string, itemId: string) => void;
  toggleListItem: (listId: string, itemId: string) => void;
  reorderListItems: (listId: string, fromIndex: number, toIndex: number) => void;
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

/** Debounce delay for relay publishes (ms). */
const PUBLISH_DEBOUNCE_MS = 1500;

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

  // Tracks in-flight publishes. While > 0, fetchData() skips overwriting
  // local state — the relay may not have received the latest write yet, so
  // fetching would clobber the optimistic update and cause green dots to
  // disappear momentarily.
  const publishingRef = useRef(0);

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

    // If a publish is in-flight, skip this fetch — the relay may not have
    // the latest data yet and overwriting optimistic state would cause
    // completions to flicker (green dots disappearing then reappearing).
    if (publishingRef.current > 0) {
      log.info("skipping fetch — publish in-flight");
      return;
    }

    setLoading(true);

    try {
      const rawEvents = await queryEvents(relays, {
        kinds: [KIND_APP_DATA],
        authors: [pubkey],
        "#d": [DAILY_D_TAG, LISTS_D_TAG, LISTS_D_TAG_OLD],
      });

      // Re-check after the async gap — a publish may have started while
      // we were waiting on the relay query.
      if (publishingRef.current > 0) {
        log.info("skipping state update — publish started during fetch");
        setLoading(false);
        return;
      }

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

  // ── Raw publish helpers (called by debounce, not by actions) ─────

  /**
   * Serialize and publish the daily habits + completions to relays.
   * Prunes stale completions and optionally NIP-44 encrypts before signing.
   */
  const publishDaily = useCallback(
    async (newHabits: DailyHabit[], newCompletions: Record<string, string[]>) => {
      if (!pubkey) return;
      publishingRef.current++;
      try {
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
      } finally {
        publishingRef.current--;
      }
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
      publishingRef.current++;
      try {
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
      } finally {
        publishingRef.current--;
      }
    },
    [pubkey, signEvent, publishEvent, shouldEncrypt, signer]
  );

  // ── Debounced publish scheduling ────────────────────────────────
  //
  // Actions update React state immediately (optimistic UI), then call
  // scheduleDailyPublish() / scheduleListsPublish() which resets a
  // debounce timer. When the timer fires it reads the latest state
  // from refs and does one publish. Rapid clicks (e.g. checking off
  // 5 habits) coalesce into a single relay write.

  const dailyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushDaily = useCallback(() => {
    if (dailyTimerRef.current !== null) {
      clearTimeout(dailyTimerRef.current);
      dailyTimerRef.current = null;
    }
    publishDaily(habitsRef.current, completionsRef.current).catch((err) =>
      log.error("debounced daily publish failed", err)
    );
  }, [publishDaily]);

  const flushLists = useCallback(() => {
    if (listsTimerRef.current !== null) {
      clearTimeout(listsTimerRef.current);
      listsTimerRef.current = null;
    }
    publishLists(listsRef.current).catch((err) =>
      log.error("debounced lists publish failed", err)
    );
  }, [publishLists]);

  const scheduleDailyPublish = useCallback(() => {
    if (dailyTimerRef.current !== null) clearTimeout(dailyTimerRef.current);
    dailyTimerRef.current = setTimeout(flushDaily, PUBLISH_DEBOUNCE_MS);
  }, [flushDaily]);

  const scheduleListsPublish = useCallback(() => {
    if (listsTimerRef.current !== null) clearTimeout(listsTimerRef.current);
    listsTimerRef.current = setTimeout(flushLists, PUBLISH_DEBOUNCE_MS);
  }, [flushLists]);

  // Flush pending writes on unmount (e.g. navigating away)
  useEffect(() => {
    return () => {
      if (dailyTimerRef.current !== null) flushDaily();
      if (listsTimerRef.current !== null) flushLists();
    };
  }, [flushDaily, flushLists]);

  // ── Daily habit actions ──────────────────────────────────────────

  const addHabit = useCallback(
    (title: string) => {
      const habit: DailyHabit = {
        id: generateDTag(),
        title,
        createdAt: Math.floor(Date.now() / 1000),
      };
      const next = [...habitsRef.current, habit];
      setHabits(next);
      scheduleDailyPublish();
    },
    [scheduleDailyPublish]
  );

  const removeHabit = useCallback(
    (id: string) => {
      const next = habitsRef.current.filter((h) => h.id !== id);
      setHabits(next);
      scheduleDailyPublish();
    },
    [scheduleDailyPublish]
  );

  const renameHabit = useCallback(
    (id: string, title: string) => {
      const next = habitsRef.current.map((h) => (h.id === id ? { ...h, title } : h));
      setHabits(next);
      scheduleDailyPublish();
    },
    [scheduleDailyPublish]
  );

  const toggleHabitCompletion = useCallback(
    (habitId: string, date: string) => {
      const curCompletions = completionsRef.current;
      const dayCompletions = curCompletions[date] || [];
      const nextDay = dayCompletions.includes(habitId)
        ? dayCompletions.filter((id) => id !== habitId)
        : [...dayCompletions, habitId];
      const next = { ...curCompletions, [date]: nextDay };
      setCompletions(next);
      scheduleDailyPublish();
    },
    [scheduleDailyPublish]
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

        // Current streak (from today backwards)
        let currentStreak = 0;
        const streakDate = new Date(today);
        while (true) {
          const ds = streakDate.toISOString().slice(0, 10);
          if (!(comps[ds] || []).includes(habitId)) break;
          currentStreak++;
          streakDate.setDate(streakDate.getDate() - 1);
        }

        // Best streak (scan entire window)
        let bestStreak = 0;
        let runStreak = 0;
        const scanDate = new Date(startDate);
        for (let i = 0; i < windowDays; i++) {
          const ds = scanDate.toISOString().slice(0, 10);
          if ((comps[ds] || []).includes(habitId)) {
            runStreak++;
            if (runStreak > bestStreak) bestStreak = runStreak;
          } else {
            runStreak = 0;
          }
          scanDate.setDate(scanDate.getDate() + 1);
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
    (fromIndex: number, toIndex: number) => {
      const next = [...habitsRef.current];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      setHabits(next);
      scheduleDailyPublish();
    },
    [scheduleDailyPublish]
  );

  // ── List actions ─────────────────────────────────────────────────

  const addList = useCallback(
    (name: string) => {
      const list: UserList = {
        id: generateDTag(),
        name,
        items: [],
        createdAt: Math.floor(Date.now() / 1000),
      };
      const next = [...listsRef.current, list];
      setLists(next);
      scheduleListsPublish();
    },
    [scheduleListsPublish]
  );

  const removeList = useCallback(
    (id: string) => {
      const next = listsRef.current.filter((l) => l.id !== id);
      setLists(next);
      scheduleListsPublish();
    },
    [scheduleListsPublish]
  );

  const renameList = useCallback(
    (id: string, name: string) => {
      const next = listsRef.current.map((l) => (l.id === id ? { ...l, name } : l));
      setLists(next);
      scheduleListsPublish();
    },
    [scheduleListsPublish]
  );

  const addListItem = useCallback(
    (listId: string, title: string) => {
      const item: ListItem = {
        id: generateDTag(),
        title,
        done: false,
        createdAt: Math.floor(Date.now() / 1000),
      };
      const next = listsRef.current.map((l) =>
        l.id === listId ? { ...l, items: [...l.items, item] } : l
      );
      setLists(next);
      scheduleListsPublish();
    },
    [scheduleListsPublish]
  );

  const removeListItem = useCallback(
    (listId: string, itemId: string) => {
      const next = listsRef.current.map((l) =>
        l.id === listId ? { ...l, items: l.items.filter((i) => i.id !== itemId) } : l
      );
      setLists(next);
      scheduleListsPublish();
    },
    [scheduleListsPublish]
  );

  const toggleListItem = useCallback(
    (listId: string, itemId: string) => {
      const next = listsRef.current.map((l) =>
        l.id === listId
          ? { ...l, items: l.items.map((i) => (i.id === itemId ? { ...i, done: !i.done } : i)) }
          : l
      );
      setLists(next);
      scheduleListsPublish();
    },
    [scheduleListsPublish]
  );

  const reorderListItems = useCallback(
    (listId: string, fromIndex: number, toIndex: number) => {
      const next = listsRef.current.map((l) => {
        if (l.id !== listId) return l;
        const items = [...l.items];
        const [moved] = items.splice(fromIndex, 1);
        items.splice(toIndex, 0, moved);
        return { ...l, items };
      });
      setLists(next);
      scheduleListsPublish();
    },
    [scheduleListsPublish]
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
