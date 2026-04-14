import { useState, useMemo } from "react";
import { X, Upload, AlertTriangle, Check, Merge, Replace, Shield } from "lucide-react";
import { useNostr } from "../contexts/NostrContext";
import { useCalendar } from "../contexts/CalendarContext";
import { useSettings } from "../contexts/SettingsContext";
import {
  KIND_DATE_EVENT,
  KIND_TIME_EVENT,
  buildDateEventTags,
  buildTimeEventTags,
  generateDTag,
  type CalendarEvent,
} from "../lib/nostr";
import { encryptEvent } from "../lib/crypto";
import { format } from "date-fns";
import type { ParsedIcalEvent } from "../lib/ical";

type ImportMode = "merge" | "replace";
type ImportPhase = "review" | "importing" | "done";

interface ImportReviewModalProps {
  parsed: ParsedIcalEvent[];
  fileName: string;
  onClose: () => void;
  onBackup: () => void;
}

function matchesExisting(parsed: ParsedIcalEvent, existing: CalendarEvent): boolean {
  if (parsed.title.toLowerCase() !== existing.title.toLowerCase()) return false;
  // Same day for all-day, or within 60s for timed events
  if (parsed.allDay && existing.allDay) {
    return format(parsed.start, "yyyy-MM-dd") === format(existing.start, "yyyy-MM-dd");
  }
  if (!parsed.allDay && !existing.allDay) {
    return Math.abs(parsed.start.getTime() - existing.start.getTime()) < 60_000;
  }
  return false;
}

