import { useState, useMemo, type DragEvent } from "react";
import { useTasks } from "../contexts/TasksContext";
import type { HabitStatsBundle } from "../contexts/TasksContext";
import { useCalendar } from "../contexts/CalendarContext";
import { Plus, X, ChevronLeft, ChevronRight, Check, GripVertical, Pencil, BarChart3, ChevronDown as ChevronDownIcon } from "lucide-react";
import { format, addDays, subDays } from "date-fns";

export function DailyHabitsView() {
  const { habits, addHabit, removeHabit, renameHabit, toggleHabitCompletion, isHabitDone, getHabitStats, reorderHabits, loading: tasksLoading } =
    useTasks();
  const { currentDate, setCurrentDate } = useCalendar();
  const [newHabit, setNewHabit] = useState("");
  const [adding, setAdding] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [showStats, setShowStats] = useState(false);
  const [statsWindow, setStatsWindow] = useState<"last7" | "last30" | "last365" | "allTime">("last7");

  const dateStr = format(currentDate, "yyyy-MM-dd");
  const doneCount = habits.filter((h) => isHabitDone(h.id, dateStr)).length;

  const handleAdd = async () => {
    if (!newHabit.trim()) return;
    setAdding(true);
    try {
      await addHabit(newHabit.trim());
      setNewHabit("");
    } finally {
      setAdding(false);
    }
  };

  const handleStartRename = (habit: { id: string; title: string }) => {
    setRenamingId(habit.id);
    setRenameValue(habit.title);
  };

  const handleRename = async () => {
    if (!renamingId || !renameValue.trim()) {
      setRenamingId(null);
      return;
    }
    await renameHabit(renamingId, renameValue.trim());
    setRenamingId(null);
  };

  // Dragging + drop-target visuals are driven by state (handled in row
  // styles) so we no longer need imperative opacity manipulation.
  const handleDragStart = (e: DragEvent<HTMLDivElement>, index: number) => {
    setDragIndex(index);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(index));
  };

  const handleDragEnd = () => {
    setDragIndex(null);
    setDragOverIndex(null);
  };

  const handleDragOver = (e: DragEvent<HTMLDivElement>, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dragIndex !== null && index !== dragIndex) {
      setDragOverIndex(index);
    }
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>, toIndex: number) => {
    e.preventDefault();
    if (dragIndex !== null && dragIndex !== toIndex) {
      reorderHabits(dragIndex, toIndex);
    }
    setDragIndex(null);
    setDragOverIndex(null);
  };

  return (
    <div className="max-w-lg mx-auto">
      {/* Section header */}
      <h2 className="text-sm font-semibold text-emerald-700 uppercase tracking-wider mb-2 px-1">
        Daily Habits
      </h2>

      <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
        {/* Date nav */}
        <div className="flex items-center justify-between p-4 border-b border-gray-100">
          <button
            onClick={() => setCurrentDate(subDays(currentDate, 1))}
            className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
          <div className="text-center">
            <div className="font-semibold text-gray-900">
              {format(currentDate, "EEEE, MMMM d")}
            </div>
            <div className="text-xs text-gray-400">
              {doneCount}/{habits.length} completed
            </div>
          </div>
          <button
            onClick={() => setCurrentDate(addDays(currentDate, 1))}
            className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <ChevronRight className="w-5 h-5" />
          </button>
        </div>

        {/* Progress bar */}
        {habits.length > 0 && (
          <div className="h-1.5 bg-gray-100">
            <div
              className="h-full bg-emerald-500 transition-all duration-300"
              style={{
                width: `${(doneCount / habits.length) * 100}%`,
              }}
            />
          </div>
        )}

        {/* Habit list */}
        <div className="divide-y divide-gray-100">
          {habits.length === 0 && tasksLoading && (
            <div className="flex items-center justify-center gap-2 py-1.5 my-2 bg-primary-50 text-primary-700 text-sm rounded-lg">
              <div className="animate-spin rounded-full h-3.5 w-3.5 border-b-2 border-primary-600" />
              Loading habits…
            </div>
          )}
          {habits.length === 0 && !tasksLoading && (
            <div className="p-8 text-center text-gray-400 text-sm">
              No daily habits yet. Add things you want to do every day.
            </div>
          )}
          {habits.map((habit, index) => {
            const done = isHabitDone(habit.id, dateStr);
            const isOver = dragOverIndex === index && dragIndex !== index;
            const isDragging = dragIndex === index;
            return (
              <div
                key={habit.id}
                onDragOver={(e) => handleDragOver(e, index)}
                onDrop={(e) => handleDrop(e, index)}
                className={`relative flex items-center gap-2 px-2 py-3 transition-colors group ${
                  isDragging ? "bg-emerald-50/40 opacity-50" : "hover:bg-gray-50"
                }`}
              >
                {/* Prominent drop-target bar — thick emerald line with end
                    dots so the landing spot is unmistakable. */}
                {isOver && (
                  <div className="pointer-events-none absolute -top-0.5 left-0 right-0 h-1 bg-emerald-500 shadow-md shadow-emerald-300/50">
                    <div className="absolute -left-1 -top-0.5 w-2 h-2 rounded-full bg-emerald-500" />
                    <div className="absolute -right-1 -top-0.5 w-2 h-2 rounded-full bg-emerald-500" />
                  </div>
                )}
                {/* Grip handle — ONLY this is draggable so accidentally
                    dragging when trying to tap the checkbox doesn't happen.
                    Larger tap target (w-8 h-8) for mobile. */}
                <div
                  draggable
                  onDragStart={(e) => handleDragStart(e, index)}
                  onDragEnd={handleDragEnd}
                  className="w-8 h-8 flex items-center justify-center cursor-grab active:cursor-grabbing text-gray-300 hover:text-emerald-500 hover:bg-emerald-50 rounded flex-shrink-0 touch-none"
                  title="Drag to reorder"
                >
                  <GripVertical className="w-5 h-5" />
                </div>
                <button
                  onClick={() => toggleHabitCompletion(habit.id, dateStr)}
                  className={`w-6 h-6 rounded-full border-2 flex items-center justify-center transition-colors flex-shrink-0 ${
                    done
                      ? "bg-emerald-500 border-emerald-500 text-white"
                      : "border-gray-300 hover:border-emerald-400"
                  }`}
                >
                  {done && <Check className="w-3.5 h-3.5" />}
                </button>
                {renamingId === habit.id ? (
                  <input
                    autoFocus
                    type="text"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={handleRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleRename();
                      if (e.key === "Escape") setRenamingId(null);
                    }}
                    className="flex-1 text-sm bg-transparent border-b border-primary-400 focus:outline-none py-0"
                  />
                ) : (
                  <span
                    className={`flex-1 text-sm ${
                      done ? "text-gray-400 line-through" : "text-gray-800"
                    }`}
                  >
                    {habit.title}
                  </span>
                )}
                <button
                  onClick={() => handleStartRename(habit)}
                  className="p-1 opacity-0 group-hover:opacity-100 hover:text-primary-600 text-gray-400 transition-all"
                  title="Rename"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => removeHabit(habit.id)}
                  className="p-1 opacity-0 group-hover:opacity-100 hover:text-red-500 text-gray-400 transition-all"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            );
          })}
        </div>

        {/* Add habit */}
        <div className="p-3 border-t border-gray-100">
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="Add daily habit..."
              value={newHabit}
              onChange={(e) => setNewHabit(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleAdd();
              }}
              className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
            <button
              onClick={handleAdd}
              disabled={!newHabit.trim() || adding}
              className="flex items-center gap-1 px-3 py-2 bg-primary-600 hover:bg-primary-700 text-white text-sm rounded-lg transition-colors disabled:opacity-50"
            >
              <Plus className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Statistics section */}
      {habits.length > 0 && (
        <div className="mt-4">
          <button
            onClick={() => setShowStats(!showStats)}
            className="flex items-center gap-2 text-sm font-semibold text-emerald-700 uppercase tracking-wider mb-2 px-1 hover:text-emerald-800"
          >
            <BarChart3 className="w-4 h-4" />
            Statistics
            <ChevronDownIcon className={`w-4 h-4 transition-transform ${showStats ? "" : "-rotate-90"}`} />
          </button>

          {showStats && (
            <HabitStatsPanel
              habits={habits}
              getHabitStats={getHabitStats}
              statsWindow={statsWindow}
              setStatsWindow={setStatsWindow}
            />
          )}
        </div>
      )}
    </div>
  );
}

