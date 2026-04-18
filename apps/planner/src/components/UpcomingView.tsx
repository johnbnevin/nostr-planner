import { useMemo, useRef, useState, useEffect } from "react";
import { Clock, MapPin, Tag, Link as LinkIcon, FileText, Repeat, Plus, Loader2 } from "lucide-react";
import { format, isSameDay, isToday, isTomorrow, isYesterday, addDays, startOfDay } from "date-fns";
import { useCalendar } from "../contexts/CalendarContext";
import type { CalendarEvent } from "../lib/nostr";

interface UpcomingViewProps {
  onEventClick: (event: CalendarEvent) => void;
  onNewEvent: () => void;
}

const LOAD_WINDOW_DAYS = 30;
const INITIAL_WINDOW_DAYS = 60;

/**
 * Scrolling list of upcoming events starting from today. Shows every field
 * (time, location, tags, description, link, recurrence badge) grouped by
 * date. Lazy-loads further into the future — each time the bottom sentinel
 * enters the viewport, the horizon advances another LOAD_WINDOW_DAYS.
 *
 * Past events are not shown; use the calendar view to navigate backwards.
 */
export function UpcomingView({ onEventClick, onNewEvent }: UpcomingViewProps) {
  const { filteredEvents, calendars } = useCalendar();
  // How many days into the future to show. Grows on scroll.
  const [horizonDays, setHorizonDays] = useState(INITIAL_WINDOW_DAYS);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const now = useMemo(() => new Date(), []);
  const horizonDate = useMemo(() => addDays(startOfDay(now), horizonDays), [now, horizonDays]);

  const totalUpcoming = useMemo(
    () =>
      filteredEvents
        .filter((e) => {
          const eEnd = e.end ?? e.start;
          return eEnd.getTime() >= now.getTime();
        })
        .sort((a, b) => a.start.getTime() - b.start.getTime()),
    [filteredEvents, now]
  );

  // Group the visible slice by day.
  const grouped = useMemo(() => {
    const horizonMs = horizonDate.getTime();
    const rows: { key: string; date: Date; events: CalendarEvent[] }[] = [];
    const byKey = new Map<string, { date: Date; events: CalendarEvent[] }>();
    for (const e of totalUpcoming) {
      if (e.start.getTime() > horizonMs) break;
      const key = format(e.start, "yyyy-MM-dd");
      let entry = byKey.get(key);
      if (!entry) {
        entry = { date: startOfDay(e.start), events: [] };
        byKey.set(key, entry);
        rows.push({ key, ...entry });
      }
      entry.events.push(e);
    }
    // Reorder rows to match insertion (already chronological since input was sorted).
    return rows;
  }, [totalUpcoming, horizonDate]);

  const hasMore = useMemo(() => {
    const lastEvent = totalUpcoming[totalUpcoming.length - 1];
    return !!lastEvent && lastEvent.start.getTime() > horizonDate.getTime();
  }, [totalUpcoming, horizonDate]);

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
          {grouped.map(({ key, date, events }) => (
            <div key={key}>
              <div className="sticky top-0 z-10 -mx-1 px-2 py-1 bg-gradient-to-b from-gray-50 via-gray-50 to-gray-50/80 backdrop-blur-sm">
                <div className="flex items-baseline gap-2">
                  <h3 className="text-sm font-semibold text-gray-900">
                    {dayHeader(date)}
                  </h3>
                  <span className="text-xs text-gray-400">
                    {format(date, "MMM d, yyyy")}
                  </span>
                </div>
              </div>
              <div className="space-y-2 mt-2">
                {events.map((event) => {
                  const cal = calendars.find((c) => event.calendarRefs.includes(c.dTag));
                  const color = cal?.color || "#4c6ef5";

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
                      onClick={() => onEventClick(event)}
                      className="w-full text-left bg-white border border-gray-200 hover:border-primary-300 hover:shadow-sm rounded-xl p-3 transition-all"
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
          ))}

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
