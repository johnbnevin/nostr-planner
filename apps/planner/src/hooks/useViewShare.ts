import { useCallback, useEffect, useRef } from "react";
import { useCalendar } from "../contexts/CalendarContext";
import { useSettings } from "../contexts/SettingsContext";

/**
 * Hash-based deep-linkable view state. A user can tap "Share this view",
 * copy the URL, and add it to their phone's home screen — when tapped,
 * the app launches with the same view mode, calendar + tag filters, and
 * panel toggles applied.
 *
 * The hash looks like:
 *   #view=month&cals=abc,def&tag=work&panels=daily,lists&focus=calendar
 *
 *   view    = "month" | "week" | "day"
 *   cals    = comma-separated calendar d-tags to mark active (others off)
 *   tag     = single active hashtag
 *   panels  = comma list of "daily" and/or "lists" to show
 *   focus   = "daily" | "lists" | "calendar" — mobile tab bias / widget mode
 *   date    = YYYY-MM-DD starting date (optional)
 *
 * Missing keys leave the current state untouched so partial URLs work too.
 */

export interface ViewShareState {
  view?: "month" | "week" | "day";
  cals?: string[];
  tag?: string | null;
  panels?: { daily: boolean; lists: boolean };
  focus?: "daily" | "lists" | "calendar";
  date?: string;
}

export function parseViewHash(hash: string): ViewShareState {
  if (!hash || !hash.startsWith("#")) return {};
  // Ignore invite hashes — they're handled elsewhere.
  if (hash.startsWith("#invite=")) return {};
  const params = new URLSearchParams(hash.slice(1));
  const out: ViewShareState = {};
  const view = params.get("view");
  if (view === "month" || view === "week" || view === "day") out.view = view;
  const cals = params.get("cals");
  if (cals !== null) out.cals = cals ? cals.split(",").filter(Boolean) : [];
  const tag = params.get("tag");
  if (tag !== null) out.tag = tag || null;
  const panels = params.get("panels");
  if (panels !== null) {
    const set = new Set(panels.split(",").filter(Boolean));
    out.panels = { daily: set.has("daily"), lists: set.has("lists") };
  }
  const focus = params.get("focus");
  if (focus === "daily" || focus === "lists" || focus === "calendar") out.focus = focus;
  const date = params.get("date");
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) out.date = date;
  return out;
}

export function buildViewHash(s: ViewShareState): string {
  const params = new URLSearchParams();
  if (s.view) params.set("view", s.view);
  if (s.cals !== undefined) params.set("cals", s.cals.join(","));
  if (s.tag !== undefined) params.set("tag", s.tag ?? "");
  if (s.panels) {
    const on: string[] = [];
    if (s.panels.daily) on.push("daily");
    if (s.panels.lists) on.push("lists");
    params.set("panels", on.join(","));
  }
  if (s.focus) params.set("focus", s.focus);
  if (s.date) params.set("date", s.date);
  const str = params.toString();
  return str ? "#" + str : "";
}

/** Apply the initial hash on mount (once per session). Silently ignored if
 *  the hash is empty or contains an invite token. */
export function useApplyInitialViewHash(): void {
  const { calendars, activeCalendarIds, toggleCalendar, setViewMode, setActiveTag, setCurrentDate } = useCalendar();
  const { setShowDaily, setShowLists } = useSettings();
  const applied = useRef(false);

  useEffect(() => {
    if (applied.current) return;
    // Wait until calendars have loaded so cal-dTag filtering is meaningful.
    if (calendars.length === 0) return;
    applied.current = true;

    const state = parseViewHash(window.location.hash);
    if (Object.keys(state).length === 0) return;

    if (state.view) setViewMode(state.view);
    if (state.tag !== undefined) setActiveTag(state.tag);
    if (state.date) {
      const parsed = new Date(`${state.date}T00:00:00`);
      if (!Number.isNaN(parsed.getTime())) setCurrentDate(parsed);
    }
    if (state.cals) {
      // Normalize: target set = exactly state.cals (intersected with known dTags).
      const validSet = new Set(calendars.map((c) => c.dTag));
      const target = new Set(state.cals.filter((d) => validSet.has(d)));
      for (const cal of calendars) {
        const has = activeCalendarIds.has(cal.dTag);
        const wants = target.has(cal.dTag);
        if (has !== wants) toggleCalendar(cal.dTag);
      }
    }
    if (state.panels) {
      setShowDaily(state.panels.daily);
      setShowLists(state.panels.lists);
    }
    // Clear the hash so subsequent bookmarks don't capture the applied state
    // twice. Preserve the path + query, drop only the hash.
    if (window.location.hash) {
      history.replaceState(null, "", window.location.pathname + window.location.search);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- single-shot effect on calendars load
  }, [calendars.length]);
}

/** Build a shareable URL for the current view. */
export function useBuildShareUrl(): (overrides?: Partial<ViewShareState>) => string {
  const { viewMode, activeCalendarIds, activeTag, calendars, currentDate } = useCalendar();
  const { showDaily, showLists } = useSettings();
  return useCallback((overrides?: Partial<ViewShareState>) => {
    const pad = (n: number) => n.toString().padStart(2, "0");
    const dateStr = `${currentDate.getFullYear()}-${pad(currentDate.getMonth() + 1)}-${pad(currentDate.getDate())}`;
    const state: ViewShareState = {
      view: viewMode,
      cals: calendars
        .filter((c) => activeCalendarIds.has(c.dTag))
        .map((c) => c.dTag),
      tag: activeTag,
      panels: { daily: showDaily, lists: showLists },
      date: dateStr,
      ...overrides,
    };
    const hash = buildViewHash(state);
    const base = window.location.origin + window.location.pathname + window.location.search;
    return base + hash;
  }, [viewMode, activeCalendarIds, activeTag, calendars, showDaily, showLists, currentDate]);
}
