import type { NostrProfile } from "../contexts/NostrContext";
import { useCalendar } from "../contexts/CalendarContext";
import { useSettings } from "../contexts/SettingsContext";
import {
  ChevronLeft,
  ChevronRight,
  Plus,
  LogOut,
  Settings,
  CalendarCheck,
  CalendarDays,
  List,
  CloudUpload,
  CloudOff,
  CloudAlert,
  Loader,
  Layers,
  Undo2,
  Redo2,
} from "lucide-react";
import { format, addMonths, subMonths } from "date-fns";

/** All possible bottom-tab identifiers on mobile. "upcoming" and "calendar"
 *  map to the CalendarContext viewMode ("upcoming" and "month"); "daily" /
 *  "todos" are app-specific panels with no calendar-view equivalent. */
export type MobileTab = "upcoming" | "calendar" | "daily" | "todos";

/** @see {@link Header} */
interface HeaderProps {
  pubkey: string;
  profile: NostrProfile | null;
  backupPhase: "idle" | "dirty" | "saving" | "error";
  saveCountdown: number | null;
  backupError: string | null;
  onBackupNow: () => Promise<void>;
  onLogout: () => void;
  onNewEvent: () => void;
  canAddEvent: boolean;
  onSettings: () => void;
  showDaily: boolean;
  showLists: boolean;
  onToggleDaily: () => void;
  onToggleLists: () => void;
  mobileTab: MobileTab;
  onMobileTabChange: (tab: MobileTab) => void;
  onCalendars: () => void;
}

/**
 * Sticky top header bar with two distinct layouts rendered via CSS breakpoints:
 *
 * **Desktop (sm+):** Single row with app title, date navigation (back/forward/
 * today), view-mode selector (month/week/day), panel toggles (daily habits,
 * to-do lists), action buttons (new event, refresh, auto-backup, settings),
 * and user profile/logout. Backup/restore and share live inside the settings
 * modal on every platform.
 *
 * **Mobile (<sm):** Three compact rows — (1) app title + global actions,
 * (2) date navigation + new-event button, (3) tab bar for switching views.
 *
 * Also renders:
 * - A **decryption error banner** when NIP-44 decryption fails for some events
 *   (e.g. signer session expired). Shows count + retry button.
 * - An **auto-backup toggle** (cloud icon) that enables/disables periodic
 *   Blossom backups. Shows a spinner while a backup is in progress.
 */
