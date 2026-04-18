/**
 * SettingsContext — user preferences persisted per-pubkey in localStorage.
 *
 * Tracks the following setting categories:
 * - **Public calendars** — which calendar d-tags the user has opted to publish
 *   as plaintext NIP-52 kinds (all others are encrypted via kind 30078).
 * - **Panel visibility** — whether the daily summary, todo, and lists panels
 *   are shown in the UI.
 * - **View mode** — last-used calendar view (month / week / day).
 * - **Auto-backup** — whether Blossom backup runs automatically.
 * - **Notifications** — in-app or push, with configurable lead times.
 * - **Daily digest** — email-based daily agenda digest with timezone + hour.
 *
 * Settings are stored in localStorage under `nostr-planner-settings-<pubkey>`
 * as a JSON blob and restored on login. The {@link persist} helper always
 * reads the current stored value before merging overrides, so stale React
 * closure values never silently overwrite other settings.
 *
 * @module SettingsContext
 */
import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  type ReactNode,
} from "react";
import { useNostr } from "./NostrContext";
import { isNip44Available } from "../lib/crypto";
import { logger } from "../lib/logger";
import { lsSet } from "../lib/storage";

const log = logger("settings");

/** Delivery channel for event reminders. */
export type NotifyMethod = "in-app" | "push";

/**
 * Notification timing preferences.
 *
 * @property enabled       - Whether reminders are active at all.
 * @property method        - `"in-app"` toast or `"push"` notification.
 * @property allDayMinsBefore - Minutes before an all-day event to fire (default 480 = 8 h).
 * @property timedMinsBefore  - Minutes before a timed event to fire (default 15).
 */
interface NotificationSettings {
  enabled: boolean;
  method: NotifyMethod;
  allDayMinsBefore: number;
  timedMinsBefore: number;
}

const DEFAULT_NOTIFY: NotificationSettings = {
  enabled: false,
  method: "in-app",
  allDayMinsBefore: 480, // 8 hours
  timedMinsBefore: 15,
};

/**
 * Shape of the value exposed by {@link SettingsProvider}.
 *
 * Consumers access this via the {@link useSettings} hook.
 */
interface SettingsContextValue {
  /** Calendar d-tags explicitly marked public */
  publicCalendars: Set<string>;
  /** Toggle a calendar between public (plaintext NIP-52) and private (encrypted kind 30078). */
  togglePublicCalendar: (dTag: string) => void;
  /** Whether an event assigned to these calendars should be encrypted */
  shouldEncrypt: (calendarRefs: string[]) => boolean;
  /** Whether the app can publish to the given calendars (public always OK, private needs NIP-44) */
  canPublish: (calendarRefs?: string[]) => boolean;
  /** Whether NIP-44 is available in the extension */
  nip44Available: boolean;
  /** Panel visibility toggles */
  showDaily: boolean;
  showTodo: boolean;
  showLists: boolean;
  setShowDaily: (v: boolean) => void;
  setShowTodo: (v: boolean) => void;
  setShowLists: (v: boolean) => void;
  /** Persisted view mode preference */
  savedViewMode: "upcoming" | "month";
  setSavedViewMode: (v: "upcoming" | "month") => void;
  /** Notification settings */
  notification: NotificationSettings;
  setNotification: (v: Partial<NotificationSettings>) => void;
  /** Auto-backup toggle */
  autoBackup: boolean;
  setAutoBackup: (v: boolean) => void;
  /** Snapshot all settings for backup */
  getSettings: () => PersistedSettings;
  /** Bulk-restore settings from backup */
  restoreSettings: (s: PersistedSettings) => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

/**
 * Hook to access the settings context. Must be called inside a {@link SettingsProvider}.
 *
 * @throws If called outside the provider tree.
 */
export function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx)
    throw new Error("useSettings must be used within SettingsProvider");
  return ctx;
}

/**
 * JSON-serialisable snapshot of all user settings.
 *
 * Used for localStorage persistence and backup/restore. The index signature
 * ensures forward compatibility: if a future version adds new fields, restoring
 * an older snapshot will not throw.
 */
export interface PersistedSettings {
  publicCalendars: string[];
  showDaily?: boolean;
  showTodo?: boolean;
  showLists?: boolean;
  viewMode?: "upcoming" | "month";
  autoBackup?: boolean;
  notification?: NotificationSettings;
  [key: string]: unknown; // forward-compat: restore won't break on future fields
}

/**
 * Provider that manages user preferences. Reads from and writes to localStorage
 * keyed by the current pubkey, so each user gets independent settings.
 *
 * Must be nested inside {@link NostrProvider} (uses `useNostr` for the pubkey).
 */
