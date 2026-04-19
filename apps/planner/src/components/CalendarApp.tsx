import { useState, useEffect, useRef, useCallback } from "react";
import { useNostr } from "../contexts/NostrContext";
import { useCalendar } from "../contexts/CalendarContext";
import { useSharing } from "../contexts/SharingContext";
import { useSettings } from "../contexts/SettingsContext";
import { useTasks } from "../contexts/TasksContext";
import { loadSnapshot, watchPointer, buildSnapshot, type Snapshot } from "../lib/backup";
import { mergeSnapshots } from "../lib/merge";
import { Header } from "./Header";
import type { MobileTab } from "./Header";
import { Sidebar } from "./Sidebar";
import { MonthView } from "./MonthView";
import { UpcomingView } from "./UpcomingView";
import { DailyHabitsView } from "./DailyView";
import { ListsView } from "./ListView";
import { EventModal } from "./EventModal";
import { EventDetailModal } from "./EventDetailModal";
import { DayDetailModal } from "./DayDetailModal";
import { BackupPanel } from "./BackupPanel";
import { SettingsPanel } from "./SettingsPanel";
import { ImportReviewModal } from "./ImportReviewModal";
import { SharingModal } from "./SharingModal";
import { ShareViewModal } from "./ShareViewModal";
import { useApplyInitialViewHash, parseViewHash } from "../hooks/useViewShare";
import { useNotifications } from "../hooks/useNotifications";
import { useAutoBackup } from "../hooks/useAutoBackup";
import { useDigest } from "../hooks/useDigest";
import { useTauriScheduledNotifications } from "../hooks/useTauriScheduledNotifications";
import { decodeInvitePayload } from "../lib/sharing";
import { onPublishFailure } from "../lib/relay";
import type { CalendarEvent, RecurrenceFreq } from "../lib/nostr";
import type { ParsedIcalEvent } from "../lib/ical";

/**
 * Top-level app shell rendered after authentication. Orchestrates the entire
 * planner UI: header, sidebar, calendar views, and all modal overlays.
 *
 * Key responsibilities:
 * - **Auto-restore:** On first login, if no events exist locally, searches for
 *   a Blossom backup on relays and transparently restores events + settings.
 * - **View switching:** Supports month/week/day calendar views plus daily-habits
 *   and to-do-list panels. Desktop shows a multi-panel layout; mobile shows a
 *   single-tab layout with a bottom tab bar.
 * - **Invite handling:** Detects `#invite=...` URL hashes (shared calendar
 *   invites) and shows an accept/dismiss banner.
 * - **Recurring event extension:** Allows adding more instances to an existing
 *   recurrence series by computing the next date from the last event.
 * - **First-run setup:** Shows a welcome modal to name the first calendar when
 *   no calendars exist yet.
 */
