import type { NostrProfile } from "../contexts/NostrContext";
import { useCalendar } from "../contexts/CalendarContext";
import { useSettings } from "../contexts/SettingsContext";
import {
  ChevronLeft,
  ChevronRight,
  Plus,
  LogOut,
  RefreshCw,
  Archive,
  Settings,
  CalendarCheck,
  CalendarDays,
  List,
  CloudUpload,
  CloudOff,
  Loader,
  Layers,
} from "lucide-react";
import {
  format,
  addMonths,
  subMonths,
  addWeeks,
  subWeeks,
  addDays,
  subDays,
} from "date-fns";

/** All possible bottom-tab identifiers on mobile. Calendar views (month/week/day)
 *  map directly to the CalendarContext viewMode; daily and todos are app-specific panels. */
export type MobileTab = "month" | "week" | "day" | "daily" | "todos";

/** @see {@link Header} */
interface HeaderProps {
  pubkey: string;
  profile: NostrProfile | null;
  backingUp: boolean;
  onLogout: () => void;
  onNewEvent: () => void;
  onBackup: () => void;
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
 * to-do lists), action buttons (new event, refresh, backup, auto-backup,
 * settings), and user profile/logout.
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
  backingUp,
  onLogout,
  onNewEvent,
  onBackup,
  onSettings,
  showDaily,
  showLists,
  onToggleDaily,
  onToggleLists,
  mobileTab,
  onMobileTabChange,
  onCalendars,
}: HeaderProps) {
  const { currentDate, setCurrentDate, viewMode, setViewMode, refreshEvents, decryptionErrors } =
    useCalendar();
  const { autoBackup, setAutoBackup } = useSettings();

  const npubShort = `${pubkey.slice(0, 8)}...${pubkey.slice(-4)}`;

  // Navigation step size adapts to the current view: month/week/day
  const navigateBack = () => {
    if (viewMode === "month") setCurrentDate(subMonths(currentDate, 1));
    else if (viewMode === "week") setCurrentDate(subWeeks(currentDate, 1));
    else setCurrentDate(subDays(currentDate, 1));
  };

  const navigateForward = () => {
    if (viewMode === "month") setCurrentDate(addMonths(currentDate, 1));
    else if (viewMode === "week") setCurrentDate(addWeeks(currentDate, 1));
    else setCurrentDate(addDays(currentDate, 1));
  };

  const mobileNavigateBack = () => {
    if (mobileTab === "month") setCurrentDate(subMonths(currentDate, 1));
    else if (mobileTab === "week") setCurrentDate(subWeeks(currentDate, 1));
    else setCurrentDate(subDays(currentDate, 1));
  };

  const mobileNavigateForward = () => {
    if (mobileTab === "month") setCurrentDate(addMonths(currentDate, 1));
    else if (mobileTab === "week") setCurrentDate(addWeeks(currentDate, 1));
    else setCurrentDate(addDays(currentDate, 1));
  };

  const goToday = () => setCurrentDate(new Date());

  const titleText = () => {
    if (viewMode === "month") return format(currentDate, "MMMM yyyy");
    if (viewMode === "week") {
      return `Week of ${format(currentDate, "MMM d, yyyy")}`;
    }
    return format(currentDate, "EEEE, MMMM d, yyyy");
  };

  const mobileTitleText = () => {
    if (mobileTab === "todos") return "To Do Lists";
    if (mobileTab === "daily") return format(currentDate, "EEE, MMM d");
    if (mobileTab === "month") return format(currentDate, "MMM yyyy");
    if (mobileTab === "week") return `Wk ${format(currentDate, "MMM d")}`;
    return format(currentDate, "EEE, MMM d");
  };

  const mobileTabs: { id: MobileTab; label: string }[] = [
    { id: "month", label: "Month" },
    { id: "week", label: "Week" },
    { id: "day", label: "Day" },
    { id: "daily", label: "Daily" },
    { id: "todos", label: "To Do Lists" },
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
        <div className="hidden sm:flex items-center justify-between py-3">
          {/* Left: app name */}
          <div className="flex items-center gap-2 min-w-0">
            <CalendarDays className="w-6 h-6 text-primary-600 shrink-0" />
            <h1 className="text-xl font-bold text-primary-700 shrink-0">
              Planner
              <span className="text-xs font-normal text-gray-400 ml-1">v0.1.0-beta</span>
            </h1>
          </div>

          {/* Right: navigation + date label + view mode + actions */}
          <div className="flex items-center gap-2 shrink-0">
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

            <h2 className="text-lg font-semibold text-gray-800 truncate mr-1">
              {titleText()}
            </h2>

            {/* View mode selector */}
            <div className="flex border border-gray-300 rounded-lg overflow-hidden">
              {(["month", "week", "day"] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setViewMode(mode)}
                  className={`px-3 py-1.5 text-sm transition-colors ${
                    viewMode === mode
                      ? "bg-primary-600 text-white"
                      : "hover:bg-gray-50"
                  }`}
                >
                  {mode.charAt(0).toUpperCase() + mode.slice(1)}
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
              className="flex items-center gap-1 bg-primary-600 hover:bg-primary-700 text-white px-3 py-1.5 rounded-lg text-sm font-medium transition-colors"
            >
              <Plus className="w-4 h-4" />
              <span>Event</span>
            </button>

            <button
              onClick={refreshEvents}
              className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors"
              title="Refresh"
            >
              <RefreshCw className="w-4 h-4 text-gray-500" />
            </button>

            <button
              onClick={onBackup}
              className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors"
              title="Backup / Restore"
            >
              <Archive className="w-4 h-4 text-gray-500" />
            </button>

            <button
              onClick={() => setAutoBackup(!autoBackup)}
              className={`p-1.5 rounded-lg transition-colors ${
                autoBackup
                  ? "bg-emerald-50 hover:bg-emerald-100"
                  : "hover:bg-gray-100"
              }`}
              title={backingUp ? "Saving backup…" : autoBackup ? "Auto-backup on" : "Auto-backup off"}
            >
              {backingUp ? (
                <Loader className="w-4 h-4 text-emerald-600 animate-spin" />
              ) : autoBackup ? (
                <CloudUpload className="w-4 h-4 text-emerald-600" />
              ) : (
                <CloudOff className="w-4 h-4 text-gray-400" />
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

        {/* Row 1: Top menu — title + version + global actions */}
        <div className="flex items-center justify-between py-2 sm:hidden">
          <div className="flex items-center gap-1.5">
            <CalendarDays className="w-5 h-5 text-primary-600 shrink-0" />
            <h1 className="text-base font-bold text-primary-700">
              Planner
              <span className="text-[10px] font-normal text-gray-400 ml-1">v0.1.0-beta</span>
            </h1>
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
              onClick={refreshEvents}
              className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors"
              title="Refresh"
            >
              <RefreshCw className="w-4 h-4 text-gray-500" />
            </button>
            <button
              onClick={onBackup}
              className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors"
              title="Backup"
            >
              <Archive className="w-4 h-4 text-gray-500" />
            </button>
            <button
              onClick={() => setAutoBackup(!autoBackup)}
              className={`p-1.5 rounded-lg transition-colors ${
                autoBackup
                  ? "bg-emerald-50 hover:bg-emerald-100"
                  : "hover:bg-gray-100"
              }`}
              title={backingUp ? "Saving backup…" : autoBackup ? "Auto-backup on" : "Auto-backup off"}
            >
              {backingUp ? (
                <Loader className="w-4 h-4 text-emerald-600 animate-spin" />
              ) : autoBackup ? (
                <CloudUpload className="w-4 h-4 text-emerald-600" />
              ) : (
                <CloudOff className="w-4 h-4 text-gray-400" />
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
                className="w-5 h-5 rounded-full object-cover"
                referrerPolicy="no-referrer"
              />
            ) : null}
            {profile?.name ? (
              <span className="text-[11px] text-gray-500 max-w-[80px] truncate">
                {profile.name}
              </span>
            ) : null}
            <button
              onClick={onLogout}
              className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors"
              title="Logout"
            >
              <LogOut className="w-4 h-4 text-gray-500" />
            </button>
          </div>
        </div>

        {/* Row 2: Submenu — date navigation + new event */}
        <div className="flex items-center justify-between pb-1.5 sm:hidden">
          <div className="flex items-center gap-1">
            <button
              onClick={goToday}
              className="px-2 py-1 text-xs border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Today
            </button>
            {mobileTab !== "todos" && (
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
            className="flex items-center gap-1 bg-primary-600 hover:bg-primary-700 text-white px-2 py-1 rounded-lg text-xs font-medium transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            Event
          </button>
        </div>

        {/* Row 3: Tab bar — one view at a time */}
        <div className="flex border-t border-gray-100 sm:hidden">
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
