import { useMemo, useRef, useState, useEffect, type DragEvent } from "react";
import { Clock, MapPin, Tag, Link as LinkIcon, FileText, Repeat, Plus, Loader2 } from "lucide-react";
import { format, isSameDay, isToday, isTomorrow, isYesterday, addDays, startOfDay, endOfDay, set } from "date-fns";
import { useCalendar } from "../contexts/CalendarContext";
import type { CalendarEvent } from "../lib/nostr";

interface UpcomingViewProps {
  onEventClick: (event: CalendarEvent) => void;
  onNewEvent: () => void;
}

const LOAD_WINDOW_DAYS = 30;
const INITIAL_WINDOW_DAYS = 60;
/** Recently-ended events stay visible (grayed out) this many days back. */
const PAST_VISIBLE_DAYS = 5;
/** Cap on how many day rows one event can expand into — mirrors
 *  MonthView's guard against runaway spans from corrupt end dates. */
const MAX_SPAN_DAYS = 31;

/**
 * Scrolling list of upcoming events. Shows every field (time, location,
 * tags, description, link, recurrence badge) grouped by date. Lazy-loads
 * further into the future — each time the bottom sentinel enters the
 * viewport, the horizon advances another LOAD_WINDOW_DAYS.
 *
 * Multi-day events appear under EVERY day they span (`end` is inclusive
 * in our internal representation, matching MonthView). Events that have
 * already ended stay visible for PAST_VISIBLE_DAYS, grayed out; anything
 * older is only reachable through the calendar view.
 */
