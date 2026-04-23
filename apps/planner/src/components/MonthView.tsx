import { useMemo, useRef, useState, type CSSProperties, type DragEvent } from "react";
import { useCalendar } from "../contexts/CalendarContext";
import {
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  startOfDay,
  eachDayOfInterval,
  isSameMonth,
  isSameDay,
  isToday,
  format,
  set,
  addDays,
} from "date-fns";
import type { CalendarEvent } from "../lib/nostr";

interface MonthViewProps {
  onEventClick: (event: CalendarEvent) => void;
  onDateClick: (date: Date) => void;
  /** Tap on a day number — opens the day-detail modal listing every event. */
  onDayDetail?: (date: Date) => void;
  /** Right-click an event to copy it to the paste clipboard. */
  onEventCopy?: (event: CalendarEvent) => void;
  /** Right-click a day cell to paste the last-copied event as a duplicate. */
  onDayPaste?: (date: Date) => void;
  /** True if there's something in the paste clipboard (enables day paste UX). */
  hasCopied?: boolean;
}

/** A multi-day all-day event rendered as a continuous bar across the week. */
interface SpanBar {
  event: CalendarEvent;
  /** 0-based column within the week (Sunday = 0). */
  startCol: number;
  /** Number of consecutive day columns this bar covers. */
  span: number;
  /** Vertical lane (0 = top); parallel bars stack in separate lanes. */
  lane: number;
  /** True if the event started before this week's Sunday. */
  continuesLeft: boolean;
  /** True if the event continues past this week's Saturday. */
  continuesRight: boolean;
}

interface WeekRow {
  weekKey: string;
  days: Date[];
  bars: SpanBar[];
  perDayEvents: Map<string, CalendarEvent[]>;
  numLanes: number;
}