export function ImportReviewModal({ parsed, fileName, onClose, onBackup }: ImportReviewModalProps) {
  const { pubkey, signEvent, publishEvent, signer } = useNostr();
  const { events, deleteEvent, forceFullRefresh } = useCalendar();
  const { shouldEncrypt } = useSettings();

  const [mode, setMode] = useState<ImportMode>("merge");
  const [phase, setPhase] = useState<ImportPhase>("review");
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ imported: number; deleted: number } | null>(null);

  const analysis = useMemo(() => {
    const duplicates: { parsed: ParsedIcalEvent; existing: CalendarEvent }[] = [];
    const newEvents: ParsedIcalEvent[] = [];

    for (const p of parsed) {
      const match = events.find((e) => matchesExisting(p, e));
      if (match) {
        duplicates.push({ parsed: p, existing: match });
      } else {
        newEvents.push(p);
      }
    }

    return { duplicates, newEvents };
  }, [parsed, events]);

  const handleImport = async () => {
    if (!pubkey) return;
    setPhase("importing");
    setError("");

    try {
      let deleted = 0;

      if (mode === "replace") {
        setProgress(`Deleting ${events.length} existing event(s)...`);
        for (const evt of events) {
          try {
            await deleteEvent(evt);
            deleted++;
          } catch {
            // continue
          }
        }
      }

      const toImport = mode === "merge" ? analysis.newEvents : parsed;
      let imported = 0;

      for (let i = 0; i < toImport.length; i++) {
        const evt = toImport[i];
        setProgress(`Publishing event ${i + 1}/${toImport.length}: ${evt.title}`);

        const dTag = generateDTag();
        let kind: number;
        let tags: string[][];

        if (evt.allDay) {
          kind = KIND_DATE_EVENT;
          tags = buildDateEventTags({
            dTag,
            title: evt.title,
            startDate: format(evt.start, "yyyy-MM-dd"),
            endDate: evt.end ? format(evt.end, "yyyy-MM-dd") : undefined,
            location: evt.location,
            link: evt.link,
            hashtags: evt.hashtags.length > 0 ? evt.hashtags : undefined,
          });
        } else {
          kind = KIND_TIME_EVENT;
          tags = buildTimeEventTags({
            dTag,
            title: evt.title,
            startUnix: Math.floor(evt.start.getTime() / 1000),
            endUnix: evt.end ? Math.floor(evt.end.getTime() / 1000) : undefined,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            location: evt.location,
            link: evt.link,
            hashtags: evt.hashtags.length > 0 ? evt.hashtags : undefined,
          });
        }

        const unsigned = {
          kind,
          created_at: Math.floor(Date.now() / 1000),
          tags,
          content: evt.description || "",
        };

        if (shouldEncrypt([]) && pubkey) {
          const evtDTag = unsigned.tags.find((t: string[]) => t[0] === "d")?.[1] || "";
          const encrypted = await encryptEvent(
            pubkey, unsigned.kind, evtDTag, unsigned.tags, unsigned.content, signer!
          );
          const signed = await signEvent({
            ...unsigned,
            tags: encrypted.tags,
            content: encrypted.content,
          });
          await publishEvent(signed);
        } else {
          const signed = await signEvent(unsigned);
          await publishEvent(signed);
        }
        imported++;
      }

      await forceFullRefresh();
      setResult({ imported, deleted });
      setPhase("done");
    } catch (err) {
      setError(`Import failed: ${err}`);
      setPhase("review");
    }
  };

  const mergeNewCount = analysis.newEvents.length;
  const mergeDupCount = analysis.duplicates.length;
  const replaceDeleteCount = events.length;

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold">Import Review</h2>
          <button
            onClick={onClose}
            disabled={phase === "importing"}
            className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-50"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 space-y-4 overflow-y-auto flex-1">
          {/* File info */}
          <div className="text-sm text-gray-600">
            <span className="font-medium text-gray-900">{fileName}</span>
            {" — "}
            {parsed.length} event{parsed.length !== 1 ? "s" : ""} found
            {events.length > 0 && (
              <span className="text-gray-400"> (you have {events.length} existing)</span>
            )}
          </div>

          {phase === "review" && (
            <>
              {/* Mode selector */}
              <div className="space-y-2">
                <button
                  onClick={() => setMode("merge")}
                  className={`w-full flex items-start gap-3 p-3 rounded-xl border-2 transition-colors text-left ${
                    mode === "merge"
                      ? "border-primary-500 bg-primary-50"
                      : "border-gray-200 hover:border-gray-300"
                  }`}
                >
                  <Merge className={`w-5 h-5 mt-0.5 flex-shrink-0 ${
                    mode === "merge" ? "text-primary-600" : "text-gray-400"
                  }`} />
                  <div>
                    <div className="font-medium text-sm">Merge with existing</div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      Add new events, skip duplicates. Your existing events stay untouched.
                    </div>
                    {mode === "merge" && (
                      <div className="mt-2 text-xs space-y-0.5">
                        <div className="text-primary-700 font-medium">
                          {mergeNewCount} new event{mergeNewCount !== 1 ? "s" : ""} to add
                        </div>
                        {mergeDupCount > 0 && (
                          <div className="text-amber-600">
                            {mergeDupCount} duplicate{mergeDupCount !== 1 ? "s" : ""} will be skipped
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </button>

                <button
                  onClick={() => setMode("replace")}
                  className={`w-full flex items-start gap-3 p-3 rounded-xl border-2 transition-colors text-left ${
                    mode === "replace"
                      ? "border-red-400 bg-red-50"
                      : "border-gray-200 hover:border-gray-300"
                  }`}
                >
                  <Replace className={`w-5 h-5 mt-0.5 flex-shrink-0 ${
                    mode === "replace" ? "text-red-600" : "text-gray-400"
                  }`} />
                  <div>
                    <div className="font-medium text-sm">Replace existing</div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      Delete all existing events, then import everything from the file.
                    </div>
                    {mode === "replace" && replaceDeleteCount > 0 && (
                      <div className="mt-2 flex items-center gap-1.5 text-xs text-red-600 font-medium">
                        <AlertTriangle className="w-3.5 h-3.5" />
                        {replaceDeleteCount} existing event{replaceDeleteCount !== 1 ? "s" : ""} will be deleted
                      </div>
                    )}
                  </div>
                </button>
              </div>

              {/* Event preview list */}
              <div>
                <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                  {mode === "merge" ? "Events to import" : "All events in file"}
                </div>
                <div className="border border-gray-200 rounded-lg divide-y divide-gray-100 max-h-48 overflow-y-auto">
                  {(mode === "merge" ? analysis.newEvents : parsed).length === 0 ? (
                    <div className="p-3 text-sm text-gray-400 text-center">
                      No new events to import — all are duplicates
                    </div>
                  ) : (
                    (mode === "merge" ? analysis.newEvents : parsed).map((evt, i) => (
                      <div key={i} className="px-3 py-2 flex items-center gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium text-gray-900 truncate">{evt.title}</div>
                          <div className="text-xs text-gray-500">
                            {evt.allDay
                              ? format(evt.start, "MMM d, yyyy")
                              : format(evt.start, "MMM d, yyyy h:mm a")}
                          </div>
                        </div>
                        {evt.location && (
                          <span className="text-xs text-gray-400 truncate max-w-[120px]">{evt.location}</span>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>

              {/* Duplicates list in merge mode */}
              {mode === "merge" && mergeDupCount > 0 && (
                <div>
                  <div className="text-xs font-semibold text-amber-600 uppercase tracking-wider mb-2">
                    Duplicates (will skip)
                  </div>
                  <div className="border border-amber-200 rounded-lg divide-y divide-amber-100 max-h-32 overflow-y-auto bg-amber-50/50">
                    {analysis.duplicates.map((dup, i) => (
                      <div key={i} className="px-3 py-2 flex items-center gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="text-sm text-amber-800 truncate">{dup.parsed.title}</div>
                          <div className="text-xs text-amber-600">
                            {dup.parsed.allDay
                              ? format(dup.parsed.start, "MMM d, yyyy")
                              : format(dup.parsed.start, "MMM d, yyyy h:mm a")}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {error && (
                <div className="flex items-start gap-2 p-3 bg-red-50 rounded-lg">
                  <AlertTriangle className="w-4 h-4 text-red-600 mt-0.5 flex-shrink-0" />
                  <span className="text-sm text-red-800">{error}</span>
                </div>
              )}
            </>
          )}

          {phase === "importing" && (
            <div className="flex items-start gap-2 p-3 bg-primary-50 rounded-lg">
              <Upload className="w-4 h-4 text-primary-600 mt-0.5 flex-shrink-0 animate-pulse" />
              <span className="text-sm text-primary-800">{progress}</span>
            </div>
          )}

          {phase === "done" && result && (
            <div className="space-y-3">
              <div className="flex items-start gap-2 p-3 bg-emerald-50 border-2 border-emerald-300 rounded-lg">
                <Check className="w-5 h-5 text-emerald-600 mt-0.5 flex-shrink-0" />
                <div className="text-sm font-medium text-emerald-800">
                  Import complete!
                  {result.deleted > 0 && ` Deleted ${result.deleted} old event${result.deleted !== 1 ? "s" : ""}.`}
                  {" "}Imported {result.imported} event{result.imported !== 1 ? "s" : ""}.
                </div>
              </div>

              <button
                onClick={onBackup}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors font-medium text-sm"
              >
                <Shield className="w-4 h-4" />
                Save Backup to Blossom
              </button>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-gray-100 flex gap-2">
          {phase === "review" && (
            <>
              <button
                onClick={onClose}
                className="flex-1 px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleImport}
                disabled={(mode === "merge" && mergeNewCount === 0)}
                className={`flex-1 px-4 py-2 text-sm font-medium text-white rounded-lg transition-colors disabled:opacity-50 ${
                  mode === "replace"
                    ? "bg-red-600 hover:bg-red-700"
                    : "bg-primary-600 hover:bg-primary-700"
                }`}
              >
                {mode === "replace"
                  ? `Replace (${parsed.length} event${parsed.length !== 1 ? "s" : ""})`
                  : `Import ${mergeNewCount} event${mergeNewCount !== 1 ? "s" : ""}`}
              </button>
            </>
          )}
          {phase === "importing" && (
            <div className="w-full text-center text-sm text-gray-400">Importing...</div>
          )}
          {phase === "done" && (
            <button
              onClick={onClose}
              className="w-full px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
            >
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
