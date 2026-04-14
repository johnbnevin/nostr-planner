import { useMemo, useState, type DragEvent } from "react";
import { useCalendar } from "../contexts/CalendarContext";
import {
  startOfWeek,
  endOfWeek,
  eachDayOfInterval,
  eachHourOfInterval,
  isSameDay,
  isToday,
  format,
  set,
} from "date-fns";
import type { CalendarEvent } from "../lib/nostr";

interface WeekViewProps {
  onEventClick: (event: CalendarEvent) => void;
  onDateClick: (date: Date) => void;
}

export function WeekView({ onEventClick, onDateClick }: WeekViewProps) {
  const { currentDate, filteredEvents: events, moveEvent } = useCalendar();
  const [dragOverCell, setDragOverCell] = useState<string | null>(null);

  const days = useMemo(() => {
    return eachDayOfInterval({
      start: startOfWeek(currentDate),
      end: endOfWeek(currentDate),
    });
  }, [currentDate]);

  const hours = useMemo(() => {
    const dayStart = set(currentDate, {
      hours: 0,
      minutes: 0,
      seconds: 0,
    });
    const dayEnd = set(currentDate, {
      hours: 23,
      minutes: 0,
      seconds: 0,
    });
    return eachHourOfInterval({ start: dayStart, end: dayEnd });
  }, [currentDate]);

  // Pre-index events by day-hour key for O(1) lookup instead of O(n) per cell
  const { timedByDayHour, allDayByDay } = useMemo(() => {
    const timed = new Map<string, CalendarEvent[]>();
    const allDay = new Map<string, CalendarEvent[]>();
    for (const e of events) {
      const dayKey = format(e.start, "yyyy-MM-dd");
      if (e.allDay) {
        if (!allDay.has(dayKey)) allDay.set(dayKey, []);
        allDay.get(dayKey)!.push(e);
      } else {
        const key = `${dayKey}-${e.start.getHours()}`;
        if (!timed.has(key)) timed.set(key, []);
        timed.get(key)!.push(e);
      }
    }
    return { timedByDayHour: timed, allDayByDay: allDay };
  }, [events]);

  const getEventsForDayHour = (day: Date, hour: number) =>
    timedByDayHour.get(`${format(day, "yyyy-MM-dd")}-${hour}`) || [];

  const getAllDayEvents = (day: Date) =>
    allDayByDay.get(format(day, "yyyy-MM-dd")) || [];

  const handleDragStart = (e: DragEvent, event: CalendarEvent) => {
    e.dataTransfer.setData("text/plain", JSON.stringify({ dTag: event.dTag }));
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDragOver = (e: DragEvent, cellKey: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverCell(cellKey);
  };

  const handleDragLeave = () => {
    setDragOverCell(null);
  };

  const handleDropOnHour = (e: DragEvent, day: Date, hour: number) => {
    e.preventDefault();
    setDragOverCell(null);
    try {
      const data = JSON.parse(e.dataTransfer.getData("text/plain"));
      const event = events.find((ev) => ev.dTag === data.dTag);
      if (!event) return;
      const newStart = set(day, { hours: hour, minutes: event.allDay ? 0 : event.start.getMinutes() });
      if (event.start.getTime() === newStart.getTime()) return;
      moveEvent(event, newStart);
    } catch { /* invalid */ }
  };

  const handleDropOnAllDay = (e: DragEvent, day: Date) => {
    e.preventDefault();
    setDragOverCell(null);
    try {
      const data = JSON.parse(e.dataTransfer.getData("text/plain"));
      const event = events.find((ev) => ev.dTag === data.dTag);
      if (!event || !event.allDay) return;
      if (isSameDay(event.start, day)) return;
      moveEvent(event, day);
    } catch { /* invalid */ }
  };

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
      {/* All-day events row */}
      <div className="grid grid-cols-[60px_repeat(7,1fr)] border-b border-gray-200">
        <div className="p-2 text-xs text-gray-400 border-r border-gray-100">
          All day
        </div>
        {days.map((day) => {
          const allDay = getAllDayEvents(day);
          const cellKey = `allday-${day.toISOString()}`;
          return (
            <div
              key={day.toISOString()}
              className={`p-1 border-r border-gray-100 min-h-[40px] transition-colors ${
                dragOverCell === cellKey ? "bg-primary-50 ring-2 ring-inset ring-primary-300" : ""
              }`}
              onDragOver={(e) => handleDragOver(e, cellKey)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDropOnAllDay(e, day)}
            >
              {allDay.map((event) => {
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
                  className="w-full text-left px-1.5 py-0.5 rounded text-xs bg-primary-100 text-primary-800 hover:bg-primary-200 mb-0.5 cursor-grab active:cursor-grabbing"
                >
                  <div className="font-medium truncate">{event.title}</div>
                  {event.hashtags.length > 0 && (
                    <div className="truncate text-primary-600 text-[10px]">
                      {event.hashtags.map((t) => `#${t}`).join(" ")}
                    </div>
                  )}
                  {desc && (
                    <div className="truncate text-primary-700/70 text-[10px]">{desc}</div>
                  )}
                  {event.link && (
                    <div className="truncate text-primary-500 text-[10px]">{event.link}</div>
                  )}
                  {event.location && (
                    <div className="truncate text-primary-600 text-[10px]">{event.location}</div>
                  )}
                </button>
                );
              })}
            </div>
          );
        })}
      </div>

      {/* Day headers */}
      <div className="grid grid-cols-[60px_repeat(7,1fr)] border-b border-gray-200 sticky top-[57px] bg-white z-10">
        <div className="border-r border-gray-100" />
        {days.map((day) => (
          <div
            key={day.toISOString()}
            className={`py-2 text-center border-r border-gray-100 ${
              isToday(day) ? "bg-primary-50" : ""
            }`}
          >
            <div className="text-xs text-gray-500 uppercase">
              {format(day, "EEE")}
            </div>
            <div
              className={`text-lg font-semibold ${
                isToday(day) ? "text-primary-600" : "text-gray-900"
              }`}
            >
              {format(day, "d")}
            </div>
          </div>
        ))}
      </div>

      {/* Time grid */}
      <div className="overflow-y-auto max-h-[calc(100vh-240px)]">
        {hours.map((hour) => (
          <div
            key={hour.toISOString()}
            className="grid grid-cols-[60px_repeat(7,1fr)] border-b border-gray-100"
          >
            <div className="p-1 text-xs text-gray-400 text-right pr-2 border-r border-gray-100">
              {format(hour, "h a")}
            </div>
            {days.map((day) => {
              const hourEvents = getEventsForDayHour(
                day,
                hour.getHours()
              );
              const cellKey = `${day.toISOString()}-${hour.getHours()}`;
              return (
                <div
                  key={day.toISOString()}
                  className={`border-r border-gray-100 min-h-[48px] p-0.5 cursor-pointer hover:bg-gray-50 transition-colors ${
                    dragOverCell === cellKey ? "bg-primary-50 ring-2 ring-inset ring-primary-300" : ""
                  }`}
                  onClick={() => {
                    const clickDate = set(day, {
                      hours: hour.getHours(),
                      minutes: 0,
                    });
                    onDateClick(clickDate);
                  }}
                  onDragOver={(e) => handleDragOver(e, cellKey)}
                  onDragLeave={handleDragLeave}
                  onDrop={(e) => handleDropOnHour(e, day, hour.getHours())}
                >
                  {hourEvents.map((event) => {
                    const desc = (() => {
                      try { const p = JSON.parse(event.content); return p?.description || ""; }
                      catch { return event.content; }
                    })();
                    return (
                    <button
                      key={event.dTag}
                      draggable
                      onDragStart={(e) => handleDragStart(e, event)}
                      onClick={(e) => {
                        e.stopPropagation();
                        onEventClick(event);
                      }}
                      className="w-full text-left px-1.5 py-0.5 rounded text-xs bg-emerald-100 text-emerald-800 hover:bg-emerald-200 mb-0.5 cursor-grab active:cursor-grabbing"
                    >
                      <div className="font-medium truncate">{event.title}</div>
                      {event.hashtags.length > 0 && (
                        <div className="truncate text-emerald-600 text-[10px]">
                          {event.hashtags.map((t) => `#${t}`).join(" ")}
                        </div>
                      )}
                      <div className="truncate text-emerald-600 text-[10px]">
                        {format(event.start, "h:mm")}
                        {event.end && ` - ${format(event.end, "h:mm")}`}
                      </div>
                      {desc && (
                        <div className="truncate text-emerald-700/70 text-[10px]">{desc}</div>
                      )}
                      {event.link && (
                        <div className="truncate text-emerald-500 text-[10px]">{event.link}</div>
                      )}
                      {event.location && (
                        <div className="truncate text-emerald-600 text-[10px]">{event.location}</div>
                      )}
                    </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
