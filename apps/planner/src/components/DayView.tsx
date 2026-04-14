import { useMemo, useState, type DragEvent } from "react";
import { useCalendar } from "../contexts/CalendarContext";
import {
  eachHourOfInterval,
  isSameDay,
  format,
  set,
} from "date-fns";
import type { CalendarEvent } from "../lib/nostr";

interface DayViewProps {
  onEventClick: (event: CalendarEvent) => void;
  onTimeClick: (date: Date) => void;
}

export function DayView({ onEventClick, onTimeClick }: DayViewProps) {
  const { currentDate, filteredEvents: events, moveEvent } = useCalendar();
  const [dragOverHour, setDragOverHour] = useState<number | null>(null);

  const hours = useMemo(() => {
    const dayStart = set(currentDate, { hours: 0, minutes: 0, seconds: 0 });
    const dayEnd = set(currentDate, { hours: 23, minutes: 0, seconds: 0 });
    return eachHourOfInterval({ start: dayStart, end: dayEnd });
  }, [currentDate]);

  const dayEvents = useMemo(
    () => events.filter((e) => isSameDay(e.start, currentDate)),
    [events, currentDate]
  );

  const { allDayEvents, timedByHour } = useMemo(() => {
    const allDay: CalendarEvent[] = [];
    const byHour = new Map<number, CalendarEvent[]>();
    for (const e of dayEvents) {
      if (e.allDay) {
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
              return (
              <button
                key={event.dTag}
                draggable
                onDragStart={(e) => handleDragStart(e, event)}
                onClick={() => onEventClick(event)}
                className="block w-full text-left px-3 py-2 rounded-lg text-sm bg-primary-100 text-primary-800 hover:bg-primary-200 transition-colors cursor-grab active:cursor-grabbing"
              >
                <div className="font-medium">{event.title}</div>
                {event.hashtags.length > 0 && (
                  <div className="flex gap-1 mt-0.5 flex-wrap">
                    {event.hashtags.map((tag) => (
                      <span key={tag} className="text-[10px] bg-primary-200/60 rounded px-1 py-0.5">
                        #{tag}
                      </span>
                    ))}
                  </div>
                )}
                {desc && (
                  <div className="text-primary-700/70 text-xs mt-0.5 line-clamp-2">
                    {desc}
                  </div>
                )}
                {event.link && (
                  <div className="text-primary-500 text-xs mt-0.5 truncate">
                    {event.link}
                  </div>
                )}
                {event.location && (
                  <div className="text-primary-600 text-xs mt-0.5">
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
                isDragOver ? "bg-primary-50 ring-2 ring-inset ring-primary-300" : ""
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
                {hourEvents.map((event) => {
                  const desc = (() => {
                    try {
                      const p = JSON.parse(event.content);
                      return p?.description || "";
                    } catch {
                      return event.content;
                    }
                  })();
                  return (
                  <button
                    key={event.dTag}
                    draggable
                    onDragStart={(e) => {
                      e.stopPropagation();
                      handleDragStart(e, event);
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      onEventClick(event);
                    }}
                    className="block w-full text-left px-3 py-2 rounded-lg text-sm bg-emerald-100 text-emerald-800 hover:bg-emerald-200 transition-colors mb-1 cursor-grab active:cursor-grabbing"
                  >
                    <div className="font-medium">{event.title}</div>
                    {event.hashtags.length > 0 && (
                      <div className="flex gap-1 mt-0.5 flex-wrap">
                        {event.hashtags.map((tag) => (
                          <span key={tag} className="text-[10px] bg-emerald-200/60 rounded px-1 py-0.5">
                            #{tag}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="text-emerald-700 text-xs mt-0.5">
                      {format(event.start, "h:mm a")}
                      {event.end && ` - ${format(event.end, "h:mm a")}`}
                    </div>
                    {desc && (
                      <div className="text-emerald-700/70 text-xs mt-0.5 line-clamp-2">
                        {desc}
                      </div>
                    )}
                    {event.link && (
                      <div className="text-emerald-500 text-xs mt-0.5 truncate">
                        {event.link}
                      </div>
                    )}
                    {event.location && (
                      <div className="text-emerald-600 text-xs mt-0.5">
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