export function SettingsProvider({ children }: { children: ReactNode }) {
  const { pubkey, signer } = useNostr();
  const [publicCalendars, setPublicCalendars] = useState<Set<string>>(
    new Set()
  );
  const [nip44Available, setNip44Available] = useState(false);
  const [showDaily, setShowDailyState] = useState(false);
  const [showTodo, setShowTodoState] = useState(false);
  const [showLists, setShowListsState] = useState(false);
  const [savedViewMode, setSavedViewModeState] = useState<"upcoming" | "month">("month");
  const [autoBackup, setAutoBackupState] = useState(true);
  const [notification, setNotificationState] = useState<NotificationSettings>(DEFAULT_NOTIFY);

  // Re-check NIP-44 support whenever the signer changes (login/logout/extension
  // upgrade) or the window regains focus (the user may have installed an extension
  // while the app was open). Both `pubkey` and `signer` are deps because signer
  // can change independently when a NIP-07 extension is upgraded.
  useEffect(() => {
    const check = () => {
      const available = isNip44Available(signer);
      log.debug("NIP-44 available:", available);
      setNip44Available(available);
    };
    check();
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, [pubkey, signer]);

  // Restore settings from localStorage when the pubkey changes (i.e. on login).
  // Reset to defaults on logout so a subsequent login always starts clean and
  // never briefly shows the previous user's settings.
  useEffect(() => {
    if (!pubkey) {
      // Intentional synchronous setState on logout: resetting multiple pieces of
      // state when the user logs out is unavoidable without a full context remount.
      // The cascading renders are bounded and acceptable given this is a rare event.
      /* eslint-disable react-hooks/set-state-in-effect */
      setPublicCalendars(new Set());
      setShowDailyState(false);
      setShowTodoState(false);
      setShowListsState(false);
      setSavedViewModeState("month");
      setAutoBackupState(true);
      setNotificationState(DEFAULT_NOTIFY);
      /* eslint-enable react-hooks/set-state-in-effect */
      return;
    }
    const storageKey = `nostr-planner-settings-${pubkey}`;
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        log.debug("restoring settings for", pubkey.slice(0, 8));
        const parsed: PersistedSettings = JSON.parse(raw);
        setPublicCalendars(new Set(parsed.publicCalendars ?? []));
        setShowDailyState(parsed.showDaily ?? false);
        setShowTodoState(parsed.showTodo ?? false);
        setShowListsState(parsed.showLists ?? false);
        // Migrate removed views from pre-v1.12: "week" and "day" collapse to
        // "month" (the closest analog), everything else preserved.
        if (parsed.viewMode) {
          const v = parsed.viewMode as string;
          const migrated = v === "week" || v === "day" ? "month" : v;
          if (migrated === "upcoming" || migrated === "month") {
            setSavedViewModeState(migrated);
          }
        }
        setAutoBackupState(parsed.autoBackup ?? true);
        if (parsed.notification) setNotificationState({ ...DEFAULT_NOTIFY, ...parsed.notification });
      } else {
        log.debug("no saved settings for", pubkey.slice(0, 8), "— using defaults");
      }
    } catch {
      // Corrupted settings, use defaults
      log.warn("corrupted settings in localStorage, falling back to defaults");
    }
  }, [pubkey]);

  // Persist to localStorage — always reads the current stored value first so
  // that individual setter callbacks (which capture only their own slice of
  // state) never accidentally overwrite unrelated settings with stale values.
  const persist = useCallback(
    (overrides: Partial<PersistedSettings> & { publicCalendarsSet?: Set<string> } = {}) => {
      if (!pubkey) return;
      const key = `nostr-planner-settings-${pubkey}`;

      // Read-modify-write: start from whatever is already on disk.
      let existing: PersistedSettings = {
        publicCalendars: [],
      };
      try {
        const raw = localStorage.getItem(key);
        if (raw) existing = JSON.parse(raw);
      } catch { /* use defaults */ }

      // Merge overrides on top of existing, falling back to safe defaults.
      const data: PersistedSettings = {
        ...existing,
        publicCalendars: overrides.publicCalendarsSet
          ? [...overrides.publicCalendarsSet]
          : overrides.publicCalendars ?? existing.publicCalendars ?? [],
        showDaily: overrides.showDaily ?? existing.showDaily ?? false,
        showTodo: overrides.showTodo ?? existing.showTodo ?? false,
        showLists: overrides.showLists ?? existing.showLists ?? false,
        viewMode: overrides.viewMode ?? existing.viewMode ?? "month",
        autoBackup: overrides.autoBackup ?? existing.autoBackup ?? true,
        notification: overrides.notification ?? existing.notification ?? DEFAULT_NOTIFY,
      };
      lsSet(key, JSON.stringify(data));
      log.debug("settings persisted for", pubkey.slice(0, 8));
    },
    [pubkey]
  );

  const togglePublicCalendar = useCallback(
    (dTag: string) => {
      // Compute next value before setState so persist() is not called inside a
      // state updater (React StrictMode invokes updaters twice for debugging).
      const next = new Set(publicCalendars);
      if (next.has(dTag)) next.delete(dTag);
      else next.add(dTag);
      setPublicCalendars(next);
      persist({ publicCalendarsSet: next });
    },
    [persist, publicCalendars]
  );

  const setShowDaily = useCallback(
    (v: boolean) => {
      setShowDailyState(v);
      persist({ showDaily: v });
    },
    [persist]
  );

  const setShowTodo = useCallback(
    (v: boolean) => {
      setShowTodoState(v);
      persist({ showTodo: v });
    },
    [persist]
  );

  const setShowLists = useCallback(
    (v: boolean) => {
      setShowListsState(v);
      persist({ showLists: v });
    },
    [persist]
  );

  const setSavedViewMode = useCallback(
    (v: "upcoming" | "month") => {
      setSavedViewModeState(v);
      persist({ viewMode: v });
    },
    [persist]
  );

  const setAutoBackup = useCallback(
    (v: boolean) => {
      setAutoBackupState(v);
      persist({ autoBackup: v });
    },
    [persist]
  );

  const setNotification = useCallback(
    (v: Partial<NotificationSettings>) => {
      const next = { ...notification, ...v };
      setNotificationState(next);
      persist({ notification: next });
    },
    [persist, notification]
  );

  /** Snapshot all current settings into a plain object suitable for backup. */
  const getSettings = useCallback((): PersistedSettings => ({
    publicCalendars: [...publicCalendars],
    showDaily,
    showTodo,
    showLists,
    viewMode: savedViewMode,
    autoBackup,
    notification,
  }), [publicCalendars, showDaily, showTodo, showLists, savedViewMode, autoBackup, notification]);

  /** Bulk-restore settings from a backup snapshot. Applies each field and persists. */
  const restoreSettings = useCallback(
    (s: PersistedSettings) => {
      log.info("restoring settings from backup snapshot");
      if (s.publicCalendars) setPublicCalendars(new Set(s.publicCalendars));
      if (s.showDaily !== undefined) setShowDailyState(s.showDaily);
      if (s.showTodo !== undefined) setShowTodoState(s.showTodo);
      if (s.showLists !== undefined) setShowListsState(s.showLists);
      if (s.viewMode) setSavedViewModeState(s.viewMode);
      if (s.autoBackup !== undefined) setAutoBackupState(s.autoBackup);
      if (s.notification) setNotificationState({ ...DEFAULT_NOTIFY, ...s.notification });
      persist({
        publicCalendarsSet: s.publicCalendars ? new Set(s.publicCalendars) : undefined,
        showDaily: s.showDaily,
        showTodo: s.showTodo,
        showLists: s.showLists,
        viewMode: s.viewMode,
        autoBackup: s.autoBackup,
        notification: s.notification ? { ...DEFAULT_NOTIFY, ...s.notification } : undefined,
      });
    },
    [persist]
  );

  const shouldEncrypt = useCallback(
    (calendarRefs: string[]): boolean => {
      // If no calendar refs, use default (encrypted)
      if (calendarRefs.length === 0) return true;
      // Encrypted unless ALL assigned calendars are public
      return !calendarRefs.every((ref) => publicCalendars.has(ref));
    },
    [publicCalendars]
  );

  const canPublish = useCallback((calendarRefs: string[] = []): boolean => {
    // Public calendars can always be published to (plaintext NIP-52)
    if (calendarRefs.length > 0 && calendarRefs.every((ref) => publicCalendars.has(ref))) {
      return true;
    }
    // Private calendars require NIP-44 encryption
    return nip44Available;
  }, [nip44Available, publicCalendars]);

  return (
    <SettingsContext.Provider
      value={{
        publicCalendars,
        togglePublicCalendar,
        shouldEncrypt,
        canPublish,
        nip44Available,
        showDaily,
        showTodo,
        showLists,
        setShowDaily,
        setShowTodo,
        setShowLists,
        savedViewMode,
        setSavedViewMode,
        autoBackup,
        setAutoBackup,
        notification,
        setNotification,
        getSettings,
        restoreSettings,
      }}
    >
      {children}
    </SettingsContext.Provider>
  );
}
