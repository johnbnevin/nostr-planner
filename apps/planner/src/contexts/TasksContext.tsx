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
import { useCalendar } from "./CalendarContext";
import { generateDTag } from "../lib/nostr";
import { logger } from "../lib/logger";

const log = logger("tasks");

// ── Types ─────────────────────────────────────────────────────────────

export interface DailyHabit {
  id: string;
  title: string;
  createdAt: number; // unix seconds
  /** Unix ms of last local mutation; used by multi-device merge. */
  updatedAt?: number;
  /** Tombstone marker. */
  deleted?: boolean;
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
  /** Unix ms of last local mutation; used by multi-device merge. */
  updatedAt?: number;
  /** Tombstone marker. */
  deleted?: boolean;
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
  /** Deleted-habit tombstones kept so cross-device merges respect deletions. */
  habitTombstones: DailyHabit[];
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
  /** Deleted-list tombstones kept so cross-device merges respect deletions. */
  listTombstones: UserList[];
  addList: (name: string) => void;
  removeList: (id: string) => void;
  renameList: (id: string, name: string) => void;
  addListItem: (listId: string, title: string) => void;
  removeListItem: (listId: string, itemId: string) => void;
  toggleListItem: (listId: string, itemId: string) => void;
  reorderListItems: (listId: string, fromIndex: number, toIndex: number) => void;
  refreshTasks: () => Promise<void>;
  /** Replace in-memory tasks state wholesale. Called on snapshot restore. */
  applySnapshot: (habits: DailyHabit[], completions: Record<string, string[]>, lists: UserList[]) => void;
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

/** Debounce delay for the legacy publish timer (ms). Both publishers
 *  are now no-ops (tasks live in the Blossom snapshot only) but the
 *  debounce plumbing stays to preserve call-site semantics. */
const PUBLISH_DEBOUNCE_MS = 1500;

// ── Provider ───────────────────────────────────────────────────────────

export function TasksProvider({ children }: { children: ReactNode }) {
  const { pubkey } = useNostr();
  const { pushUndoEntry } = useCalendar();
  const [habits, setHabits] = useState<DailyHabit[]>([]);
  const [habitTombstones, setHabitTombstones] = useState<DailyHabit[]>([]);
  const [completions, setCompletions] = useState<Record<string, string[]>>({});
  const [lists, setLists] = useState<UserList[]>([]);
  const [listTombstones, setListTombstones] = useState<UserList[]>([]);
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
    // Tasks state (daily habits, completions, lists) is entirely carried
    // by the Blossom snapshot since v1.16.10b — we stopped publishing
    // kind-30078 daily/lists events, so any relay response here would
    // only contain pre-v1.16.10b stale data that would clobber the
    // freshly-loaded snapshot. CalendarApp's loadSnapshot effect calls
    // applyTasksSnapshot with the authoritative values; this hook just
    // has to flip loading off so the rest of the UI unblocks.
    setLoading(false);
  }, [pubkey]);

  useEffect(() => {
    if (pubkey) fetchData();
  }, [pubkey, fetchData]);

  // ── Raw publish helpers (called by debounce, not by actions) ─────

  /**
   * Serialize and publish the daily habits + completions to relays.
   * Prunes stale completions and optionally NIP-44 encrypts before signing.
   */
  // Daily habits and task lists are strictly single-user, private-personal
  // data. In v1.16.4b we moved all private calendar data off the relays
  // (Blossom snapshot is the single source of truth + cross-device sync
  // channel). These tasks publishers were left on the relay path by
  // oversight — each edit was firing an immediate kind-30078 publish to
  // the primary relay, which is exactly the "any change is triggering
  // upload immediately" symptom the autosave debounce couldn't explain.
  //
  // Now they're intentional no-ops: state still updates optimistically
  // via setHabits / setLists, the fingerprint in useAutoBackup picks up
  // the change, and 10 s later the Blossom snapshot upload carries the
  // new state to every device. Signing + encrypting + publishing per
  // keystroke was pure overhead.
  //
  // Signature preserved so the dozens of callers below don't churn; we
  // just skip the relay hop entirely. publishingRef still bumps so any
  // in-flight indicators that watch it behave as before.
  const publishDaily = useCallback(
    async (_newHabits: DailyHabit[], _newCompletions: Record<string, string[]>) => {
      if (!pubkey) return;
      publishingRef.current++;
      try {
        // no relay publish — Blossom snapshot carries the state
      } finally {
        publishingRef.current--;
      }
    },
    [pubkey]
  );

  const publishLists = useCallback(
    async (_newLists: UserList[]) => {
      if (!pubkey) return;
      publishingRef.current++;
      try {
        // no relay publish — Blossom snapshot carries the state
      } finally {
        publishingRef.current--;
      }
    },
    [pubkey]
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

  // Raw setters that do not push undo entries — used for both the initial
  // action and the undo/redo replay.
  const addHabitRaw = useCallback(
    (habit: DailyHabit) => {
      if (habitsRef.current.some((h) => h.id === habit.id)) return;
      setHabits([...habitsRef.current, habit]);
      scheduleDailyPublish();
    },
    [scheduleDailyPublish]
  );
  const removeHabitRaw = useCallback(
    (id: string) => {
      const existing = habitsRef.current.find((h) => h.id === id);
      setHabits(habitsRef.current.filter((h) => h.id !== id));
      if (existing) {
        const tombstone: DailyHabit = { ...existing, deleted: true, updatedAt: Date.now() };
        setHabitTombstones((prev) => [
          ...prev.filter((t) => t.id !== id),
          tombstone,
        ]);
      }
      scheduleDailyPublish();
    },
    [scheduleDailyPublish]
  );
  const renameHabitRaw = useCallback(
    (id: string, title: string) => {
      setHabits(habitsRef.current.map((h) => (h.id === id ? { ...h, title } : h)));
      scheduleDailyPublish();
    },
    [scheduleDailyPublish]
  );

  const addHabit = useCallback(
    (title: string) => {
      const habit: DailyHabit = {
        id: generateDTag(),
        title,
        createdAt: Math.floor(Date.now() / 1000),
      };
      addHabitRaw(habit);
      pushUndoEntry({
        description: `Add habit "${title}"`,
        undo: async () => removeHabitRaw(habit.id),
        redo: async () => addHabitRaw(habit),
      });
    },
    [addHabitRaw, removeHabitRaw, pushUndoEntry]
  );

  const removeHabit = useCallback(
    (id: string) => {
      const snapshot = habitsRef.current.find((h) => h.id === id);
      if (!snapshot) return;
      removeHabitRaw(id);
      pushUndoEntry({
        description: `Remove habit "${snapshot.title}"`,
        undo: async () => addHabitRaw(snapshot),
        redo: async () => removeHabitRaw(id),
      });
    },
    [addHabitRaw, removeHabitRaw, pushUndoEntry]
  );

  const renameHabit = useCallback(
    (id: string, title: string) => {
      const snapshot = habitsRef.current.find((h) => h.id === id);
      if (!snapshot || snapshot.title === title) return;
      const priorTitle = snapshot.title;
      renameHabitRaw(id, title);
      pushUndoEntry({
        description: `Rename habit "${priorTitle}" → "${title}"`,
        undo: async () => renameHabitRaw(id, priorTitle),
        redo: async () => renameHabitRaw(id, title),
      });
    },
    [renameHabitRaw, pushUndoEntry]
  );

  const setHabitCompletionRaw = useCallback(
    (habitId: string, date: string, done: boolean) => {
      const curCompletions = completionsRef.current;
      const dayCompletions = curCompletions[date] || [];
      const has = dayCompletions.includes(habitId);
      if (done === has) return;
      const nextDay = done
        ? [...dayCompletions, habitId]
        : dayCompletions.filter((id) => id !== habitId);
      setCompletions({ ...curCompletions, [date]: nextDay });
      scheduleDailyPublish();
    },
    [scheduleDailyPublish]
  );

  const toggleHabitCompletion = useCallback(
    (habitId: string, date: string) => {
      const curCompletions = completionsRef.current;
      const wasDone = (curCompletions[date] || []).includes(habitId);
      const habitTitle = habitsRef.current.find((h) => h.id === habitId)?.title || "habit";
      setHabitCompletionRaw(habitId, date, !wasDone);
      pushUndoEntry({
        description: wasDone ? `Uncomplete "${habitTitle}"` : `Complete "${habitTitle}"`,
        undo: async () => setHabitCompletionRaw(habitId, date, wasDone),
        redo: async () => setHabitCompletionRaw(habitId, date, !wasDone),
      });
    },
    [setHabitCompletionRaw, pushUndoEntry]
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
      addListRaw(list);
      pushUndoEntry({
        description: `Add list "${name}"`,
        undo: async () => removeListRaw(list.id),
        redo: async () => addListRaw(list),
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Raw helpers defined below
    [pushUndoEntry]
  );

  const addListRaw = useCallback(
    (list: UserList) => {
      if (listsRef.current.some((l) => l.id === list.id)) return;
      setLists([...listsRef.current, list]);
      scheduleListsPublish();
    },
    [scheduleListsPublish]
  );

  const removeListRaw = useCallback(
    (id: string) => {
      const existing = listsRef.current.find((l) => l.id === id);
      setLists(listsRef.current.filter((l) => l.id !== id));
      if (existing) {
        const tombstone: UserList = { ...existing, deleted: true, updatedAt: Date.now() };
        setListTombstones((prev) => [
          ...prev.filter((t) => t.id !== id),
          tombstone,
        ]);
      }
      scheduleListsPublish();
    },
    [scheduleListsPublish]
  );

  const renameListRaw = useCallback(
    (id: string, name: string) => {
      setLists(listsRef.current.map((l) => (l.id === id ? { ...l, name } : l)));
      scheduleListsPublish();
    },
    [scheduleListsPublish]
  );

  const removeList = useCallback(
    (id: string) => {
      const snapshot = listsRef.current.find((l) => l.id === id);
      if (!snapshot) return;
      removeListRaw(id);
      pushUndoEntry({
        description: `Remove list "${snapshot.name}"`,
        undo: async () => addListRaw(snapshot),
        redo: async () => removeListRaw(id),
      });
    },
    [addListRaw, removeListRaw, pushUndoEntry]
  );

  const renameList = useCallback(
    (id: string, name: string) => {
      const snapshot = listsRef.current.find((l) => l.id === id);
      if (!snapshot || snapshot.name === name) return;
      const priorName = snapshot.name;
      renameListRaw(id, name);
      pushUndoEntry({
        description: `Rename list "${priorName}" → "${name}"`,
        undo: async () => renameListRaw(id, priorName),
        redo: async () => renameListRaw(id, name),
      });
    },
    [renameListRaw, pushUndoEntry]
  );

  const addListItemRaw = useCallback(
    (listId: string, item: ListItem) => {
      const next = listsRef.current.map((l) =>
        l.id === listId && !l.items.some((i) => i.id === item.id)
          ? { ...l, items: [...l.items, item] }
          : l
      );
      setLists(next);
      scheduleListsPublish();
    },
    [scheduleListsPublish]
  );

  const removeListItemRaw = useCallback(
    (listId: string, itemId: string) => {
      const next = listsRef.current.map((l) =>
        l.id === listId ? { ...l, items: l.items.filter((i) => i.id !== itemId) } : l
      );
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
      addListItemRaw(listId, item);
      pushUndoEntry({
        description: `Add "${title}"`,
        undo: async () => removeListItemRaw(listId, item.id),
        redo: async () => addListItemRaw(listId, item),
      });
    },
    [addListItemRaw, removeListItemRaw, pushUndoEntry]
  );

  const removeListItem = useCallback(
    (listId: string, itemId: string) => {
      const list = listsRef.current.find((l) => l.id === listId);
      const snapshot = list?.items.find((i) => i.id === itemId);
      if (!snapshot) return;
      removeListItemRaw(listId, itemId);
      pushUndoEntry({
        description: `Remove "${snapshot.title}"`,
        undo: async () => addListItemRaw(listId, snapshot),
        redo: async () => removeListItemRaw(listId, itemId),
      });
    },
    [addListItemRaw, removeListItemRaw, pushUndoEntry]
  );

  const setListItemDoneRaw = useCallback(
    (listId: string, itemId: string, done: boolean) => {
      const next = listsRef.current.map((l) =>
        l.id === listId
          ? { ...l, items: l.items.map((i) => (i.id === itemId ? { ...i, done } : i)) }
          : l
      );
      setLists(next);
      scheduleListsPublish();
    },
    [scheduleListsPublish]
  );

  const toggleListItem = useCallback(
    (listId: string, itemId: string) => {
      const list = listsRef.current.find((l) => l.id === listId);
      const item = list?.items.find((i) => i.id === itemId);
      if (!item) return;
      const wasDone = item.done;
      const itemTitle = item.title || "item";
      setListItemDoneRaw(listId, itemId, !wasDone);
      pushUndoEntry({
        description: wasDone ? `Uncheck "${itemTitle}"` : `Check "${itemTitle}"`,
        undo: async () => setListItemDoneRaw(listId, itemId, wasDone),
        redo: async () => setListItemDoneRaw(listId, itemId, !wasDone),
      });
    },
    [setListItemDoneRaw, pushUndoEntry]
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
    habitTombstones,
    completions,
    addHabit,
    removeHabit,
    renameHabit,
    toggleHabitCompletion,
    isHabitDone,
    getHabitStats,
    reorderHabits,
    lists,
    listTombstones,
    addList,
    removeList,
    renameList,
    addListItem,
    removeListItem,
    toggleListItem,
    reorderListItems,
    refreshTasks: fetchData,
    applySnapshot: (h: DailyHabit[], c: Record<string, string[]>, l: UserList[]) => {
      // Same tombstone split logic as CalendarContext — live items go to
      // the rendered state, tombstones into their own array so cross-device
      // merges can respect deletions.
      const now = Date.now();
      const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
      const liveH: DailyHabit[] = [];
      const tombH: DailyHabit[] = [];
      for (const hab of h) {
        if (hab.deleted) {
          if (now - (hab.updatedAt ?? 0) < TOMBSTONE_TTL_MS) tombH.push(hab);
        } else liveH.push(hab);
      }
      const liveL: UserList[] = [];
      const tombL: UserList[] = [];
      for (const lst of l) {
        if (lst.deleted) {
          if (now - (lst.updatedAt ?? 0) < TOMBSTONE_TTL_MS) tombL.push(lst);
        } else liveL.push(lst);
      }
      setHabits(liveH);
      setHabitTombstones(tombH);
      setCompletions(c);
      setLists(liveL);
      setListTombstones(tombL);
    },
    loading,
  }), [habits, habitTombstones, completions, addHabit, removeHabit, renameHabit, toggleHabitCompletion, isHabitDone, getHabitStats, reorderHabits, lists, listTombstones, addList, removeList, renameList, addListItem, removeListItem, toggleListItem, reorderListItems, fetchData, loading]);

  return (
    <TasksContext.Provider
      value={contextValue}
    >
      {children}
    </TasksContext.Provider>
  );
}
