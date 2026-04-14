import { useMemo, useState, type DragEvent } from "react";
import { useCalendar } from "../contexts/CalendarContext";
import {
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  eachDayOfInterval,
  isSameMonth,
  isSameDay,
  isToday,
  format,
  set,
} from "date-fns";
import type { CalendarEvent } from "../lib/nostr";

interface MonthViewProps {
  onEventClick: (event: CalendarEvent) => void;
  onDateClick: (date: Date) => void;
}

export function MonthView({ onEventClick, onDateClick }: MonthViewProps) {
  const { currentDate, filteredEvents: events, calendars, moveEvent } = useCalendar();
  const [dragOverDate, setDragOverDate] = useState<string | null>(null);

  const days = useMemo(() => {
    const monthStart = startOfMonth(currentDate);
    const monthEnd = endOfMonth(currentDate);
    const calStart = startOfWeek(monthStart);
    const calEnd = endOfWeek(monthEnd);
    return eachDayOfInterval({ start: calStart, end: calEnd });
  }, [currentDate]);

  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const event of events) {
      const key = format(event.start, "yyyy-MM-dd");
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(event);
    }
    return map;
  }, [events]);

  const weekDays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  const handleDragStart = (e: DragEvent, event: CalendarEvent) => {
    e.dataTransfer.setData("text/plain", JSON.stringify({ dTag: event.dTag, kind: event.kind }));
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDragOver = (e: DragEvent, dateKey: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverDate(dateKey);
  };

  const handleDragLeave = () => {
    setDragOverDate(null);
  };

  const handleDrop = (e: DragEvent, day: Date) => {
    e.preventDefault();
    setDragOverDate(null);
    try {
      const data = JSON.parse(e.dataTransfer.getData("text/plain"));
      const event = events.find((ev) => ev.dTag === data.dTag);
      if (!event || isSameDay(event.start, day)) return;

      // Preserve time-of-day for timed events
      const newStart = event.allDay
        ? day
        : set(day, { hours: event.start.getHours(), minutes: event.start.getMinutes() });
      moveEvent(event, newStart);
    } catch { /* invalid drag data */ }
  };

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
      {/* Day headers */}
      <div className="grid grid-cols-7 border-b border-gray-200">
        {weekDays.map((day) => (
          <div
            key={day}
            className="py-2 text-center text-xs font-semibold text-gray-500 uppercase tracking-wider"
          >
            {day}
          </div>
        ))}
      </div>

      {/* Day cells */}
      <div className="grid grid-cols-7">
        {days.map((day) => {
          const key = format(day, "yyyy-MM-dd");
          const dayEvents = eventsByDay.get(key) || [];
          const inMonth = isSameMonth(day, currentDate);
          const today = isToday(day);
          const isDragOver = dragOverDate === key;

          return (
            <div
              key={key}
              className={`min-h-[100px] border-b border-r border-gray-100 p-1 cursor-pointer hover:bg-gray-50 transition-colors ${
                !inMonth ? "bg-gray-50/50" : ""
              } ${isDragOver ? "bg-primary-50 ring-2 ring-inset ring-primary-300" : ""}`}
              onClick={() => onDateClick(day)}
              onDragOver={(e) => handleDragOver(e, key)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, day)}
            >
              <div className="flex items-center justify-center mb-1">
                <span
                  className={`text-sm w-7 h-7 flex items-center justify-center rounded-full ${
                    today
                      ? "bg-primary-600 text-white font-bold"
                      : inMonth
                        ? "text-gray-900"
                        : "text-gray-400"
                  }`}
                >
                  {format(day, "d")}
                </span>
              </div>

              <div className="space-y-0.5">
                {dayEvents.slice(0, 3).map((event) => {
                  const cal = calendars.find((c) =>
                    event.calendarRefs.includes(c.dTag)
                  );
                  const color = cal?.color;
                  return (
                  <button
                    key={event.dTag}
                    draggable
                    onDragStart={(e) => handleDragStart(e, event)}
                    onClick={(e) => {
                      e.stopPropagation();
                      onEventClick(event);
                    }}
                    className={`w-full text-left px-1.5 py-0.5 rounded text-xs transition-colors cursor-grab active:cursor-grabbing ${
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
                  <div className="text-xs text-gray-400 pl-1.5">
                    +{dayEvents.length - 3} more
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
