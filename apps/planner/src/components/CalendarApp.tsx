import { useState, useEffect, useRef } from "react";
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
import { WeekView } from "./WeekView";
import { DayView } from "./DayView";
import { DailyHabitsView } from "./DailyView";
import { ListsView } from "./ListView";
import { EventModal } from "./EventModal";
import { EventDetailModal } from "./EventDetailModal";
import { BackupPanel } from "./BackupPanel";
import { SettingsPanel } from "./SettingsPanel";
import { ImportReviewModal } from "./ImportReviewModal";
import { SharingModal } from "./SharingModal";
import { useNotifications } from "../hooks/useNotifications";
import { useAutoBackup } from "../hooks/useAutoBackup";
import { useDigest } from "../hooks/useDigest";
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
  const { viewMode, setViewMode, eventsLoading, calendars, events, forceFullRefresh, getSeriesEvents, needsCalendarSetup, completeCalendarSetup, decryptionErrors, syncError, applySnapshot: applyCalendarSnapshot, setLastRemoteSha } = useCalendar();
  const { acceptInviteLink } = useSharing();
  const { showDaily, showLists, setShowDaily, setShowLists, savedViewMode, setSavedViewMode, getSettings, restoreSettings } = useSettings();
  const { alerts, dismiss } = useNotifications();
  const { habits, completions, lists, applySnapshot: applyTasksSnapshot } = useTasks();
  const { phase: backupPhase, countdown: saveCountdown, lastError: backupError, backupNow } = useAutoBackup();
  useDigest();

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
  const mergeStateRef = useRef({ calendars, events, habits, completions, lists, getSettings });
  mergeStateRef.current = { calendars, events, habits, completions, lists, getSettings };
  useEffect(() => {
    if (!pubkey || !signer?.nip44) return;
    const close = watchPointer(pubkey, relays, signer.nip44, null, (remote) => {
      const s = mergeStateRef.current;
      const local = buildSnapshot({
        calendars: s.calendars, events: s.events,
        habits: s.habits, completions: s.completions, lists: s.lists,
        settings: s.getSettings(),
      });
      const merged = mergeSnapshots(local, remote);
      applyCalendarSnapshot(merged.events, merged.calendars);
      applyTasksSnapshot(merged.habits, merged.completions, merged.lists);
      restoreSettings(merged.settings);
      const remoteSha = (remote as Snapshot & { _sha256?: string })._sha256;
      if (remoteSha) setLastRemoteSha(remoteSha);
      setSyncedFromOther(true);
      setTimeout(() => setSyncedFromOther(false), 2500);
    });
    return close;
  }, [pubkey, signer, relays, applyCalendarSnapshot, applyTasksSnapshot, restoreSettings, setLastRemoteSha]);
  // Guards to prevent re-running one-shot effects across re-renders
  const autoRestoreAttempted = useRef(false);
  // Refs to the scrollable calendar containers so we can reset them to the
  // top on login — otherwise the app restores whatever scroll position
  // WeekView/DayView computed on mount, hiding the "Loading events…" banner.
  const mobileScrollRef = useRef<HTMLDivElement | null>(null);
  const desktopScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!pubkey) return;
    // Next frame — let views mount first, then override their scroll.
    requestAnimationFrame(() => {
      mobileScrollRef.current?.scrollTo(0, 0);
      desktopScrollRef.current?.scrollTo(0, 0);
    });
  }, [pubkey]);
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
  const [prefillDate, setPrefillDate] = useState<Date | null>(null);
  const [mobileTab, setMobileTab] = useState<MobileTab>(viewMode);
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

  // Sync mobileTab when viewMode changes from desktop controls, but preserve
  // mobile-only tabs (daily/todos) that don't map to a calendar viewMode.
  useEffect(() => {
    setMobileTab((prev) => {
      if (prev === "daily" || prev === "todos") return prev;
      return viewMode;
    });
  }, [viewMode]);

  const handleMobileTabChange = (tab: MobileTab) => {
    setMobileTab(tab);
    if (tab === "month" || tab === "week" || tab === "day") {
      setViewMode(tab);
    }
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
        onLogout={logout}
        onNewEvent={() => handleNewEvent()}
        canAddEvent={!eventsLoading && calendars.length > 0}
        onBackup={() => setShowBackup(true)}
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

      {decryptionErrors > 0 && (
        <div className="bg-amber-50 border-b border-amber-200 px-4 py-2 text-sm text-amber-800 text-center">
          {decryptionErrors} event{decryptionErrors > 1 ? "s" : ""} could not be decrypted. If using a remote signer, approve any pending NIP-44 requests and retry.
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
        {mobileTab === "month" && (
          <main className="p-3">
            <MonthView
              onEventClick={handleEventClick}
              onDateClick={handleNewEvent}
            />
          </main>
        )}
        {mobileTab === "week" && (
          <main className="p-3">
            <WeekView
              onEventClick={handleEventClick}
              onDateClick={handleNewEvent}
            />
          </main>
        )}
        {mobileTab === "day" && (
          <main className="p-3">
            <DayView
              onEventClick={handleEventClick}
              onTimeClick={handleNewEvent}
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
            {viewMode === "month" && (
              <MonthView
                onEventClick={handleEventClick}
                onDateClick={handleNewEvent}
              />
            )}
            {viewMode === "week" && (
              <WeekView
                onEventClick={handleEventClick}
                onDateClick={handleNewEvent}
              />
            )}
            {viewMode === "day" && (
              <DayView
                onEventClick={handleEventClick}
                onTimeClick={handleNewEvent}
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
          extendSeries={extendSeries || undefined}
          onClose={() => {
            setShowEventModal(false);
            setEditEvent(null);
            setPrefillDate(null);
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

      {showBackup && <BackupPanel onClose={() => setShowBackup(false)} />}
      {showSettings && <SettingsPanel onClose={() => {
        setShowSettings(false);
        if (returnToEventModal) {
          setReturnToEventModal(false);
          setShowEventModal(true);
        }
      }} />}
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