const WINDOW_LABELS: Record<string, string> = {
  last7: "7 Days",
  last30: "30 Days",
  last365: "Year",
  allTime: "All Time",
};

function HabitStatsPanel({
  habits,
  getHabitStats,
  statsWindow,
  setStatsWindow,
}: {
  habits: { id: string; title: string }[];
  getHabitStats: (id: string) => HabitStatsBundle;
  statsWindow: "last7" | "last30" | "last365" | "allTime";
  setStatsWindow: (w: "last7" | "last30" | "last365" | "allTime") => void;
}) {
  const allStats = useMemo(
    () => habits.map((h) => ({ habit: h, stats: getHabitStats(h.id) })),
    [habits, getHabitStats]
  );

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
      {/* Window selector */}
      <div className="flex border-b border-gray-100">
        {(["last7", "last30", "last365", "allTime"] as const).map((w) => (
          <button
            key={w}
            onClick={() => setStatsWindow(w)}
            className={`flex-1 px-3 py-2.5 text-xs font-medium transition-colors ${
              statsWindow === w
                ? "text-emerald-700 bg-emerald-50 border-b-2 border-emerald-500"
                : "text-gray-500 hover:text-gray-700 hover:bg-gray-50"
            }`}
          >
            {WINDOW_LABELS[w]}
          </button>
        ))}
      </div>

      {/* Per-habit stats */}
      <div className="divide-y divide-gray-100">
        {allStats.map(({ habit, stats }) => {
          const s = stats[statsWindow];
          return (
            <div key={habit.id} className="px-4 py-3">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-sm font-medium text-gray-800 truncate">{habit.title}</span>
                <span className="text-xs text-gray-500 flex-shrink-0 ml-2">
                  {s.completed}/{s.total} days ({s.rate}%)
                </span>
              </div>
              {/* Progress bar */}
              <div className="h-2 bg-gray-100 rounded-full overflow-hidden mb-1.5">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${
                    s.rate >= 80 ? "bg-emerald-500" : s.rate >= 50 ? "bg-amber-400" : "bg-red-400"
                  }`}
                  style={{ width: `${s.rate}%` }}
                />
              </div>
              <div className="flex gap-4 text-xs text-gray-400">
                <span>Streak: <span className="text-gray-600 font-medium">{s.currentStreak}d</span></span>
                <span>Best: <span className="text-gray-600 font-medium">{s.bestStreak}d</span></span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
