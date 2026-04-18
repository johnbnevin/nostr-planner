import { useMemo, useState } from "react";
import { X, Pencil, Trash2, Check, Loader2 } from "lucide-react";
import { useCalendar } from "../contexts/CalendarContext";

interface HashtagManagerModalProps {
  onClose: () => void;
}

/**
 * Global hashtag management. Lists every tag in use with its event count,
 * and provides inline rename + delete that propagate to every affected event.
 * Destructive — "delete" strips the tag from every event that currently carries it.
 */
export function HashtagManagerModal({ onClose }: HashtagManagerModalProps) {
  const { events, renameTag, deleteTag } = useCalendar();

  const tagRows = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of events) {
      for (const t of e.hashtags) counts.set(t, (counts.get(t) || 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([tag, count]) => ({ tag, count }));
  }, [events]);

  const [renamingTag, setRenamingTag] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [busyTag, setBusyTag] = useState<string | null>(null);
  const [error, setError] = useState("");

  const startRename = (tag: string) => {
    setRenamingTag(tag);
    setRenameValue(tag);
    setError("");
  };

  const commitRename = async (oldTag: string) => {
    const next = renameValue.trim().toLowerCase().replace(/^#/, "");
    if (!next || next === oldTag) {
      setRenamingTag(null);
      return;
    }
    setBusyTag(oldTag);
    setError("");
    try {
      await renameTag(oldTag, next);
      setRenamingTag(null);
    } catch (err) {
      setError(`Rename failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusyTag(null);
    }
  };

  const handleDelete = async (tag: string, count: number) => {
    if (!confirm(`Remove "#${tag}" from ${count} event${count === 1 ? "" : "s"}?`)) return;
    setBusyTag(tag);
    setError("");
    try {
      await deleteTag(tag);
    } catch (err) {
      setError(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusyTag(null);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">Manage hashtags</h2>
          <button
            onClick={onClose}
            className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 flex-1 overflow-y-auto">
          {tagRows.length === 0 ? (
            <p className="text-sm text-gray-500 text-center py-6">
              No hashtags yet. Add tags to events to see them here.
            </p>
          ) : (
            <ul className="space-y-1">
              {tagRows.map(({ tag, count }) => (
                <li key={tag} className="flex items-center gap-2 py-1.5 px-2 rounded-lg hover:bg-gray-50">
                  {renamingTag === tag ? (
                    <>
                      <span className="text-gray-400 text-sm">#</span>
                      <input
                        type="text"
                        value={renameValue}
                        autoFocus
                        disabled={busyTag === tag}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitRename(tag);
                          if (e.key === "Escape") setRenamingTag(null);
                        }}
                        className="flex-1 min-w-0 px-2 py-1 text-sm border border-primary-400 rounded focus:outline-none focus:ring-1 focus:ring-primary-500"
                      />
                      <button
                        onClick={() => commitRename(tag)}
                        disabled={busyTag === tag}
                        className="p-1 text-primary-600 hover:text-primary-800 disabled:opacity-50"
                        title="Save"
                      >
                        {busyTag === tag ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="flex-1 min-w-0 text-sm text-gray-800 truncate">
                        #{tag}
                      </span>
                      <span className="text-xs text-gray-400 tabular-nums">
                        {count}
                      </span>
                      <button
                        onClick={() => startRename(tag)}
                        disabled={busyTag !== null}
                        className="p-1 text-gray-400 hover:text-primary-600 disabled:opacity-50"
                        title="Rename tag"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => handleDelete(tag, count)}
                        disabled={busyTag !== null}
                        className="p-1 text-gray-400 hover:text-red-500 disabled:opacity-50"
                        title={`Remove from ${count} event${count === 1 ? "" : "s"}`}
                      >
                        {busyTag === tag ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
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