export function CalendarApp() {
  const { pubkey, profile, logout, signer, relays } = useNostr();
  const { viewMode, setViewMode, eventsLoading, calendars, events, forceFullRefresh, getSeriesEvents, needsCalendarSetup, completeCalendarSetup, decryptionErrors, syncError, applySnapshot: applyCalendarSnapshot, lastRemoteSha, setLastRemoteSha, eventTombstones, undoDepth, redoDepth, undo, redo } = useCalendar();
  const { acceptInviteLink } = useSharing();
  const { showDaily, showLists, setShowDaily, setShowLists, savedViewMode, setSavedViewMode, getSettings, restoreSettings, primaryRelay } = useSettings();
  const { alerts, dismiss } = useNotifications();
  const { habits, completions, lists, applySnapshot: applyTasksSnapshot, habitTombstones, listTombstones } = useTasks();
  const { phase: backupPhase, countdown: saveCountdown, lastError: backupError, backupNow } = useAutoBackup();
  const [syncingNow, setSyncingNow] = useState(false);
  useDigest();
  useTauriScheduledNotifications();
  // Apply URL-hash view state once calendars have loaded. Enables the
  // "Add to Home Screen" widget-URL flow — open a pre-filtered view via
  // a bookmarked link.
  useApplyInitialViewHash();

  // ── Restore the Blossom snapshot on login ──────────────────────────
  // Single entry point for "login → restore" — applies calendar, tasks
  // and settings state in one pass so you don't see a flash of empty
  // events while tasks populate separately.
  const restoredRef = useRef(false);
  const [syncedFromOther, setSyncedFromOther] = useState(false);
  useEffect(() => {
    if (!pubkey) { restoredRef.current = false; return; }
    if (restoredRef.current) return;
    if (!signer?.nip44) return;
    restoredRef.current = true;
    (async () => {
      try {
        const snap = await loadSnapshot(pubkey, relays, signer.nip44);
        if (!snap) return;
        applyCalendarSnapshot(snap.events, snap.calendars);
        applyTasksSnapshot(snap.habits, snap.completions, snap.lists);
        restoreSettings(snap.settings);
        setLastRemoteSha(snap._sha256);
      } catch (err) {
        console.warn("snapshot restore failed:", err);
      }
    })();
  }, [pubkey, signer, relays, applyCalendarSnapshot, applyTasksSnapshot, restoreSettings, setLastRemoteSha]);

  // ── Multi-device sync: watch for snapshot pointer updates from other
  //    devices signed into the same npub. On new pointer, fetch + merge +
  //    apply, silently (with a small toast). ────────────────────────────
  //
  // The watchPointer callback must read CURRENT state each time it fires,
  // not snapshots taken when the subscription opened — so we thread state
  // through a ref that's updated every render.
  const mergeStateRef = useRef({ calendars, events, habits, completions, lists, getSettings, eventTombstones, habitTombstones, listTombstones });
  mergeStateRef.current = { calendars, events, habits, completions, lists, getSettings, eventTombstones, habitTombstones, listTombstones };

  // Tracks the event the user currently has open in the edit / detail
  // modal, so the remote-snapshot merge can detect a cross-device
  // conflict and show a banner. A ref (not state) keeps the merge
  // callback identity stable so it doesn't thrash watchPointer.
  const openEventRef = useRef<{ dTag: string; createdAt: number } | null>(null);

  // Mirror lastRemoteSha into a ref so watchPointer can seed its
  // initial sha without us re-subscribing on every save.
  const lastRemoteShaRef = useRef(lastRemoteSha);
  useEffect(() => { lastRemoteShaRef.current = lastRemoteSha; }, [lastRemoteSha]);

  // Apply a remote snapshot into local state via merge. Shared by the
  // live watchPointer subscription and the manual "Sync now" button.
  const applyRemoteSnapshot = useCallback((remote: Snapshot & { _sha256?: string }) => {
    const s = mergeStateRef.current;
    const local = buildSnapshot({
      calendars: s.calendars, events: s.events,
      eventTombstones: s.eventTombstones,
      habits: s.habits, completions: s.completions, lists: s.lists,
      habitTombstones: s.habitTombstones, listTombstones: s.listTombstones,
      settings: s.getSettings(),
    });
    const merged = mergeSnapshots(local, remote);
    applyCalendarSnapshot(merged.events, merged.calendars);
    applyTasksSnapshot(merged.habits, merged.completions, merged.lists);
    restoreSettings(merged.settings);
    if (remote._sha256) setLastRemoteSha(remote._sha256);
    setSyncedFromOther(true);
    setTimeout(() => setSyncedFromOther(false), 2500);

    // Conflict check: if the user is currently editing / viewing an
    // event that just got a newer version from another device, flag
    // it so they can reload the modal instead of silently clobbering.
    const open = openEventRef.current;
    if (open) {
      const remoteVersion = merged.events.find((e) => e.dTag === open.dTag);
      if (remoteVersion && remoteVersion.createdAt > open.createdAt) {
        setOpenEventConflict(remoteVersion);
      }
    }
  }, [applyCalendarSnapshot, applyTasksSnapshot, restoreSettings, setLastRemoteSha]);

  useEffect(() => {
    if (!pubkey || !signer?.nip44) return;
    // primaryRelay is unused in the body but included in deps so the
    // subscription tears down + reopens when the user switches primary.
    void primaryRelay;
    const close = watchPointer(pubkey, relays, signer.nip44, lastRemoteShaRef, applyRemoteSnapshot);
    return close;
  }, [pubkey, signer, relays, applyRemoteSnapshot, primaryRelay]);

  // Manual "Sync now" action — wired to a header button. Flushes the
  // local pending save (so the other device sees us) and pulls the
  // latest remote pointer + merges if different. Useful when the live
  // subscription is stalled or a user wants instant confirmation after
  // editing on another device.
  const syncNow = useCallback(async () => {
    if (syncingNow) return;
    setSyncingNow(true);
    try {
      if (backupPhase === "dirty" || backupPhase === "error") {
        try { await backupNow(); } catch { /* non-fatal */ }
      }
      if (pubkey && signer?.nip44) {
        try {
          const remote = await loadSnapshot(pubkey, relays, signer.nip44);
          if (remote) applyRemoteSnapshot(remote);
        } catch { /* non-fatal */ }
      }
    } finally {
      setSyncingNow(false);
    }
  }, [syncingNow, backupPhase, backupNow, pubkey, signer, relays, applyRemoteSnapshot]);

  // Auto-sync on return: when the tab becomes visible or the window
  // regains focus, flush any pending local changes and pull the latest
  // remote snapshot. This is what the user expects after switching
  // between devices — pick up the other device's edits automatically.
  // Debounced so rapid OS-level focus flicker doesn't spam.
  const syncNowRef = useRef(syncNow);
  syncNowRef.current = syncNow;
  useEffect(() => {
    if (!pubkey) return;
    let lastAt = 0;
    const trigger = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastAt < 5_000) return;
      lastAt = now;
      void syncNowRef.current();
    };
    document.addEventListener("visibilitychange", trigger);
    window.addEventListener("focus", trigger);
    return () => {
      document.removeEventListener("visibilitychange", trigger);
      window.removeEventListener("focus", trigger);
    };
  }, [pubkey]);
  // Guards to prevent re-running one-shot effects across re-renders
  const autoRestoreAttempted = useRef(false);
  // Refs to the scrollable calendar containers so we can reset them to the
  // top on login — otherwise the app restores whatever scroll position
  // WeekView/DayView computed on mount, hiding the "Loading events…" banner.
  const mobileScrollRef = useRef<HTMLDivElement | null>(null);
  const desktopScrollRef = useRef<HTMLDivElement | null>(null);

  // Reset the view's scroll position to the top on login AND when event
  // loading transitions — we've seen the scroll container land at the
  // bottom on phone/web after login, which hid the "Loading events…"
  // banner. Scroll again once events have loaded since the view may
  // have grown in the meantime.
  useEffect(() => {
    if (!pubkey) return;
    const reset = () => {
      mobileScrollRef.current?.scrollTo(0, 0);
      desktopScrollRef.current?.scrollTo(0, 0);
    };
    requestAnimationFrame(reset);
    requestAnimationFrame(() => requestAnimationFrame(reset));
  }, [pubkey, eventsLoading]);
  const [autoRestoreComplete, setAutoRestoreComplete] = useState(false);
  const viewModeInitialized = useRef(false);

  // Reset auto-restore guard on logout so it runs again on next login.
  // Without this, logging out and back in within the same session would skip
  // auto-restore on the second login.
  useEffect(() => {
    if (!pubkey) {
      autoRestoreAttempted.current = false;
      viewModeInitialized.current = false;
      setAutoRestoreComplete(false);
    }
  }, [pubkey]);

  // Restore the user's last-used view mode (month/week/day) from persisted settings
  useEffect(() => {
    if (!viewModeInitialized.current && savedViewMode) {
      setViewMode(savedViewMode);
      viewModeInitialized.current = true;
    }
  }, [savedViewMode, setViewMode]);

  // Persist viewMode changes to settings
  useEffect(() => {
    if (viewModeInitialized.current) {
      setSavedViewMode(viewMode);
    }
  }, [viewMode, setSavedViewMode]);
  const [showEventModal, setShowEventModal] = useState(false);
  const [showBackup, setShowBackup] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showShareView, setShowShareView] = useState(false);
  const [sharingCalDTag, setSharingCalDTag] = useState<string | null>(null);
  const [setupName, setSetupName] = useState("");
  const [setupSubmitting, setSetupSubmitting] = useState(false);
  const [returnToEventModal, setReturnToEventModal] = useState(false);
  // Pending invite from URL hash: { encoded, title }
  const [pendingInvite, setPendingInvite] = useState<{ encoded: string; title: string } | null>(null);
  const [acceptingInvite, setAcceptingInvite] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [importData, setImportData] = useState<{ events: ParsedIcalEvent[]; fileName: string } | null>(null);
  const [showMobileSidebar, setShowMobileSidebar] = useState(false);
  const [editEvent, setEditEvent] = useState<CalendarEvent | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(
    null
  );
  // Remote-edit conflict banner — populated when an incoming merge would
  // change the event the user has open in the edit-modal or detail-modal.
  // Carries the fresh remote copy so "Reload" can swap the open modal to
  // it without a round-trip.
  const [openEventConflict, setOpenEventConflict] = useState<CalendarEvent | null>(null);
  // Keep openEventRef in sync with whichever modal-bound event is active.
  useEffect(() => {
    const active = editEvent ?? selectedEvent ?? null;
    openEventRef.current = active
      ? { dTag: active.dTag, createdAt: active.createdAt }
      : null;
    // Clear the conflict banner when no event is open or the user
    // switches to a different event.
    if (!active || (openEventConflict && openEventConflict.dTag !== active.dTag)) {
      setOpenEventConflict(null);
    }
  }, [editEvent, selectedEvent, openEventConflict]);
  const [dayDetailDate, setDayDetailDate] = useState<Date | null>(null);
  const [prefillDate, setPrefillDate] = useState<Date | null>(null);
  // Seed mobileTab from the URL-hash "focus" / "view" param if present —
  // the manifest shortcuts (Upcoming / Calendar / Daily / Lists) rely on
  // this to open at the right view on mobile.
  const [mobileTab, setMobileTab] = useState<MobileTab>(() => {
    const parsed = parseViewHash(window.location.hash);
    if (parsed.focus === "daily") return "daily";
    if (parsed.focus === "lists") return "todos";
    if (parsed.focus === "upcoming") return "upcoming";
    if (parsed.focus === "calendar") return "calendar";
    if (parsed.view === "upcoming") return "upcoming";
    if (parsed.view === "month") return "calendar";
    return viewMode === "upcoming" ? "upcoming" : "calendar";
  });
  const [publishError, setPublishError] = useState<string | null>(null);

  // Subscribe to relay publish failures for user-facing feedback
  useEffect(() => {
    const unsub = onPublishFailure((error) => {
      setPublishError(error.message);
      // Auto-dismiss after 6 seconds
      setTimeout(() => setPublishError(null), 6000);
    });
    return unsub;
  }, []);

  // Global Ctrl/Cmd+Z (undo) and Ctrl/Cmd+Shift+Z / Ctrl+Y (redo) keybindings.
  // Skips when focus is in a text input or textarea so users can still
  // undo their typing natively.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;
      const ctrl = e.ctrlKey || e.metaKey;
      if (!ctrl) return;
      const key = e.key.toLowerCase();
      const isUndo = key === "z" && !e.shiftKey;
      const isRedo = (key === "z" && e.shiftKey) || key === "y";
      if (isUndo && undoDepth > 0) {
        e.preventDefault();
        void undo();
      } else if (isRedo && redoDepth > 0) {
        e.preventDefault();
        void redo();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [undo, undoDepth, redo, redoDepth]);

  // Sync mobileTab when viewMode changes from desktop controls, but preserve
  // mobile-only tabs (daily/todos) that don't map to a calendar viewMode.
  useEffect(() => {
    setMobileTab((prev) => {
      if (prev === "daily" || prev === "todos") return prev;
      return viewMode === "upcoming" ? "upcoming" : "calendar";
    });
  }, [viewMode]);

  const handleMobileTabChange = (tab: MobileTab) => {
    setMobileTab(tab);
    if (tab === "upcoming") setViewMode("upcoming");
    else if (tab === "calendar") setViewMode("month");
  };

  const [extendSeries, setExtendSeries] = useState<{
    seriesId: string;
    freq: RecurrenceFreq;
    fromDate: Date;
    templateEvent: CalendarEvent;
  } | null>(null);

  // (Removed: legacy auto-restore flow that downloaded the Blossom blob
  // and republished its events to relays. That behavior is obsolete —
  // CalendarContext's login useEffect now loads materialized state from
  // Blossom directly, and private events are Blossom-only so republishing
  // to relays would violate the privacy model. Also fires late and was
  // causing the random "Loading events…" banner minutes into a session.)
  useEffect(() => {
    if (!pubkey || autoRestoreAttempted.current) return;
    autoRestoreAttempted.current = true;
    setAutoRestoreComplete(true);
  }, [pubkey]);

  // Detect shared-calendar invite links in URL hash (#invite=...).
  // The payload is base64-encoded and contains the calendar dTag + AES key.
  useEffect(() => {
    const hash = window.location.hash;
    if (!hash.startsWith("#invite=")) return;
    const encoded = hash.slice("#invite=".length);
    const payload = decodeInvitePayload(encoded);
    if (payload) {
      setPendingInvite({ encoded, title: payload.t || "Shared Calendar" });
    }
  }, []);

  const handleAcceptInvite = async () => {
    if (!pendingInvite) return;
    setAcceptingInvite(true);
    setInviteError(null);
    try {
      await acceptInviteLink(pendingInvite.encoded);
      // Clear the hash from URL without reloading
      history.replaceState(null, "", window.location.pathname + window.location.search);
      setPendingInvite(null);
      await forceFullRefresh();
    } catch (err) {
      setInviteError(`Failed to accept invite: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setAcceptingInvite(false);
    }
  };

  const handleNewEvent = (date?: Date) => {
    // Block event creation until calendars are actually loaded — without
    // a target calendar the save can't pick a NIP-52 kind or encryption
    // mode, and the event would silently vanish.
    if (eventsLoading || calendars.length === 0) return;
    setEditEvent(null);
    setPrefillDate(date || null);
    setExtendSeries(null);
    setShowEventModal(true);
  };

  const handleEditEvent = (event: CalendarEvent) => {
    setSelectedEvent(null);
    setEditEvent(event);
    setPrefillDate(null);
    setExtendSeries(null);
    setShowEventModal(true);
  };

  // Right-click clipboard: copy an event then paste onto any date to create
  // a brand-new duplicate. Stored in React state so context menus, the
  // EventDetailModal, and the paste handler all see the same source.
  const [copiedEvent, setCopiedEvent] = useState<CalendarEvent | null>(null);
  const [prefillEvent, setPrefillEvent] = useState<CalendarEvent | null>(null);

  const handleDuplicateEvent = (source: CalendarEvent, targetDate?: Date) => {
    if (eventsLoading || calendars.length === 0) return;
    const shiftedStart = targetDate
      ? source.allDay
        ? new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate())
        : new Date(
            targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(),
            source.start.getHours(), source.start.getMinutes()
          )
      : source.start;
    const shiftedEnd = source.end
      ? new Date(shiftedStart.getTime() + (source.end.getTime() - source.start.getTime()))
      : undefined;
    setSelectedEvent(null);
    setEditEvent(null);
    setExtendSeries(null);
    setPrefillDate(null);
    setPrefillEvent({
      ...source,
      id: "",
      dTag: "",
      seriesId: undefined,
      start: shiftedStart,
      end: shiftedEnd,
    });
    setShowEventModal(true);
  };

  /** Extend a recurring series by generating more instances after the last one.
   *  Infers frequency from recurrence metadata or from the gap between events. */
  const handleExtendSeries = (event: CalendarEvent) => {
    if (!event.seriesId) return;

    // Find last event in the series to compute next start date
    const seriesEvents = getSeriesEvents(event.seriesId);
    const lastEvent = seriesEvents[seriesEvents.length - 1];

    // Determine frequency from the recurrence metadata on the first event,
    // or infer from spacing between first two events
    let freq: RecurrenceFreq = "weekly";
    const firstWithRecurrence = seriesEvents.find((e) => e.recurrence);
    if (firstWithRecurrence?.recurrence) {
      freq = firstWithRecurrence.recurrence.freq;
    } else if (seriesEvents.length >= 2) {
      const gap =
        seriesEvents[1].start.getTime() - seriesEvents[0].start.getTime();
      const dayMs = 86400000;
      if (gap <= dayMs * 1.5) freq = "daily";
      else if (gap <= dayMs * 8) freq = "weekly";
      else if (gap <= dayMs * 35) freq = "monthly";
      else freq = "yearly";
    }

    // Compute the next date after the last instance
    const fromDate = new Date(lastEvent.start);
    if (freq === "daily") fromDate.setDate(fromDate.getDate() + 1);
    else if (freq === "weekly") fromDate.setDate(fromDate.getDate() + 7);
    else if (freq === "monthly") fromDate.setMonth(fromDate.getMonth() + 1);
    else if (freq === "yearly")
      fromDate.setFullYear(fromDate.getFullYear() + 1);

    setSelectedEvent(null);
    setEditEvent(null);
    setPrefillDate(null);
    setExtendSeries({
      seriesId: event.seriesId,
      freq,
      fromDate,
      templateEvent: lastEvent,
    });
    setShowEventModal(true);
  };

  const handleEventClick = (event: CalendarEvent) => {
    setSelectedEvent(event);
  };

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col safe-area-pad">
      <Header
        pubkey={pubkey!}
        profile={profile}
        backupPhase={backupPhase}
        saveCountdown={saveCountdown}
        backupError={backupError}
        onBackupNow={backupNow}
        onSyncNow={syncNow}
        syncingNow={syncingNow}
        onLogout={logout}
        onNewEvent={() => handleNewEvent()}
        canAddEvent={!eventsLoading && calendars.length > 0}
        onSettings={() => setShowSettings(true)}
        showDaily={showDaily}
        showLists={showLists}
        onToggleDaily={() => setShowDaily(!showDaily)}
        onToggleLists={() => setShowLists(!showLists)}
        mobileTab={mobileTab}
        onMobileTabChange={handleMobileTabChange}
        onCalendars={() => setShowMobileSidebar(true)}
      />

      {pendingInvite && (
        <div className="bg-indigo-50 border-b border-indigo-200 px-4 py-2 flex items-center justify-between gap-3">
          <span className="text-sm text-indigo-800">
            You've been invited to join <strong>{pendingInvite.title}</strong>
          </span>
          <div className="flex gap-2 flex-shrink-0">
            <button
              onClick={handleAcceptInvite}
              disabled={acceptingInvite}
              className="px-3 py-1 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50"
            >
              {acceptingInvite ? "Accepting…" : "Accept"}
            </button>
            <button
              onClick={() => {
                setPendingInvite(null);
                history.replaceState(null, "", window.location.pathname + window.location.search);
              }}
              className="px-3 py-1 text-xs text-indigo-600 hover:text-indigo-800"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {inviteError && (
        <div className="bg-red-50 border-b border-red-200 px-4 py-2 flex items-center justify-between gap-3">
          <span className="text-sm text-red-800">{inviteError}</span>
          <button
            onClick={() => setInviteError(null)}
            className="px-3 py-1 text-xs text-red-600 hover:text-red-800 flex-shrink-0"
          >
            Dismiss
          </button>
        </div>
      )}

      {alerts.length > 0 && (
        <div className="border-b border-amber-200">
          {alerts.map((a) => (
            <div
              key={a.event.dTag}
              className="bg-amber-50 px-4 py-2 flex items-center justify-between gap-3"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-amber-600 text-lg flex-shrink-0">&#128276;</span>
                <span className="text-sm font-medium text-amber-900 truncate">
                  {a.message}
                </span>
              </div>
              <button
                onClick={() => dismiss(a.event.dTag)}
                className="text-xs text-amber-600 hover:text-amber-800 flex-shrink-0 px-2 py-1 rounded hover:bg-amber-100"
              >
                Dismiss
              </button>
            </div>
          ))}
        </div>
      )}

      {syncError && (
        <div className="bg-red-50 border-b border-red-200 px-4 py-2 text-sm text-red-800 text-center">
          {syncError}
        </div>
      )}

      {publishError && (
        <div className="bg-amber-50 border-b border-amber-200 px-4 py-2 text-sm text-amber-800 text-center cursor-pointer" onClick={() => setPublishError(null)}>
          Failed to save: {publishError}
        </div>
      )}

      {syncedFromOther && (
        <div className="bg-emerald-50 border-b border-emerald-200 px-4 py-1.5 text-xs text-emerald-800 text-center">
          Synced from another device
        </div>
      )}

      {/* Remote-edit conflict banner — another device edited the event
          this user has open in the modal. "Reload" swaps the modal to
          the remote version; "Keep mine" dismisses so their edits win
          on save. */}
      {openEventConflict && (
        <div className="bg-amber-50 border-b border-amber-200 px-4 py-2 flex items-center justify-between gap-3">
          <span className="text-sm text-amber-900 truncate">
            &#9888; <strong>"{openEventConflict.title}"</strong> was updated on another device. Your changes will win when you save.
          </span>
          <div className="flex gap-2 flex-shrink-0">
            <button
              onClick={() => {
                const fresh = openEventConflict;
                setOpenEventConflict(null);
                if (editEvent && editEvent.dTag === fresh.dTag) {
                  // Close and re-open the edit modal with fresh data.
                  setEditEvent(null);
                  requestAnimationFrame(() => setEditEvent(fresh));
                } else if (selectedEvent && selectedEvent.dTag === fresh.dTag) {
                  setSelectedEvent(fresh);
                }
              }}
              className="px-3 py-1 text-xs bg-amber-600 text-white rounded hover:bg-amber-700"
            >
              Reload
            </button>
            <button
              onClick={() => setOpenEventConflict(null)}
              className="px-3 py-1 text-xs text-amber-700 hover:text-amber-900"
            >
              Keep mine
            </button>
          </div>
        </div>
      )}

      {decryptionErrors > 0 && (
        <div className="bg-amber-50 border-b border-amber-200 px-4 py-2 text-sm text-amber-800 text-center">
          {decryptionErrors} event{decryptionErrors > 1 ? "s" : ""} could not be decrypted. If using a remote signer, approve any pending NIP-44 requests and retry.
        </div>
      )}

      {/* Copy/paste status bar — visible while a copied event is held.
          Right-click a day cell in month view to paste it. */}
      {copiedEvent && (
        <div className="bg-primary-50 border-b border-primary-200 px-4 py-1.5 text-xs text-primary-800 flex items-center justify-between">
          <span>Copied "{copiedEvent.title}" — right-click a day to paste.</span>
          <button onClick={() => setCopiedEvent(null)} className="text-primary-700 hover:text-primary-900 font-medium">
            Clear
          </button>
        </div>
      )}

      {/* ===== MOBILE LAYOUT (< sm): single focused tab ===== */}
      <div className="lg:hidden flex-1 overflow-y-auto" ref={mobileScrollRef}>
        {eventsLoading && (
          <div className="flex items-center justify-center gap-2 py-1.5 bg-primary-50 text-primary-700 text-xs">
            <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-primary-600" />
            Loading events…
          </div>
        )}
        {mobileTab === "upcoming" && (
          <main className="p-3">
            <UpcomingView
              onEventClick={handleEventClick}
              onNewEvent={() => handleNewEvent()}
            />
          </main>
        )}
        {mobileTab === "calendar" && (
          <main className="p-3">
            <MonthView
              onEventClick={handleEventClick}
              onDateClick={handleNewEvent}
              onDayDetail={(d) => setDayDetailDate(d)}
              onEventCopy={setCopiedEvent}
              onDayPaste={(d) => copiedEvent && handleDuplicateEvent(copiedEvent, d)}
              hasCopied={!!copiedEvent}
            />
          </main>
        )}
        {mobileTab === "daily" && (
          <div className="p-3">
            <DailyHabitsView />
          </div>
        )}
        {mobileTab === "todos" && (
          <div className="p-3">
            <ListsView />
          </div>
        )}
      </div>

      {/* ===== DESKTOP LAYOUT (sm+): multi-panel ===== */}
      <div className="hidden lg:flex flex-1 overflow-hidden">
        <Sidebar
          onImportParsed={(evts, name) => setImportData({ events: evts, fileName: name })}
          onShareCalendar={(dTag) => setSharingCalDTag(dTag)}
        />

        {/* Main content area: Daily (left) | Calendar (center) | Todo (right) */}
        <div className="flex-1 flex overflow-hidden">
          {/* Daily panel — left side */}
          {showDaily && (
            <div className="w-80 shrink-0 border-r border-gray-200 overflow-y-auto bg-white p-3">
              <DailyHabitsView />
            </div>
          )}

          {/* Calendar — center, always visible */}
          <main className="flex-1 p-4 overflow-y-auto min-w-0" ref={desktopScrollRef}>
            {eventsLoading && (
              <div className="flex items-center justify-center gap-2 py-1.5 mb-2 bg-primary-50 text-primary-700 text-sm rounded-lg">
                <div className="animate-spin rounded-full h-3.5 w-3.5 border-b-2 border-primary-600" />
                Loading events…
              </div>
            )}
            {viewMode === "upcoming" && (
              <UpcomingView
                onEventClick={handleEventClick}
                onNewEvent={() => handleNewEvent()}
              />
            )}
            {viewMode === "month" && (
              <MonthView
                onEventClick={handleEventClick}
                onDateClick={handleNewEvent}
                onDayDetail={(d) => setDayDetailDate(d)}
                onEventCopy={setCopiedEvent}
                onDayPaste={(d) => copiedEvent && handleDuplicateEvent(copiedEvent, d)}
                hasCopied={!!copiedEvent}
              />
            )}
          </main>

          {/* To Do Lists panel — right side */}
          {showLists && (
            <div className="w-80 shrink-0 border-l border-gray-200 overflow-y-auto bg-white p-3">
              <ListsView />
            </div>
          )}
        </div>
      </div>

      {showEventModal && (
        <EventModal
          event={editEvent}
          prefillDate={prefillDate}
          prefillEvent={prefillEvent || undefined}
          extendSeries={extendSeries || undefined}
          onClose={() => {
            setShowEventModal(false);
            setEditEvent(null);
            setPrefillDate(null);
            setPrefillEvent(null);
            setExtendSeries(null);
          }}
          onOpenSettings={() => {
            setReturnToEventModal(true);
            setShowSettings(true);
          }}
        />
      )}

      {selectedEvent && (
        <EventDetailModal
          event={selectedEvent}
          onClose={() => setSelectedEvent(null)}
          onEdit={handleEditEvent}
          onExtendSeries={handleExtendSeries}
          onDuplicate={handleDuplicateEvent}
        />
      )}

      {dayDetailDate && (
        <DayDetailModal
          date={dayDetailDate}
          onClose={() => setDayDetailDate(null)}
          onEventClick={(e) => {
            setDayDetailDate(null);
            setSelectedEvent(e);
          }}
          onNewEvent={(d) => {
            setDayDetailDate(null);
            handleNewEvent(d);
          }}
        />
      )}

      {importData && (
        <ImportReviewModal
          parsed={importData.events}
          fileName={importData.fileName}
          onClose={() => setImportData(null)}
          onBackup={() => {
            setImportData(null);
            setShowBackup(true);
          }}
        />
      )}

      {showMobileSidebar && (
        <Sidebar
          onClose={() => setShowMobileSidebar(false)}
          onImportParsed={(evts, name) => {
            setShowMobileSidebar(false);
            setImportData({ events: evts, fileName: name });
          }}
          onShareCalendar={(dTag) => {
            setShowMobileSidebar(false);
            setSharingCalDTag(dTag);
          }}
        />
      )}

      {showShareView && <ShareViewModal onClose={() => setShowShareView(false)} />}
      {showBackup && <BackupPanel onClose={() => setShowBackup(false)} />}
      {showSettings && <SettingsPanel
        onBackup={() => setShowBackup(true)}
        onShareView={() => setShowShareView(true)}
        onClose={() => {
          setShowSettings(false);
          if (returnToEventModal) {
            setReturnToEventModal(false);
            setShowEventModal(true);
          }
        }}
      />}
      {sharingCalDTag && (
        <SharingModal calDTag={sharingCalDTag} onClose={() => setSharingCalDTag(null)} />
      )}

      {needsCalendarSetup && !eventsLoading && autoRestoreComplete && calendars.length === 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-1">Welcome to Planner</h2>
            <p className="text-sm text-gray-500 mb-4">
              Choose a name for your first calendar.
            </p>
            <input
              type="text"
              autoFocus
              placeholder="e.g. Personal, Work, Life…"
              value={setupName}
              onChange={(e) => setSetupName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && setupName.trim()) {
                  setSetupSubmitting(true);
                  completeCalendarSetup(setupName).finally(() => setSetupSubmitting(false));
                }
              }}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-400 mb-4"
            />
            <button
              onClick={() => {
                setSetupSubmitting(true);
                completeCalendarSetup(setupName).finally(() => setSetupSubmitting(false));
              }}
              disabled={!setupName.trim() || setupSubmitting}
              className="w-full px-4 py-2.5 bg-primary-600 text-white rounded-xl text-sm font-medium hover:bg-primary-700 disabled:opacity-50"
            >
              {setupSubmitting ? "Creating…" : "Create Calendar"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