export function Header({
  pubkey,
  profile,
  backupPhase,
  saveCountdown,
  backupError,
  onBackupNow,
  onLogout,
  onNewEvent,
  canAddEvent,
  onSettings,
  showDaily,
  showLists,
  onToggleDaily,
  onToggleLists,
  mobileTab,
  onMobileTabChange,
  onCalendars,
}: HeaderProps) {
  const {
    currentDate,
    setCurrentDate,
    viewMode,
    setViewMode,
    refreshEvents,
    decryptionErrors,
    undo,
    redo,
    undoDepth,
    redoDepth,
    undoPreview,
    redoPreview,
  } = useCalendar();
  const { autoBackup, setAutoBackup } = useSettings();

  const npubShort = `${pubkey.slice(0, 8)}...${pubkey.slice(-4)}`;

  // Navigation only makes sense in the month grid. The upcoming list is
  // always anchored to "now" — nav arrows are hidden in that mode.
  const navigateBack = () => {
    if (viewMode === "month") setCurrentDate(subMonths(currentDate, 1));
  };
  const navigateForward = () => {
    if (viewMode === "month") setCurrentDate(addMonths(currentDate, 1));
  };
  const mobileNavigateBack = () => {
    if (mobileTab === "calendar") setCurrentDate(subMonths(currentDate, 1));
  };
  const mobileNavigateForward = () => {
    if (mobileTab === "calendar") setCurrentDate(addMonths(currentDate, 1));
  };

  const goToday = () => setCurrentDate(new Date());

  const titleText = () => {
    if (viewMode === "upcoming") return "Upcoming";
    return format(currentDate, "MMMM yyyy");
  };

  const mobileTitleText = () => {
    if (mobileTab === "todos") return "To Do Lists";
    if (mobileTab === "daily") return format(currentDate, "EEE, MMM d");
    if (mobileTab === "upcoming") return "Upcoming";
    return format(currentDate, "MMM yyyy");
  };

  const mobileTabs: { id: MobileTab; label: string }[] = [
    { id: "upcoming", label: "Upcoming" },
    { id: "calendar", label: "Calendar" },
    { id: "daily", label: "Daily" },
    { id: "todos", label: "Lists" },
  ];

  return (
    <header className="bg-white border-b border-gray-200 sticky top-0 z-30">
      {/* Decryption error banner — shown when NIP-44 decryption failed for
          one or more events. Common cause: signer session timed out or user
          switched extensions. Retry re-fetches and re-decrypts all events. */}
      {decryptionErrors > 0 && (
        <div className="bg-amber-50 border-b border-amber-200 px-4 py-2 text-sm text-amber-800 flex items-center justify-between">
          <span>{decryptionErrors} event{decryptionErrors > 1 ? "s" : ""} failed to decrypt. Your signer may need to re-authenticate.</span>
          <button onClick={() => refreshEvents()} className="text-amber-700 hover:text-amber-900 font-medium ml-4">Retry</button>
        </div>
      )}
      <div className="max-w-[1600px] mx-auto px-3 sm:px-4">

        {/* ===== DESKTOP LAYOUT (sm+) ===== */}
        <div className="hidden lg:flex items-center justify-between py-3">
          {/* Left: app name */}
          <div className="flex items-center gap-2 min-w-0">
            <CalendarDays className="w-6 h-6 text-primary-600 shrink-0" />
            <h1 className="text-xl font-bold text-primary-700 shrink-0">
              Planner
              <span className="text-xs font-normal text-gray-400 ml-1">{`v${__APP_VERSION__}b`}</span>
            </h1>
          </div>

          {/* Right: navigation + date label + view mode + actions. The
              date-nav chunk only shows in the calendar (month) view — the
              upcoming list is chronological from "now" and has no anchor
              date to step through. */}
          <div className="flex items-center gap-2 shrink-0">
            {viewMode === "month" && (
              <>
                <button
                  onClick={goToday}
                  className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors shrink-0"
                >
                  Today
                </button>

                <div className="flex items-center gap-0.5 shrink-0">
                  <button
                    onClick={navigateBack}
                    className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors"
                    aria-label="Navigate back"
                  >
                    <ChevronLeft className="w-5 h-5" />
                  </button>
                  <button
                    onClick={navigateForward}
                    className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors"
                    aria-label="Navigate forward"
                  >
                    <ChevronRight className="w-5 h-5" />
                  </button>
                </div>
              </>
            )}

            <h2 className="text-lg font-semibold text-gray-800 truncate mr-1">
              {titleText()}
            </h2>

            {/* View mode selector */}
            <div className="flex border border-gray-300 rounded-lg overflow-hidden">
              {([
                { id: "upcoming", label: "Upcoming" },
                { id: "month", label: "Calendar" },
              ] as const).map(({ id, label }) => (
                <button
                  key={id}
                  onClick={() => setViewMode(id)}
                  className={`px-3 py-1.5 text-sm transition-colors ${
                    viewMode === id
                      ? "bg-primary-600 text-white"
                      : "hover:bg-gray-50"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* Panel toggles */}
            <div className="flex items-center gap-1 ml-1">
              <button
                onClick={onToggleDaily}
                className={`flex items-center gap-1 px-2.5 py-1.5 text-sm rounded-lg border transition-colors ${
                  showDaily
                    ? "bg-emerald-50 border-emerald-300 text-emerald-700"
                    : "border-gray-300 text-gray-500 hover:bg-gray-50"
                }`}
                title="Toggle Daily Habits"
              >
                <CalendarCheck className="w-4 h-4" />
                <span className="text-xs">Daily</span>
              </button>
              <button
                onClick={onToggleLists}
                className={`flex items-center gap-1 px-2.5 py-1.5 text-sm rounded-lg border transition-colors ${
                  showLists
                    ? "bg-violet-50 border-violet-300 text-violet-700"
                    : "border-gray-300 text-gray-500 hover:bg-gray-50"
                }`}
                title="Toggle To Do Lists"
              >
                <List className="w-4 h-4" />
                <span className="text-xs">To Do Lists</span>
              </button>
            </div>

            <button
              onClick={onNewEvent}
              disabled={!canAddEvent}
              title={canAddEvent ? "" : "Loading calendars…"}
              className="flex items-center gap-1 bg-primary-600 hover:bg-primary-700 text-white px-3 py-1.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Plus className="w-4 h-4" />
              <span>Event</span>
            </button>

            <button
              onClick={() => void undo()}
              disabled={undoDepth === 0}
              className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              title={undoDepth > 0 ? `Undo: ${undoPreview} (Ctrl+Z)` : "Nothing to undo"}
            >
              <Undo2 className="w-4 h-4 text-gray-500" />
            </button>
            <button
              onClick={() => void redo()}
              disabled={redoDepth === 0}
              className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              title={redoDepth > 0 ? `Redo: ${redoPreview} (Ctrl+Shift+Z)` : "Nothing to redo"}
            >
              <Redo2 className="w-4 h-4 text-gray-500" />
            </button>

            <button
              onClick={() => {
                const next = !autoBackup;
                setAutoBackup(next);
                if (next) onBackupNow();
              }}
              className={`relative p-1.5 rounded-lg transition-colors ${
                !autoBackup ? "hover:bg-gray-100"
                : backupPhase === "idle" ? "bg-emerald-50 hover:bg-emerald-100"
                : "bg-red-50 hover:bg-red-100"
              }`}
              title={
                !autoBackup ? "Auto-backup off"
                : backupPhase === "saving" ? "Saving backup…"
                : backupPhase === "error"
                  ? `Save failed: ${backupError ?? "unknown error"}${saveCountdown !== null ? ` — retry in ${saveCountdown}s` : ""}`
                : backupPhase === "dirty" && saveCountdown !== null ? `Unsaved — autosave in ${saveCountdown}s`
                : "Auto-backup on"
              }
            >
              {!autoBackup ? (
                <CloudOff className="w-4 h-4 text-gray-400" />
              ) : backupPhase === "saving" ? (
                <Loader className="w-4 h-4 animate-spin text-red-600" />
              ) : backupPhase === "error" ? (
                <CloudAlert className="w-4 h-4 text-red-600" />
              ) : backupPhase === "dirty" ? (
                <CloudUpload className="w-4 h-4 text-red-600" />
              ) : (
                <CloudUpload className="w-4 h-4 text-emerald-600" />
              )}

              {/* Countdown badge in the corner for dirty/error phases. */}
              {autoBackup && saveCountdown !== null && (backupPhase === "dirty" || backupPhase === "error") && (
                <span className="absolute -top-0.5 -right-0.5 min-w-[1rem] h-4 px-0.5 rounded-full bg-red-600 text-white text-[9px] font-semibold leading-4 text-center tabular-nums">
                  {saveCountdown}
                </span>
              )}
            </button>

            <button
              onClick={onSettings}
              className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors"
              title="Settings"
            >
              <Settings className="w-4 h-4 text-gray-500" />
            </button>

            <div className="flex items-center gap-2 ml-1 pl-2 border-l border-gray-200">
              {profile?.picture ? (
                <img
                  src={profile.picture}
                  alt=""
                  className="w-6 h-6 rounded-full object-cover"
                  referrerPolicy="no-referrer"
                />
              ) : null}
              <span className="text-xs text-gray-500 max-w-[120px] truncate" title={npubShort}>
                {profile?.name || npubShort}
              </span>
              <button
                onClick={onLogout}
                className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors"
                title="Logout"
              >
                <LogOut className="w-4 h-4 text-gray-500" />
              </button>
            </div>
          </div>
        </div>

        {/* ===== MOBILE LAYOUT (< sm) ===== */}

        {/* Row 1: Top menu — title + global actions. Version suffix dropped
            on mobile so the right-hand button row (calendars, undo/redo,
            refresh, backup, autosave, share, settings, logout) fits on
            narrow phones without clipping. */}
        <div className="flex items-center justify-between py-2 lg:hidden gap-1">
          <div className="flex items-center gap-1 shrink-0 min-w-0">
            <CalendarDays className="w-5 h-5 text-primary-600 shrink-0" />
            <h1 className="text-base font-bold text-primary-700">Planner</h1>
          </div>
          <div className="flex items-center gap-0.5">
            <button
              onClick={onCalendars}
              className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors"
              title="Calendars"
            >
              <Layers className="w-4 h-4 text-gray-500" />
            </button>
            <button
              onClick={() => void undo()}
              disabled={undoDepth === 0}
              className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              title={undoDepth > 0 ? `Undo: ${undoPreview}` : "Nothing to undo"}
            >
              <Undo2 className="w-4 h-4 text-gray-500" />
            </button>
            <button
              onClick={() => void redo()}
              disabled={redoDepth === 0}
              className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              title={redoDepth > 0 ? `Redo: ${redoPreview}` : "Nothing to redo"}
            >
              <Redo2 className="w-4 h-4 text-gray-500" />
            </button>
            <button
              onClick={() => {
                const next = !autoBackup;
                setAutoBackup(next);
                if (next) onBackupNow();
              }}
              className={`relative p-1.5 rounded-lg transition-colors ${
                !autoBackup ? "hover:bg-gray-100"
                : backupPhase === "idle" ? "bg-emerald-50 hover:bg-emerald-100"
                : "bg-red-50 hover:bg-red-100"
              }`}
              title={
                !autoBackup ? "Auto-backup off"
                : backupPhase === "saving" ? "Saving backup…"
                : backupPhase === "error"
                  ? `Save failed: ${backupError ?? "unknown error"}${saveCountdown !== null ? ` — retry in ${saveCountdown}s` : ""}`
                : backupPhase === "dirty" && saveCountdown !== null ? `Unsaved — autosave in ${saveCountdown}s`
                : "Auto-backup on"
              }
            >
              {!autoBackup ? (
                <CloudOff className="w-4 h-4 text-gray-400" />
              ) : backupPhase === "saving" ? (
                <Loader className="w-4 h-4 animate-spin text-red-600" />
              ) : backupPhase === "error" ? (
                <CloudAlert className="w-4 h-4 text-red-600" />
              ) : backupPhase === "dirty" ? (
                <CloudUpload className="w-4 h-4 text-red-600" />
              ) : (
                <CloudUpload className="w-4 h-4 text-emerald-600" />
              )}

              {/* Countdown badge in the corner for dirty/error phases. */}
              {autoBackup && saveCountdown !== null && (backupPhase === "dirty" || backupPhase === "error") && (
                <span className="absolute -top-0.5 -right-0.5 min-w-[1rem] h-4 px-0.5 rounded-full bg-red-600 text-white text-[9px] font-semibold leading-4 text-center tabular-nums">
                  {saveCountdown}
                </span>
              )}
            </button>
            <button
              onClick={onSettings}
              className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors"
              title="Settings"
            >
              <Settings className="w-4 h-4 text-gray-500" />
            </button>
            {profile?.picture ? (
              <img
                src={profile.picture}
                alt=""
                className="w-5 h-5 rounded-full object-cover shrink-0"
                referrerPolicy="no-referrer"
                title={profile.name || npubShort}
              />
            ) : null}
            <button
              onClick={onLogout}
              className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors shrink-0"
              title="Logout"
            >
              <LogOut className="w-4 h-4 text-gray-500" />
            </button>
          </div>
        </div>

        {/* Row 2: Submenu — date navigation + new event. Only the calendar
            tab needs Today + prev/next; upcoming/daily/todos don't have an
            anchor date to navigate. */}
        <div className="flex items-center justify-between pb-1.5 lg:hidden">
          <div className="flex items-center gap-1">
            {mobileTab === "calendar" && (
              <button
                onClick={goToday}
                className="px-2 py-1 text-xs border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                Today
              </button>
            )}
            {mobileTab === "calendar" && (
              <>
                <button
                  onClick={mobileNavigateBack}
                  className="p-1 hover:bg-gray-100 rounded-lg transition-colors"
                  aria-label="Navigate back"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <button
                  onClick={mobileNavigateForward}
                  className="p-1 hover:bg-gray-100 rounded-lg transition-colors"
                  aria-label="Navigate forward"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </>
            )}
            <span className="text-xs font-semibold text-gray-800">
              {mobileTitleText()}
            </span>
          </div>
          <button
            onClick={onNewEvent}
            disabled={!canAddEvent}
            title={canAddEvent ? "" : "Loading calendars…"}
            className="flex items-center gap-1 bg-primary-600 hover:bg-primary-700 text-white px-2 py-1 rounded-lg text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Plus className="w-3.5 h-3.5" />
            Event
          </button>
        </div>

        {/* Row 3: Tab bar — one view at a time */}
        <div className="flex border-t border-gray-100 lg:hidden">
          {mobileTabs.map(({ id, label }) => (
            <button
              key={id}
              onClick={() => onMobileTabChange(id)}
              className={`flex-1 py-1.5 text-xs font-medium transition-colors border-b-2 ${
                mobileTab === id
                  ? "text-primary-600 border-primary-600"
                  : "text-gray-500 border-transparent hover:text-gray-700"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

      </div>
    </header>
  );
}