export function MonthView({ onEventClick, onDateClick, onDayDetail, onEventCopy, onDayPaste, hasCopied }: MonthViewProps) {
  const { currentDate, filteredEvents: events, calendars, moveEvent } = useCalendar();
  const [dragOverDate, setDragOverDate] = useState<string | null>(null);
  const [draggingEvent, setDraggingEvent] = useState<CalendarEvent | null>(null);
  const [expandedDay, setExpandedDay] = useState<string | null>(null);
  const dragLeaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Long-press handlers to give touch devices the same right-click UX.
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFired = useRef(false);
  const startLongPress = (action: () => void) => {
    cancelLongPress();
    longPressFired.current = false;
    longPressTimer.current = setTimeout(() => {
      longPressFired.current = true;
      action();
    }, 500);
  };
  const cancelLongPress = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  // Compute the visible grid of days (covers whole weeks touching the month).
  const weeks = useMemo<WeekRow[]>(() => {
    const monthStart = startOfMonth(currentDate);
    const monthEnd = endOfMonth(currentDate);
    const calStart = startOfWeek(monthStart);
    const calEnd = endOfWeek(monthEnd);
    const allDays = eachDayOfInterval({ start: calStart, end: calEnd });

    // Index every event by day it covers (for timed events + single-day all-day).
    // Multi-day all-day events render as spanning bars and are excluded from
    // the per-day list to avoid duplicating them on every covered day.
    const perDayIndex = new Map<string, CalendarEvent[]>();
    const multiDayAllDayIds = new Set<string>();
    const MAX_SPAN_DAYS = 31;

    for (const event of events) {
      const first = startOfDay(event.start);
      const last = event.end && event.end.getTime() > event.start.getTime()
        ? startOfDay(event.end)
        : first;
      const isMultiDayAllDay = event.allDay && last.getTime() > first.getTime();
      if (isMultiDayAllDay) {
        multiDayAllDayIds.add(event.dTag);
        continue; // rendered as bar; skip per-day listing
      }
      // Single-day all-day, or timed: list on the event's start day only.
      // (Timed events that cross midnight: visible start; keeping behavior
      // simple. Cross-midnight timed events are rare in practice.)
      let cursor = first;
      for (let i = 0; i <= MAX_SPAN_DAYS; i++) {
        const key = format(cursor, "yyyy-MM-dd");
        if (!perDayIndex.has(key)) perDayIndex.set(key, []);
        perDayIndex.get(key)!.push(event);
        if (cursor.getTime() >= last.getTime()) break;
        cursor = addDays(cursor, 1);
      }
    }

    // Sort per-day lists: all-day events first, then timed by start.
    for (const list of perDayIndex.values()) {
      list.sort((a, b) => {
        if (a.allDay && !b.allDay) return -1;
        if (!a.allDay && b.allDay) return 1;
        return a.start.getTime() - b.start.getTime();
      });
    }

    // Build weeks.
    const result: WeekRow[] = [];
    for (let wi = 0; wi < allDays.length; wi += 7) {
      const weekDays = allDays.slice(wi, wi + 7);
      const weekStart = weekDays[0];
      const weekEnd = weekDays[6];

      // Candidate bars for this week = multi-day all-day events whose span
      // overlaps the week's window. Clip each bar to the week's columns.
      const candidates: Omit<SpanBar, "lane">[] = [];
      for (const event of events) {
        if (!multiDayAllDayIds.has(event.dTag)) continue;
        const first = startOfDay(event.start);
        const last = startOfDay(event.end!);
        if (last.getTime() < weekStart.getTime() || first.getTime() > weekEnd.getTime()) continue;
        const clipStart = first.getTime() < weekStart.getTime() ? weekStart : first;
        const clipEnd = last.getTime() > weekEnd.getTime() ? weekEnd : last;
        const startCol = weekDays.findIndex((d) => isSameDay(d, clipStart));
        const endCol = weekDays.findIndex((d) => isSameDay(d, clipEnd));
        if (startCol === -1 || endCol === -1) continue;
        candidates.push({
          event,
          startCol,
          span: endCol - startCol + 1,
          continuesLeft: first.getTime() < weekStart.getTime(),
          continuesRight: last.getTime() > weekEnd.getTime(),
        });
      }
      // Greedy lane assignment: longer bars first to reduce fragmentation.
      candidates.sort((a, b) => a.startCol - b.startCol || b.span - a.span);
      const laneMask: boolean[][] = [];
      const bars: SpanBar[] = [];
      for (const c of candidates) {
        let lane = 0;
        while (true) {
          if (!laneMask[lane]) laneMask[lane] = new Array(7).fill(false);
          let fits = true;
          for (let col = c.startCol; col < c.startCol + c.span; col++) {
            if (laneMask[lane][col]) { fits = false; break; }
          }
          if (fits) {
            for (let col = c.startCol; col < c.startCol + c.span; col++) {
              laneMask[lane][col] = true;
            }
            bars.push({ ...c, lane });
            break;
          }
          lane++;
        }
      }

      // Per-day events restricted to this week's days.
      const perDayEvents = new Map<string, CalendarEvent[]>();
      for (const d of weekDays) {
        const key = format(d, "yyyy-MM-dd");
        perDayEvents.set(key, perDayIndex.get(key) || []);
      }

      result.push({
        weekKey: format(weekStart, "yyyy-MM-dd"),
        days: weekDays,
        bars,
        perDayEvents,
        numLanes: laneMask.length,
      });
    }
    return result;
  }, [currentDate, events]);

  const weekHeaderLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  const handleDragStart = (e: DragEvent, event: CalendarEvent) => {
    e.dataTransfer.setData("text/plain", JSON.stringify({ dTag: event.dTag, kind: event.kind }));
    e.dataTransfer.effectAllowed = "move";
    setDraggingEvent(event);
  };

  const handleDragEnd = () => {
    setDraggingEvent(null);
    setDragOverDate(null);
  };

  const handleDragOver = (e: DragEvent, dateKey: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dragLeaveTimer.current) { clearTimeout(dragLeaveTimer.current); dragLeaveTimer.current = null; }
    setDragOverDate(dateKey);
  };

  // Debounced so a brief dragLeave when the cursor moves from the cell
  // background to an overlapping event pill doesn't flicker the placeholder
  // away. handleDragOver cancels the timer, keeping dragOverDate stable.
  const handleDragLeave = () => {
    dragLeaveTimer.current = setTimeout(() => setDragOverDate(null), 50);
  };

  const handleDrop = (e: DragEvent, day: Date) => {
    e.preventDefault();
    setDragOverDate(null);
    setDraggingEvent(null);
    try {
      const data = JSON.parse(e.dataTransfer.getData("text/plain"));
      const event = events.find((ev) => ev.dTag === data.dTag);
      if (!event || isSameDay(event.start, day)) return;
      const newStart = event.allDay
        ? day
        : set(day, { hours: event.start.getHours(), minutes: event.start.getMinutes() });
      moveEvent(event, newStart);
    } catch { /* invalid drag data */ }
  };

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
      {/* Weekday headers */}
      <div className="grid grid-cols-7 border-b border-gray-200">
        {weekHeaderLabels.map((label) => (
          <div
            key={label}
            className="py-2 text-center text-xs font-semibold text-gray-500 uppercase tracking-wider"
          >
            {label}
          </div>
        ))}
      </div>

      {/* Week rows. Each week uses a CSS grid with:
          row 1:        day number headers
          rows 2..N+1:  spanning bars (each bar covers grid-column start/span)
          row  N+2:     per-day event lists (single-day all-day + timed)
          A full-column "cell background" spans all rows and is the click/drop
          target so the whole column behaves like a day cell. */}
      {weeks.map((week) => {
        const barLanes = week.numLanes;
        const totalRows = barLanes + 2;
        const rowTemplate = `auto${barLanes > 0 ? ` repeat(${barLanes}, minmax(20px, auto))` : ""} 1fr`;
        return (
          <div
            key={week.weekKey}
            className="grid border-b border-gray-100 last:border-b-0"
            style={{
              gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
              gridTemplateRows: rowTemplate,
            }}
          >
            {/* Day-cell backgrounds (click/drop targets) */}
            {week.days.map((day, col) => {
              const key = format(day, "yyyy-MM-dd");
              const inMonth = isSameMonth(day, currentDate);
              const isDragOver = dragOverDate === key;
              const bgStyle: CSSProperties = {
                gridColumn: col + 1,
                gridRow: `1 / span ${totalRows}`,
              };
              return (
                <div
                  key={`bg-${key}`}
                  style={bgStyle}
                  className={`min-h-[110px] border-r border-gray-100 last:border-r-0 cursor-pointer hover:bg-gray-50 transition-colors ${
                    !inMonth ? "bg-gray-50/50" : ""
                  } ${isDragOver ? "bg-primary-100 ring-2 ring-inset ring-primary-500 shadow-inner" : ""}`}
                  onClick={() => {
                    if (longPressFired.current) {
                      longPressFired.current = false;
                      return;
                    }
                    onDateClick(day);
                  }}
                  onContextMenu={(e) => {
                    if (hasCopied && onDayPaste) {
                      e.preventDefault();
                      onDayPaste(day);
                    }
                  }}
                  onTouchStart={() => {
                    if (hasCopied && onDayPaste) startLongPress(() => onDayPaste(day));
                  }}
                  onTouchEnd={cancelLongPress}
                  onTouchMove={cancelLongPress}
                  onTouchCancel={cancelLongPress}
                  onDragOver={(e) => handleDragOver(e, key)}
                  onDragLeave={handleDragLeave}
                  onDrop={(e) => handleDrop(e, day)}
                />
              );
            })}

            {/* Day number headers. The entire top bar of each day column
                is now a click target for the day-detail modal — previously
                only the small date circle triggered it, which was a fiddly
                tap target on mobile. pointer-events-auto on the button
                re-enables clicks that would otherwise fall through to the
                cell bg underneath (which handles new-event creation). */}
            {week.days.map((day, col) => {
              const key = format(day, "yyyy-MM-dd");
              const inMonth = isSameMonth(day, currentDate);
              const today = isToday(day);
              return (
                <button
                  key={`num-${key}`}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (onDayDetail) onDayDetail(day);
                  }}
                  onDragOver={(e) => handleDragOver(e, key)}
                  onDragLeave={handleDragLeave}
                  onDrop={(e) => handleDrop(e, day)}
                  className="pointer-events-auto flex items-center justify-center py-1 hover:bg-primary-50 transition-colors cursor-pointer"
                  style={{ gridColumn: col + 1, gridRow: 1 }}
                  title="Open day details"
                  aria-label={`Open details for ${format(day, "EEEE MMMM d")}`}
                >
                  <span
                    className={`text-sm w-7 h-7 flex items-center justify-center rounded-full ${
                      today
                        ? "bg-primary-600 text-white font-bold ring-2 ring-primary-200"
                        : inMonth
                          ? "text-gray-900"
                          : "text-gray-400"
                    }`}
                  >
                    {format(day, "d")}
                  </span>
                </button>
              );
            })}

            {/* Spanning bars for multi-day all-day events. */}
            {week.bars.map((bar) => {
              const cal = calendars.find((c) => bar.event.calendarRefs.includes(c.dTag));
              const color = cal?.color;
              const barStyle: CSSProperties = {
                gridColumn: `${bar.startCol + 1} / span ${bar.span}`,
                gridRow: bar.lane + 2,
              };
              return (
                <button
                  key={`bar-${bar.event.dTag}-${bar.startCol}`}
                  draggable
                  onDragStart={(e) => handleDragStart(e, bar.event)}
                  onDragEnd={handleDragEnd}
                  onDragOver={(e) => handleDragOver(e, format(week.days[bar.startCol], "yyyy-MM-dd"))}
                  onDragLeave={handleDragLeave}
                  onDrop={(e) => handleDrop(e, week.days[bar.startCol])}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (longPressFired.current) {
                      longPressFired.current = false;
                      return;
                    }
                    onEventClick(bar.event);
                  }}
                  onContextMenu={(e) => {
                    if (!onEventCopy) return;
                    e.preventDefault();
                    e.stopPropagation();
                    onEventCopy(bar.event);
                  }}
                  onTouchStart={(e) => {
                    e.stopPropagation();
                    if (onEventCopy) startLongPress(() => onEventCopy(bar.event));
                  }}
                  onTouchEnd={cancelLongPress}
                  onTouchMove={cancelLongPress}
                  onTouchCancel={cancelLongPress}
                  style={{
                    ...barStyle,
                    backgroundColor: color,
                  }}
                  className={`mx-0.5 my-0.5 px-2 py-0.5 text-left text-xs font-medium cursor-grab active:cursor-grabbing truncate hover:opacity-80 transition-opacity ${
                    color
                      ? "text-white"
                      : "bg-primary-500 text-white"
                  } ${bar.continuesLeft ? "rounded-l-none" : "rounded-l"} ${
                    bar.continuesRight ? "rounded-r-none" : "rounded-r"
                  }`}
                  title={bar.event.title}
                >
                  {bar.continuesLeft && <span className="mr-1">&lsaquo;</span>}
                  {bar.event.title}
                  {bar.continuesRight && <span className="ml-1">&rsaquo;</span>}
                </button>
              );
            })}

            {/* Per-day event lists (timed events + single-day all-day) */}
            {week.days.map((day, col) => {
              const key = format(day, "yyyy-MM-dd");
              const dayEvents = week.perDayEvents.get(key) || [];
              const shown = expandedDay === key ? dayEvents : dayEvents.slice(0, 3);
              const isDragOver = dragOverDate === key;
              return (
                <div
                  key={`events-${key}`}
                  className="px-1 pb-1 space-y-0.5 pointer-events-none"
                  style={{ gridColumn: col + 1, gridRow: barLanes + 2 }}
                >
                  {/* Drop-target preview floats above per-day events. Shown
                      only when dragging a different event onto this day. */}
                  {isDragOver && draggingEvent && !isSameDay(draggingEvent.start, day) && (
                    <div className="mb-1 px-1.5 py-0.5 rounded border-2 border-dashed border-primary-500 bg-primary-100/80 text-[11px] font-medium text-primary-800 truncate">
                      &rarr; {draggingEvent.title}
                    </div>
                  )}
                  {shown.map((event) => {
                    const cal = calendars.find((c) => event.calendarRefs.includes(c.dTag));
                    const color = cal?.color;
                    return (
                      <button
                        key={event.dTag}
                        draggable
                        onDragStart={(e) => handleDragStart(e, event)}
                        onDragEnd={handleDragEnd}
                        onDragOver={(e) => handleDragOver(e, key)}
                        onDragLeave={handleDragLeave}
                        onDrop={(e) => handleDrop(e, day)}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (longPressFired.current) {
                            longPressFired.current = false;
                            return;
                          }
                          onEventClick(event);
                        }}
                        onContextMenu={(e) => {
                          if (!onEventCopy) return;
                          e.preventDefault();
                          e.stopPropagation();
                          onEventCopy(event);
                        }}
                        onTouchStart={(e) => {
                          e.stopPropagation();
                          if (onEventCopy) startLongPress(() => onEventCopy(event));
                        }}
                        onTouchEnd={cancelLongPress}
                        onTouchMove={cancelLongPress}
                        onTouchCancel={cancelLongPress}
                        className={`pointer-events-auto w-full text-left px-1.5 py-0.5 rounded text-xs transition-colors cursor-grab active:cursor-grabbing ${
                          color
                            ? "text-white hover:opacity-80"
                            : event.allDay
                              ? "bg-primary-100 text-primary-800 hover:bg-primary-200"
                              : "bg-emerald-100 text-emerald-800 hover:bg-emerald-200"
                        }`}
                        style={color ? { backgroundColor: color } : undefined}
                      >
                        <div className="font-medium truncate">{event.title}</div>
                        {event.hashtags.length > 0 && (
                          <div className="truncate text-[10px] opacity-80">
                            {event.hashtags.map((t) => `#${t}`).join(" ")}
                          </div>
                        )}
                        {!event.allDay && (
                          <div className="truncate text-[10px] opacity-80">
                            {format(event.start, "h:mm")}
                            {event.end && ` - ${format(event.end, "h:mm")}`}
                          </div>
                        )}
                      </button>
                    );
                  })}
                  {dayEvents.length > 3 && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setExpandedDay(expandedDay === key ? null : key);
                      }}
                      className="pointer-events-auto text-xs text-primary-600 hover:text-primary-700 pl-1.5 font-medium"
                    >
                      {expandedDay === key ? "Show less" : `+${dayEvents.length - 3} more`}
                    </button>
                  )}
                </div>
              );
            })}

          </div>
        );
      })}
    </div>
  );
}
