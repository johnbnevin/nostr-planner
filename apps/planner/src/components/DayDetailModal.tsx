import { useMemo } from "react";
import { X, Plus, Clock, MapPin, Tag, FileText, Link as LinkIcon, Repeat } from "lucide-react";
import { format, isSameDay, startOfDay, endOfDay } from "date-fns";
import { useCalendar } from "../contexts/CalendarContext";
import type { CalendarEvent } from "../lib/nostr";

interface DayDetailModalProps {
  date: Date;
  onClose: () => void;
  onEventClick: (event: CalendarEvent) => void;
  onNewEvent: (date: Date) => void;
}

/**
 * All events on a single day, with every field spelled out (time range,
 * location, tags, description, link). Triggered by tapping the day number
 * in month view. More detailed than the per-cell event chip, and always
 * scrollable so even packed days stay readable on mobile.
 */
export function DayDetailModal({ date, onClose, onEventClick, onNewEvent }: DayDetailModalProps) {
  const { filteredEvents, calendars } = useCalendar();

  const events = useMemo(() => {
    const dayStart = startOfDay(date);
    const dayEnd = endOfDay(date);
    return filteredEvents
      .filter((e) => {
        const eEnd = e.end ?? e.start;
        return e.start.getTime() <= dayEnd.getTime() && eEnd.getTime() >= dayStart.getTime();
      })
      .sort((a, b) => {
        // All-day events first, then timed by start.
        if (a.allDay && !b.allDay) return -1;
        if (!a.allDay && b.allDay) return 1;
        return a.start.getTime() - b.start.getTime();
      });
  }, [filteredEvents, date]);

  const dayLabel = format(date, "EEEE, MMMM d, yyyy");

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-gray-200">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">{dayLabel}</h2>
            <p className="text-xs text-gray-500">
              {events.length === 0
                ? "No events"
                : `${events.length} event${events.length === 1 ? "" : "s"}`}
            </p>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => onNewEvent(date)}
              className="p-1.5 hover:bg-primary-50 text-primary-600 rounded-lg transition-colors"
              title="New event on this day"
            >
              <Plus className="w-4 h-4" />
            </button>
            <button
              onClick={onClose}
              className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {events.length === 0 ? (
            <div className="text-center py-10">
              <p className="text-sm text-gray-500 mb-4">No events scheduled for this day.</p>
              <button
                onClick={() => onNewEvent(date)}
                className="inline-flex items-center gap-1.5 px-4 py-2 bg-primary-600 hover:bg-primary-700 text-white text-sm rounded-lg transition-colors"
              >
                <Plus className="w-4 h-4" />
                Add event
              </button>
            </div>
          ) : (
            events.map((event) => {
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
                    return `All day — ${format(event.start, "MMM d")} to ${format(event.end, "MMM d")}`;
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
                      className="w-1.5 self-stretch rounded-full flex-shrink-0 mt-0.5"
                      style={{ backgroundColor: color }}
                    />
                    <div className="flex-1 min-w-0">
                      <h3 className="font-medium text-gray-900 truncate">{event.title}</h3>
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
                      {event.seriesId && (
                        <div className="flex items-center gap-1.5 text-xs text-gray-500 mt-1">
                          <Repeat className="w-3 h-3 flex-shrink-0" />
                          <span>Recurring</span>
                        </div>
                      )}
                      {description && (
                        <div className="flex items-start gap-1.5 text-xs text-gray-600 mt-1">
                          <FileText className="w-3 h-3 flex-shrink-0 text-gray-400 mt-0.5" />
                          <p className="whitespace-pre-wrap break-words line-clamp-3">{description}</p>
                        </div>
                      )}
                      {cal && (
                        <div className="mt-2">
                          <span
                            className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium text-white"
                            style={{ backgroundColor: color }}
                          >
                            {cal.title}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </div>

        <div className="p-3 border-t border-gray-100">
          <button
            onClick={onClose}
            className="w-full px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
