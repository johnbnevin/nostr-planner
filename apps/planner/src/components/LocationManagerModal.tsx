import { useMemo, useState } from "react";
import { X, Pencil, Trash2, Check, Loader2 } from "lucide-react";
import { useCalendar } from "../contexts/CalendarContext";

interface LocationManagerModalProps {
  onClose: () => void;
}

/**
 * Global location management. Lists every location in use with its event count,
 * and provides inline rename + delete that propagate to every affected event.
 * Matching is case-insensitive so "Home" and "home" are treated as one venue.
 */
export function LocationManagerModal({ onClose }: LocationManagerModalProps) {
  const { events, renameLocation, deleteLocation } = useCalendar();

  const locationRows = useMemo(() => {
    const counts = new Map<string, { display: string; count: number }>();
    for (const e of events) {
      const loc = e.location?.trim();
      if (!loc) continue;
      const key = loc.toLowerCase();
      const entry = counts.get(key);
      if (entry) entry.count += 1;
      else counts.set(key, { display: loc, count: 1 });
    }
    return [...counts.values()]
      .sort((a, b) => b.count - a.count || a.display.localeCompare(b.display));
  }, [events]);

  const [renamingLoc, setRenamingLoc] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [busyLoc, setBusyLoc] = useState<string | null>(null);
  const [error, setError] = useState("");

  const startRename = (loc: string) => {
    setRenamingLoc(loc);
    setRenameValue(loc);
    setError("");
  };

  const commitRename = async (oldLoc: string) => {
    const next = renameValue.trim();
    if (!next || next.toLowerCase() === oldLoc.toLowerCase()) {
      setRenamingLoc(null);
      return;
    }
    setBusyLoc(oldLoc);
    setError("");
    try {
      await renameLocation(oldLoc, next);
      setRenamingLoc(null);
    } catch (err) {
      setError(`Rename failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusyLoc(null);
    }
  };

  const handleDelete = async (loc: string, count: number) => {
    if (!confirm(`Clear location "${loc}" from ${count} event${count === 1 ? "" : "s"}?`)) return;
    setBusyLoc(loc);
    setError("");
    try {
      await deleteLocation(loc);
    } catch (err) {
      setError(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusyLoc(null);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">Manage locations</h2>
          <button
            onClick={onClose}
            className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 flex-1 overflow-y-auto">
          {locationRows.length === 0 ? (
            <p className="text-sm text-gray-500 text-center py-6">
              No locations yet. Add locations to events and they'll appear here.
            </p>
          ) : (
            <ul className="space-y-1">
              {locationRows.map(({ display, count }) => (
                <li key={display.toLowerCase()} className="flex items-center gap-2 py-1.5 px-2 rounded-lg hover:bg-gray-50">
                  {renamingLoc === display ? (
                    <>
                      <input
                        type="text"
                        value={renameValue}
                        autoFocus
                        disabled={busyLoc === display}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitRename(display);
                          if (e.key === "Escape") setRenamingLoc(null);
                        }}
                        className="flex-1 min-w-0 px-2 py-1 text-sm border border-primary-400 rounded focus:outline-none focus:ring-1 focus:ring-primary-500"
                      />
                      <button
                        onClick={() => commitRename(display)}
                        disabled={busyLoc === display}
                        className="p-1 text-primary-600 hover:text-primary-800 disabled:opacity-50"
                        title="Save"
                      >
                        {busyLoc === display ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="flex-1 min-w-0 text-sm text-gray-800 truncate" title={display}>
                        {display}
                      </span>
                      <span className="text-xs text-gray-400 tabular-nums">
                        {count}
                      </span>
                      <button
                        onClick={() => startRename(display)}
                        disabled={busyLoc !== null}
                        className="p-1 text-gray-400 hover:text-primary-600 disabled:opacity-50"
                        title="Rename location"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => handleDelete(display, count)}
                        disabled={busyLoc !== null}
                        className="p-1 text-gray-400 hover:text-red-500 disabled:opacity-50"
                        title={`Clear from ${count} event${count === 1 ? "" : "s"}`}
                      >
                        {busyLoc === display ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
          {error && (
            <p className="mt-3 text-xs text-red-600 bg-red-50 border border-red-200 rounded p-2">
              {error}
            </p>
          )}
        </div>

        <div className="p-4 border-t border-gray-100">
          <p className="text-xs text-gray-400 mb-2">
            Renaming or deleting re-publishes every affected event. Private events
            update on the next backup.
          </p>
          <button
            onClick={onClose}
            className="w-full px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
