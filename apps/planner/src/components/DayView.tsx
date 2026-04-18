import { useMemo, useState, type DragEvent } from "react";
import { useCalendar } from "../contexts/CalendarContext";
import {
  eachHourOfInterval,
  isSameDay,
  startOfDay,
  endOfDay,
  format,
  set,
} from "date-fns";
import type { CalendarEvent } from "../lib/nostr";

interface DayViewProps {
  onEventClick: (event: CalendarEvent) => void;
  onTimeClick: (date: Date) => void;
}

export function DayView({ onEventClick, onTimeClick }: DayViewProps) {
  const { currentDate, filteredEvents: events, calendars, moveEvent } = useCalendar();
  const [dragOverHour, setDragOverHour] = useState<number | null>(null);
  const [draggingEvent, setDraggingEvent] = useState<CalendarEvent | null>(null);

  const colorForEvent = (event: CalendarEvent): string | undefined => {
    const cal = calendars.find((c) => event.calendarRefs.includes(c.dTag));
    return cal?.color;
  };

  const hours = useMemo(() => {
    const dayStart = set(currentDate, { hours: 0, minutes: 0, seconds: 0 });
    const dayEnd = set(currentDate, { hours: 23, minutes: 0, seconds: 0 });
    return eachHourOfInterval({ start: dayStart, end: dayEnd });
  }, [currentDate]);

  // An event belongs to this day if any part of [start, end] overlaps it.
  // Multi-day events therefore show up on every day they cover, not just
  // their start day.
  const dayEvents = useMemo(() => {
    const dayStart = startOfDay(currentDate);
    const dayEnd = endOfDay(currentDate);
    return events.filter((e) => {
      const eEnd = e.end ?? e.start;
      return e.start.getTime() <= dayEnd.getTime() && eEnd.getTime() >= dayStart.getTime();
    });
  }, [events, currentDate]);

  // Timed events that cross midnight are shown in the all-day area on each
  // covered day so we don't have to pick an arbitrary hour to place them in.
  const { allDayEvents, timedByHour } = useMemo(() => {
    const allDay: CalendarEvent[] = [];
    const byHour = new Map<number, CalendarEvent[]>();
    for (const e of dayEvents) {
      const crossesMidnight =
        !!e.end && !isSameDay(e.start, e.end) && e.end.getTime() > e.start.getTime();
      if (e.allDay || crossesMidnight) {
        allDay.push(e);
      } else {
        const h = e.start.getHours();
        if (!byHour.has(h)) byHour.set(h, []);
        byHour.get(h)!.push(e);
      }
    }
    return { allDayEvents: allDay, timedByHour: byHour };
  }, [dayEvents]);

  const getEventsForHour = (hour: number) =>
    timedByHour.get(hour) || [];

  const handleDragStart = (e: DragEvent, event: CalendarEvent) => {
    e.dataTransfer.setData("text/plain", JSON.stringify({ dTag: event.dTag }));
    e.dataTransfer.effectAllowed = "move";
    setDraggingEvent(event);
  };

  const handleDragEnd = () => {
    setDraggingEvent(null);
    setDragOverHour(null);
  };

  const handleDragOver = (e: DragEvent, hour: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverHour(hour);
  };

  const handleDragLeave = () => {
    setDragOverHour(null);
  };

  const handleDrop = (e: DragEvent, hour: number) => {
    e.preventDefault();
    setDragOverHour(null);
    setDraggingEvent(null);
    try {
      const data = JSON.parse(e.dataTransfer.getData("text/plain"));
      const event = events.find((ev) => ev.dTag === data.dTag);
      if (!event || event.allDay) return;
      const newStart = set(currentDate, { hours: hour, minutes: event.start.getMinutes() });
      if (event.start.getTime() === newStart.getTime()) return;
      moveEvent(event, newStart);
    } catch { /* invalid */ }
  };

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
      {/* All-day events */}
      {allDayEvents.length > 0 && (
        <div className="p-3 border-b border-gray-200 bg-gray-50">
          <div className="text-xs text-gray-400 mb-1">All day</div>
          <div className="space-y-1">
            {allDayEvents.map((event) => {
              const desc = (() => {
                try { const p = JSON.parse(event.content); return p?.description || ""; }
                catch { return event.content; }
              })();
              const color = colorForEvent(event);
              return (
              <button
                key={event.dTag}
                draggable
                onDragStart={(e) => handleDragStart(e, event)}
                onDragEnd={handleDragEnd}
                onClick={() => onEventClick(event)}
                className={`block w-full text-left px-3 py-2 rounded-lg text-sm transition-colors cursor-grab active:cursor-grabbing ${
                  color ? "text-white hover:opacity-80" : "bg-primary-100 text-primary-800 hover:bg-primary-200"
                }`}
                style={color ? { backgroundColor: color } : undefined}
              >
                <div className="font-medium">{event.title}</div>
                {event.hashtags.length > 0 && (
                  <div className="flex gap-1 mt-0.5 flex-wrap">
                    {event.hashtags.map((tag) => (
                      <span key={tag} className={`text-[10px] rounded px-1 py-0.5 ${color ? "bg-white/20" : "bg-primary-200/60"}`}>
                        #{tag}
                      </span>
                    ))}
                  </div>
                )}
                {desc && (
                  <div className={`text-xs mt-0.5 line-clamp-2 ${color ? "opacity-90" : "text-primary-700/70"}`}>
                    {desc}
                  </div>
                )}
                {event.link && (
                  <div className={`text-xs mt-0.5 truncate ${color ? "opacity-90" : "text-primary-500"}`}>
                    {event.link}
                  </div>
                )}
                {event.location && (
                  <div className={`text-xs mt-0.5 ${color ? "opacity-90" : "text-primary-600"}`}>
                    {event.location}
                  </div>
                )}
              </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Hour grid */}
      <div className="overflow-y-auto max-h-[calc(100vh-200px)]">
        {hours.map((hour) => {
          const hourEvents = getEventsForHour(hour.getHours());
          const isDragOver = dragOverHour === hour.getHours();
          return (
            <div
              key={hour.toISOString()}
              className={`flex border-b border-gray-100 min-h-[60px] cursor-pointer hover:bg-gray-50 transition-colors ${
                isDragOver ? "bg-primary-100 ring-2 ring-inset ring-primary-500 shadow-inner" : ""
              }`}
              onClick={() => {
                const clickDate = set(currentDate, {
                  hours: hour.getHours(),
                  minutes: 0,
                });
                onTimeClick(clickDate);
              }}
              onDragOver={(e) => handleDragOver(e, hour.getHours())}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, hour.getHours())}
            >
              <div className="w-20 flex-shrink-0 p-2 text-sm text-gray-400 text-right pr-3 border-r border-gray-100">
                {format(hour, "h a")}
              </div>
              <div className="flex-1 p-1">
                {isDragOver && draggingEvent && !draggingEvent.allDay && (
                  <div className="mb-1 px-3 py-1.5 rounded-lg border-2 border-dashed border-primary-500 bg-primary-100/80 text-sm font-medium text-primary-800 pointer-events-none">
                    &rarr; {draggingEvent.title} at {format(hour, "h a")}
                  </div>
                )}
                {hourEvents.map((event) => {
                  const desc = (() => {
                    try {
                      const p = JSON.parse(event.content);
                      return p?.description || "";
                    } catch {
                      return event.content;
                    }
                  })();
                  const color = colorForEvent(event);
                  return (
                  <button
                    key={event.dTag}
                    draggable
                    onDragStart={(e) => {
                      e.stopPropagation();
                      handleDragStart(e, event);
                    }}
                    onDragEnd={handleDragEnd}
                    onClick={(e) => {
                      e.stopPropagation();
                      onEventClick(event);
                    }}
                    className={`block w-full text-left px-3 py-2 rounded-lg text-sm transition-colors mb-1 cursor-grab active:cursor-grabbing ${
                      color ? "text-white hover:opacity-80" : "bg-emerald-100 text-emerald-800 hover:bg-emerald-200"
                    }`}
                    style={color ? { backgroundColor: color } : undefined}
                  >
                    <div className="font-medium">{event.title}</div>
                    {event.hashtags.length > 0 && (
                      <div className="flex gap-1 mt-0.5 flex-wrap">
                        {event.hashtags.map((tag) => (
                          <span key={tag} className={`text-[10px] rounded px-1 py-0.5 ${color ? "bg-white/20" : "bg-emerald-200/60"}`}>
                            #{tag}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className={`text-xs mt-0.5 ${color ? "opacity-90" : "text-emerald-700"}`}>
                      {format(event.start, "h:mm a")}
                      {event.end && ` - ${format(event.end, "h:mm a")}`}
                    </div>
                    {desc && (
                      <div className={`text-xs mt-0.5 line-clamp-2 ${color ? "opacity-90" : "text-emerald-700/70"}`}>
                        {desc}
                      </div>
                    )}
                    {event.link && (
                      <div className={`text-xs mt-0.5 truncate ${color ? "opacity-90" : "text-emerald-500"}`}>
                        {event.link}
                      </div>
                    )}
                    {event.location && (
                      <div className={`text-xs mt-0.5 ${color ? "opacity-90" : "text-emerald-600"}`}>
                        {event.location}
                      </div>
                    )}
                  </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