export function UpcomingView({ onEventClick, onNewEvent }: UpcomingViewProps) {
  const { filteredEvents, calendars, moveEvent } = useCalendar();
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const [draggingEvent, setDraggingEvent] = useState<CalendarEvent | null>(null);
  const dragLeaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleDragStart = (e: DragEvent, event: CalendarEvent) => {
    e.dataTransfer.setData("text/plain", JSON.stringify({ dTag: event.dTag, kind: event.kind }));
    e.dataTransfer.effectAllowed = "move";
    setDraggingEvent(event);
  };

  const handleDragEnd = () => {
    setDraggingEvent(null);
    setDragOverKey(null);
  };

  const handleDragOver = (e: DragEvent, key: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dragLeaveTimer.current) { clearTimeout(dragLeaveTimer.current); dragLeaveTimer.current = null; }
    setDragOverKey(key);
  };

  const handleDragLeave = () => {
    dragLeaveTimer.current = setTimeout(() => setDragOverKey(null), 50);
  };

  const handleDrop = (e: DragEvent, date: Date) => {
    e.preventDefault();
    if (dragLeaveTimer.current) { clearTimeout(dragLeaveTimer.current); dragLeaveTimer.current = null; }
    setDragOverKey(null);
    setDraggingEvent(null);
    try {
      const data = JSON.parse(e.dataTransfer.getData("text/plain"));
      const event = filteredEvents.find((ev) => ev.dTag === data.dTag);
      if (!event || isSameDay(event.start, date)) return;
      const newStart = event.allDay
        ? date
        : set(date, { hours: event.start.getHours(), minutes: event.start.getMinutes() });
      void moveEvent(event, newStart);
    } catch { /* invalid drag data */ }
  };
  // How many days into the future to show. Grows on scroll.
  const [horizonDays, setHorizonDays] = useState(INITIAL_WINDOW_DAYS);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const now = useMemo(() => new Date(), []);
  const horizonDate = useMemo(() => addDays(startOfDay(now), horizonDays), [now, horizonDays]);
  // Oldest day row we render: recently-ended events linger this far back.
  const pastWindowStart = useMemo(() => addDays(startOfDay(now), -PAST_VISIBLE_DAYS), [now]);

  const totalUpcoming = useMemo(
    () =>
      filteredEvents
        .filter((e) => {
          const eEnd = e.end ?? e.start;
          return eEnd.getTime() >= pastWindowStart.getTime();
        })
        .sort((a, b) => a.start.getTime() - b.start.getTime()),
    [filteredEvents, pastWindowStart]
  );

  // Group the visible slice by day. A multi-day event contributes a row
  // entry for EVERY day it touches (end inclusive), clamped to the
  // [pastWindowStart, horizonDate] window.
  const grouped = useMemo(() => {
    const horizonMs = horizonDate.getTime();
    const byKey = new Map<string, { date: Date; events: CalendarEvent[] }>();
    for (const e of totalUpcoming) {
      if (e.start.getTime() > horizonMs) break;
      const eEnd = e.end ?? e.start;
      let day = startOfDay(e.start);
      if (day.getTime() < pastWindowStart.getTime()) day = pastWindowStart;
      const lastDayMs = Math.min(startOfDay(eEnd).getTime(), horizonMs);
      for (let i = 0; i <= MAX_SPAN_DAYS && day.getTime() <= lastDayMs; i++, day = addDays(day, 1)) {
        const key = format(day, "yyyy-MM-dd");
        let entry = byKey.get(key);
        if (!entry) {
          entry = { date: day, events: [] };
          byKey.set(key, entry);
        }
        entry.events.push(e);
      }
    }
    // Events were visited in start order, so each day's list is already
    // start-sorted — but rows themselves need sorting: a long span can
    // create later day rows before a later-starting event creates
    // earlier ones.
    return [...byKey.entries()]
      .map(([key, v]) => ({ key, date: v.date, events: v.events }))
      .sort((a, b) => a.date.getTime() - b.date.getTime());
  }, [totalUpcoming, horizonDate, pastWindowStart]);

  const hasMore = useMemo(
    // An event's later span days may lie beyond the horizon even when its
    // start doesn't, so compare ends (end >= start always).
    () => totalUpcoming.some((e) => (e.end ?? e.start).getTime() > horizonDate.getTime()),
    [totalUpcoming, horizonDate]
  );

  // First non-past day row (today, or the next day with anything on it).
  // The grayed past days render ABOVE it, so on first paint we scroll it
  // into view — "Upcoming" should open at today, not at last week.
  const firstCurrentKey = useMemo(
    () => grouped.find((g) => endOfDay(g.date).getTime() >= now.getTime())?.key ?? null,
    [grouped, now]
  );
  const todayRef = useRef<HTMLDivElement | null>(null);
  const autoScrolled = useRef(false);
  useEffect(() => {
    if (autoScrolled.current) return;
    const el = todayRef.current;
    if (!el) return;
    // Nothing above to scroll past — leave the viewport alone.
    if (grouped.length > 0 && grouped[0].key === firstCurrentKey) { autoScrolled.current = true; return; }
    autoScrolled.current = true;
    el.scrollIntoView({ block: "start" });
  }, [grouped, firstCurrentKey]);

  useEffect(() => {
    if (!hasMore) return;
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((ent) => ent.isIntersecting)) {
          setHorizonDays((d) => d + LOAD_WINDOW_DAYS);
        }
      },
      { root: null, rootMargin: "200px 0px", threshold: 0 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, grouped.length]);

  const dayHeader = (date: Date) => {
    if (isToday(date)) return "Today";
    if (isTomorrow(date)) return "Tomorrow";
    if (isYesterday(date)) return "Yesterday";
    return format(date, "EEEE, MMMM d");
  };

  return (
    <div className="max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-3 px-1">
        <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wider">
          Upcoming
        </h2>
        <button
          onClick={onNewEvent}
          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-primary-600 hover:bg-primary-700 text-white rounded-lg transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          New event
        </button>
      </div>

      {totalUpcoming.length === 0 ? (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-10 text-center">
          <p className="text-sm text-gray-500 mb-4">
            No upcoming events. Use the calendar view to schedule something.
          </p>
          <button
            onClick={onNewEvent}
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-primary-600 hover:bg-primary-700 text-white text-sm rounded-lg transition-colors"
          >
            <Plus className="w-4 h-4" />
            New event
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {grouped.map(({ key, date, events }) => {
            const pastDay = endOfDay(date).getTime() < now.getTime();
            return (
            <div key={key} ref={key === firstCurrentKey ? todayRef : undefined}>
              <div
                className={`sticky top-0 z-10 -mx-1 px-2 py-1 backdrop-blur-sm rounded transition-colors ${
                  dragOverKey === key && draggingEvent && !isSameDay(draggingEvent.start, date)
                    ? "bg-primary-100 ring-2 ring-inset ring-primary-400"
                    : "bg-gradient-to-b from-gray-50 via-gray-50 to-gray-50/80"
                }`}
                onDragOver={(e) => handleDragOver(e, key)}
                onDragLeave={handleDragLeave}
                onDrop={(e) => handleDrop(e, date)}
              >
                <div className="flex items-baseline gap-2">
                  <h3 className={`text-sm font-semibold ${pastDay ? "text-gray-400" : "text-gray-900"}`}>
                    {dayHeader(date)}
                  </h3>
                  <span className="text-xs text-gray-400">
                    {format(date, "MMM d, yyyy")}
                  </span>
                  {dragOverKey === key && draggingEvent && !isSameDay(draggingEvent.start, date) && (
                    <span className="text-xs text-primary-600 font-medium ml-1">→ drop to move here</span>
                  )}
                </div>
              </div>
              <div className="space-y-2 mt-2">
                {events.map((event) => {
                  const cal = calendars.find((c) => event.calendarRefs.includes(c.dTag));
                  const color = cal?.color || "#4c6ef5";

                  // Grayed when this OCCURRENCE is over: for all-day
                  // events the whole day must have passed; for timed
                  // events, the slice ends at the event end (or its
                  // start, for point events) capped to this day.
                  const eventEnd = event.end ?? event.start;
                  const isPast = event.allDay
                    ? endOfDay(date).getTime() < now.getTime()
                    : Math.min(eventEnd.getTime(), endOfDay(date).getTime()) < now.getTime();
                  const isStartDay = isSameDay(event.start, date);

                  const description = (() => {
                    try {
                      const parsed = JSON.parse(event.content);
                      return parsed?.description || "";
                    } catch {
                      return event.content;
                    }
                  })();

                  const timeLabel = (() => {
                    if (event.allDay) {
                      if (event.end && !isSameDay(event.start, event.end)) {
                        return `All day — through ${format(event.end, "MMM d")}`;
                      }
                      return "All day";
                    }
                    if (!isStartDay && event.end) {
                      // Continuation day of a timed multi-day event.
                      const end = isSameDay(event.end, date)
                        ? format(event.end, "h:mm a")
                        : format(event.end, "MMM d, h:mm a");
                      return `Continues — until ${end}`;
                    }
                    const start = format(event.start, "h:mm a");
                    if (event.end) {
                      const end = isSameDay(event.start, event.end)
                        ? format(event.end, "h:mm a")
                        : format(event.end, "MMM d, h:mm a");
                      return `${start} — ${end}`;
                    }
                    return start;
                  })();

                  return (
                    <button
                      key={event.dTag}
                      draggable
                      onDragStart={(e) => handleDragStart(e, event)}
                      onDragEnd={handleDragEnd}
                      onClick={() => onEventClick(event)}
                      className={`w-full text-left bg-white border border-gray-200 hover:border-primary-300 hover:shadow-sm rounded-xl p-3 transition-all cursor-grab active:cursor-grabbing ${
                        isPast ? "opacity-55 hover:opacity-90" : ""
                      }`}
                    >
                      <div className="flex items-start gap-3">
                        <div
                          className="w-1.5 self-stretch rounded-full flex-shrink-0"
                          style={{ backgroundColor: color }}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-2">
                            <h4 className="font-medium text-gray-900 truncate">{event.title}</h4>
                            {event.seriesId && (
                              <Repeat className="w-3 h-3 text-gray-400 flex-shrink-0" />
                            )}
                          </div>
                          <div className="flex items-center gap-1.5 text-xs text-gray-600 mt-0.5">
                            <Clock className="w-3 h-3 flex-shrink-0" />
                            <span>{timeLabel}</span>
                          </div>
                          {event.location && (
                            <div className="flex items-center gap-1.5 text-xs text-gray-600 mt-1">
                              <MapPin className="w-3 h-3 flex-shrink-0" />
                              <span className="truncate">{event.location}</span>
                            </div>
                          )}
                          {event.link && (
                            <div className="flex items-center gap-1.5 text-xs mt-1">
                              <LinkIcon className="w-3 h-3 flex-shrink-0 text-gray-400" />
                              <span className="truncate text-primary-600">{event.link}</span>
                            </div>
                          )}
                          {event.hashtags.length > 0 && (
                            <div className="flex items-start gap-1.5 text-xs mt-1">
                              <Tag className="w-3 h-3 flex-shrink-0 text-gray-400 mt-0.5" />
                              <div className="flex flex-wrap gap-1">
                                {event.hashtags.map((t) => (
                                  <span
                                    key={t}
                                    className="px-1.5 py-0.5 rounded-full bg-primary-100 text-primary-800"
                                  >
                                    #{t}
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}
                          {description && (
                            <div className="flex items-start gap-1.5 text-xs text-gray-600 mt-1">
                              <FileText className="w-3 h-3 flex-shrink-0 text-gray-400 mt-0.5" />
                              <p className="whitespace-pre-wrap break-words line-clamp-2">
                                {description}
                              </p>
                            </div>
                          )}
                          {cal && (
                            <span
                              className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium text-white mt-2"
                              style={{ backgroundColor: color }}
                            >
                              {cal.title}
                            </span>
                          )}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
            );
          })}

          {/* Lazy-load sentinel — IntersectionObserver triggers horizon growth
              when it scrolls into view. */}
          {hasMore && (
            <div ref={sentinelRef} className="flex items-center justify-center py-6 text-xs text-gray-400">
              <Loader2 className="w-4 h-4 animate-spin mr-2" />
              Loading more…
            </div>
          )}
          {!hasMore && grouped.length > 0 && (
            <p className="text-center text-xs text-gray-400 py-4">
              That's everything upcoming.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
