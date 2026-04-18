import { useState, useRef, useCallback } from "react";
import {
  Plus,
  Download,
  Upload,
  ChevronDown,
  ChevronRight,
  Trash2,
  Pencil,
  Check,
  Palette,
  Users,
  X,
  Loader2,
  Tag,
  Settings2,
} from "lucide-react";
import { useNostr } from "../contexts/NostrContext";
import { useCalendar } from "../contexts/CalendarContext";
import { useSharing } from "../contexts/SharingContext";
import { useSettings } from "../contexts/SettingsContext";
import { CALENDAR_COLORS } from "../lib/nostr";
import { isNip44Available } from "../lib/crypto";
import { downloadIcalFile, parseIcalFile } from "../lib/ical";
import type { ParsedIcalEvent } from "../lib/ical";
import { HashtagManagerModal } from "./HashtagManagerModal";

/** @see {@link Sidebar} */
interface SidebarProps {
  /** Called after an .ics file is parsed, handing off events for review in ImportReviewModal. */
  onImportParsed?: (events: ParsedIcalEvent[], fileName: string) => void;
  /** Opens the SharingModal for the given calendar dTag. */
  onShareCalendar?: (calDTag: string) => void;
  /** When provided, renders as a mobile full-screen overlay with a close button. */
  onClose?: () => void;
}

/**
 * Left sidebar panel (visible on lg+ screens only). Contains two sections:
 *
 * **My Calendars** — a drag-to-reorder list of the user's calendars.
 * Each calendar row provides:
 * - Checkbox to toggle visibility (filter events in/out of the main view)
 * - Color dot + color-picker popover for per-calendar coloring
 * - Inline rename (double-click or pencil icon)
 * - Share button (opens SharingModal; shows a Users icon if already shared)
 * - Delete button (requires confirmation; only enabled if >1 calendar exists)
 * - "Add calendar" form with name, color picker, and optional "Shared" checkbox
 *   (shared option only appears if the signer supports NIP-44 encryption)
 *
 * **Import / Export** — export visible events as `.ics`, or import an `.ics`
 * file (Google Calendar, Apple Calendar, Outlook compatible). Importing hands
 * parsed events up to CalendarApp for review before publishing.
 */
export function Sidebar({ onImportParsed, onShareCalendar, onClose }: SidebarProps) {
  const { signer } = useNostr();
  const { canPublish } = useSettings();
  const {
    filteredEvents,
    calendars,
    activeCalendarIds,
    toggleCalendar,
    createCalendar,
    createSharedCalendar,
    renameCalendar,
    deleteCalendar,
    reorderCalendars,
    recolorCalendar,
    eventsLoading,
    tagsByUsage,
    activeTag,
    setActiveTag,
  } = useCalendar();
  const { isSharedCalendar } = useSharing();

  // Mobile overlay mode: full-screen modal
  if (onClose) {
    return (
      <div className="fixed inset-0 bg-black/40 z-50 flex items-start justify-center p-4 pt-12">
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm max-h-[85vh] overflow-y-auto">
          <div className="flex items-center justify-between p-4 border-b border-gray-200 sticky top-0 bg-white rounded-t-2xl z-10">
            <h2 className="text-lg font-semibold">Calendars</h2>
            <button
              onClick={onClose}
              className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
          <div className="p-4">
            <SidebarContent
              onImportParsed={onImportParsed}
              onShareCalendar={onShareCalendar}
              signer={signer}
              canPublish={canPublish}
              filteredEvents={filteredEvents}
              calendars={calendars}
              activeCalendarIds={activeCalendarIds}
              toggleCalendar={toggleCalendar}
              createCalendar={createCalendar}
              createSharedCalendar={createSharedCalendar}
              renameCalendar={renameCalendar}
              deleteCalendar={deleteCalendar}
              reorderCalendars={reorderCalendars}
              recolorCalendar={recolorCalendar}
              isSharedCalendar={isSharedCalendar}
              eventsLoading={eventsLoading}
              tagsByUsage={tagsByUsage}
              activeTag={activeTag}
              setActiveTag={setActiveTag}
            />
          </div>
        </div>
      </div>
    );
  }

  // Desktop inline mode
  return (
    <aside className="w-64 flex-shrink-0 bg-white border-r border-gray-200 p-4 overflow-y-auto hidden lg:block">
      <SidebarContent
        onImportParsed={onImportParsed}
        onShareCalendar={onShareCalendar}
        signer={signer}
        canPublish={canPublish}
        filteredEvents={filteredEvents}
        calendars={calendars}
        activeCalendarIds={activeCalendarIds}
        toggleCalendar={toggleCalendar}
        createCalendar={createCalendar}
        createSharedCalendar={createSharedCalendar}
        renameCalendar={renameCalendar}
        deleteCalendar={deleteCalendar}
        reorderCalendars={reorderCalendars}
        recolorCalendar={recolorCalendar}
        isSharedCalendar={isSharedCalendar}
        eventsLoading={eventsLoading}
        tagsByUsage={tagsByUsage}
        activeTag={activeTag}
        setActiveTag={setActiveTag}
      />
    </aside>
  );
}

/* ── Shared sidebar content ───────────────────────────────────────── */

interface SidebarContentProps {
  onImportParsed?: (events: ParsedIcalEvent[], fileName: string) => void;
  onShareCalendar?: (calDTag: string) => void;
  signer: ReturnType<typeof useNostr>["signer"];
  canPublish: ReturnType<typeof useSettings>["canPublish"];
  filteredEvents: ReturnType<typeof useCalendar>["filteredEvents"];
  calendars: ReturnType<typeof useCalendar>["calendars"];
  activeCalendarIds: ReturnType<typeof useCalendar>["activeCalendarIds"];
  toggleCalendar: ReturnType<typeof useCalendar>["toggleCalendar"];
  createCalendar: ReturnType<typeof useCalendar>["createCalendar"];
  createSharedCalendar: ReturnType<typeof useCalendar>["createSharedCalendar"];
  renameCalendar: ReturnType<typeof useCalendar>["renameCalendar"];
  deleteCalendar: ReturnType<typeof useCalendar>["deleteCalendar"];
  reorderCalendars: ReturnType<typeof useCalendar>["reorderCalendars"];
  recolorCalendar: ReturnType<typeof useCalendar>["recolorCalendar"];
  isSharedCalendar: ReturnType<typeof useSharing>["isSharedCalendar"];
  eventsLoading: ReturnType<typeof useCalendar>["eventsLoading"];
  tagsByUsage: ReturnType<typeof useCalendar>["tagsByUsage"];
  activeTag: ReturnType<typeof useCalendar>["activeTag"];
  setActiveTag: ReturnType<typeof useCalendar>["setActiveTag"];
}

function SidebarContent({
  onImportParsed,
  onShareCalendar,
  signer,
  canPublish,
  filteredEvents,
  calendars,
  activeCalendarIds,
  toggleCalendar,
  createCalendar,
  createSharedCalendar,
  renameCalendar,
  deleteCalendar,
  reorderCalendars,
  recolorCalendar,
  isSharedCalendar,
  eventsLoading,
  tagsByUsage,
  activeTag,
  setActiveTag,
}: SidebarContentProps) {
  const [hashtagsExpanded, setHashtagsExpanded] = useState(true);
  const [showTagManager, setShowTagManager] = useState(false);
  const [showNewCalendar, setShowNewCalendar] = useState(false);
  const [newCalShared, setNewCalShared] = useState(false);
  const [newCalName, setNewCalName] = useState("");
  const [newCalColor, setNewCalColor] = useState(CALENDAR_COLORS[0]);
  const [colorPickerDTag, setColorPickerDTag] = useState<string | null>(null);
  const paletteCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const schedulePaletteClose = () => {
    if (paletteCloseTimer.current) clearTimeout(paletteCloseTimer.current);
    paletteCloseTimer.current = setTimeout(() => {
      setColorPickerDTag(null);
      paletteCloseTimer.current = null;
    }, 1000);
  };
  const cancelPaletteClose = () => {
    if (paletteCloseTimer.current) {
      clearTimeout(paletteCloseTimer.current);
      paletteCloseTimer.current = null;
    }
  };
  const [calendarsExpanded, setCalendarsExpanded] = useState(true);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");
  const [renamingDTag, setRenamingDTag] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragItemRef = useRef<string | null>(null);
  const dragOverRef = useRef<string | null>(null);
  const [dragOverDTag, setDragOverDTag] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const handleCreateCalendar = async () => {
    if (!newCalName.trim() || creating) return;
    const name = newCalName.trim();
    const color = newCalColor;
    const shared = newCalShared;
    setNewCalName("");
    setNewCalColor(CALENDAR_COLORS[(calendars.length + 1) % CALENDAR_COLORS.length]);
    setNewCalShared(false);
    setShowNewCalendar(false);
    setCreating(true);
    try {
      if (shared) {
        await createSharedCalendar(name, color);
      } else {
        await createCalendar(name, color);
      }
    } catch {
      // Calendar was already added optimistically in context
    } finally {
      setCreating(false);
    }
  };

  const startRename = (dTag: string, currentTitle: string) => {
    setRenamingDTag(dTag);
    setRenameValue(currentTitle);
  };

  const commitRename = async () => {
    if (!renamingDTag || !renameValue.trim()) {
      setRenamingDTag(null);
      return;
    }
    const dTag = renamingDTag;
    const title = renameValue.trim();
    setRenamingDTag(null);
    try {
      await renameCalendar(dTag, title);
    } catch {
      // Already updated optimistically
    }
  };

  const handleExport = () => {
    downloadIcalFile(filteredEvents, "nostr-planner.ics");
  };

  const handleCalDragStart = useCallback((dTag: string) => {
    dragItemRef.current = dTag;
  }, []);

  const handleCalDragOver = useCallback((e: React.DragEvent, dTag: string) => {
    e.preventDefault();
    dragOverRef.current = dTag;
    setDragOverDTag(dTag);
  }, []);

  const handleCalDragEnd = useCallback(() => {
    const from = dragItemRef.current;
    const to = dragOverRef.current;
    dragItemRef.current = null;
    dragOverRef.current = null;
    setDragOverDTag(null);

    if (!from || !to || from === to) return;

    const ordered = calendars.map((c) => c.dTag);
    const fromIdx = ordered.indexOf(from);
    const toIdx = ordered.indexOf(to);
    if (fromIdx === -1 || toIdx === -1) return;

    ordered.splice(fromIdx, 1);
    ordered.splice(toIdx, 0, from);
    reorderCalendars(ordered);
  }, [calendars, reorderCalendars]);

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setImporting(true);
    setImportError("");
    try {
      const text = await file.text();
      const parsed = parseIcalFile(text);

      if (parsed.length === 0) {
        setImportError("No events found in file");
        return;
      }

      onImportParsed?.(parsed, file.name);
    } catch (err) {
      setImportError(`Import failed: ${err}`);
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return (
    <>
      {/* Calendars section */}
      <div className="mb-6">
        <button
          onClick={() => setCalendarsExpanded(!calendarsExpanded)}
          className="flex items-center gap-1 text-sm font-semibold text-gray-700 mb-2 hover:text-gray-900"
        >
          {calendarsExpanded ? (
            <ChevronDown className="w-4 h-4" />
          ) : (
            <ChevronRight className="w-4 h-4" />
          )}
          My Calendars
        </button>

        {calendarsExpanded && (
          <div className="space-y-1">
            {eventsLoading && calendars.length === 0 && (
              <div className="flex items-center gap-2 px-2 py-1 text-xs text-gray-400">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Loading calendars…
              </div>
            )}
            {calendars.map((cal) => (
              <div
                key={cal.dTag}
                draggable={renamingDTag !== cal.dTag}
                onDragStart={() => handleCalDragStart(cal.dTag)}
                onDragOver={(e) => handleCalDragOver(e, cal.dTag)}
                onDragEnd={handleCalDragEnd}
                className={`group relative flex items-center gap-2 px-2 py-1 rounded-lg hover:bg-gray-50 cursor-grab active:cursor-grabbing transition-colors ${
                  dragOverDTag === cal.dTag && dragItemRef.current !== cal.dTag
                    ? "bg-primary-50 border-t-2 border-primary-400"
                    : ""
                }`}
              >
                <input
                  type="checkbox"
                  checked={activeCalendarIds.has(cal.dTag)}
                  onChange={() => toggleCalendar(cal.dTag)}
                  className="w-3.5 h-3.5 rounded flex-shrink-0"
                  style={{ accentColor: cal.color || "#4c6ef5" }}
                />
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setColorPickerDTag(colorPickerDTag === cal.dTag ? null : cal.dTag);
                  }}
                  className="w-2.5 h-2.5 rounded-full flex-shrink-0 hover:ring-2 hover:ring-offset-1 hover:ring-gray-300 transition-all"
                  style={{ backgroundColor: cal.color || "#4c6ef5" }}
                  title="Change color"
                />

                {renamingDTag === cal.dTag ? (
                  <input
                    type="text"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename();
                      if (e.key === "Escape") setRenamingDTag(null);
                    }}
                    onBlur={commitRename}
                    className="flex-1 min-w-0 px-1 py-0 text-sm border border-primary-400 rounded focus:outline-none focus:ring-1 focus:ring-primary-500"
                    autoFocus
                  />
                ) : (
                  <span
                    className="text-sm text-gray-700 truncate flex-1 min-w-0 cursor-default flex items-center gap-1"
                    onDoubleClick={() => startRename(cal.dTag, cal.title)}
                  >
                    <span className="truncate">{cal.title}</span>
                    {isSharedCalendar(cal.dTag) && (
                      <Users className="w-3 h-3 text-primary-400 flex-shrink-0" aria-label="Shared calendar" />
                    )}
                  </span>
                )}

                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-all flex-shrink-0">
                  {renamingDTag === cal.dTag ? (
                    <button
                      onClick={commitRename}
                      className="p-0.5 hover:text-primary-600 text-gray-400"
                      title="Save"
                    >
                      <Check className="w-3.5 h-3.5" />
                    </button>
                  ) : (
                    <>
                      {onShareCalendar && (
                        <button
                          onClick={() => onShareCalendar(cal.dTag)}
                          className={`p-0.5 text-gray-400 hover:text-primary-600 ${isSharedCalendar(cal.dTag) ? "text-primary-400" : ""}`}
                          title={isSharedCalendar(cal.dTag) ? "Manage sharing" : "Share calendar"}
                        >
                          <Users className="w-3 h-3" />
                        </button>
                      )}
                      <button
                        onClick={() => setColorPickerDTag(colorPickerDTag === cal.dTag ? null : cal.dTag)}
                        className="p-0.5 hover:text-primary-600 text-gray-400"
                        title="Change color"
                      >
                        <Palette className="w-3 h-3" />
                      </button>
                      <button
                        onClick={() => startRename(cal.dTag, cal.title)}
                        className="p-0.5 hover:text-primary-600 text-gray-400"
                        title="Rename calendar"
                      >
                        <Pencil className="w-3 h-3" />
                      </button>
                    </>
                  )}
                  {calendars.length > 1 && (
                    <button
                      onClick={() => {
                        if (
                          confirm(
                            `Delete calendar "${cal.title}"? Events won't be deleted.`
                          )
                        )
                          deleteCalendar(cal.dTag);
                      }}
                      className="p-0.5 hover:text-red-500 text-gray-400"
                      title="Delete calendar"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  )}
                </div>

                {colorPickerDTag === cal.dTag && (
                  <div
                    className="absolute left-8 mt-1 top-full z-10 bg-white border border-gray-200 rounded-lg shadow-lg p-2 flex flex-wrap gap-1.5 w-40"
                    onMouseEnter={cancelPaletteClose}
                    onMouseLeave={schedulePaletteClose}
                  >
                    {CALENDAR_COLORS.map((c) => (
                      <button
                        key={c}
                        onClick={() => {
                          recolorCalendar(cal.dTag, c);
                          cancelPaletteClose();
                          setColorPickerDTag(null);
                        }}
                        className={`w-6 h-6 rounded-full transition-all hover:scale-110 ${
                          cal.color === c ? "ring-2 ring-offset-1 ring-gray-400" : ""
                        }`}
                        style={{ backgroundColor: c }}
                      />
                    ))}
                  </div>
                )}
              </div>
            ))}

            {showNewCalendar ? (
              <div className="pl-5 mt-2">
                <input
                  type="text"
                  placeholder="Calendar name"
                  value={newCalName}
                  onChange={(e) => setNewCalName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleCreateCalendar();
                    if (e.key === "Escape") {
                      setShowNewCalendar(false);
                      setNewCalName("");
                    }
                  }}
                  className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-primary-500"
                  autoFocus
                />
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {CALENDAR_COLORS.map((c) => (
                    <button
                      key={c}
                      onClick={() => setNewCalColor(c)}
                      className={`w-5 h-5 rounded-full transition-all hover:scale-110 ${
                        newCalColor === c ? "ring-2 ring-offset-1 ring-gray-400" : ""
                      }`}
                      style={{ backgroundColor: c }}
                    />
                  ))}
                </div>
                {/* Shared calendar option only shown when signer supports NIP-44,
                    since shared calendars use AES-256-GCM keys distributed via NIP-44 envelopes */}
                {isNip44Available(signer) && (
                  <label className="flex items-center gap-1.5 mt-1.5 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={newCalShared}
                      onChange={(e) => setNewCalShared(e.target.checked)}
                      className="w-3 h-3 rounded"
                    />
                    <span className="text-xs text-gray-600 flex items-center gap-1">
                      <Users className="w-3 h-3" />
                      Shared (invite others)
                    </span>
                  </label>
                )}
                <div className="flex gap-1 mt-1.5">
                  <button
                    onClick={handleCreateCalendar}
                    disabled={!newCalName.trim()}
                    className="px-2 py-0.5 text-xs bg-primary-600 text-white rounded hover:bg-primary-700 disabled:opacity-50"
                  >
                    Create
                  </button>
                  <button
                    onClick={() => {
                      setShowNewCalendar(false);
                      setNewCalName("");
                      setNewCalShared(false);
                    }}
                    className="px-2 py-0.5 text-xs text-gray-500 hover:text-gray-700"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : !eventsLoading ? (
              <button
                onClick={() => setShowNewCalendar(true)}
                className="flex items-center gap-1.5 px-2 py-1 text-xs text-primary-600 hover:text-primary-700 hover:bg-primary-50 rounded-lg transition-colors mt-1"
              >
                <Plus className="w-3.5 h-3.5" />
                Add calendar
              </button>
            ) : null}
          </div>
        )}
      </div>

      {/* Hashtags — filter events by a single hashtag. Click a tag to filter,
          click again (or "All") to clear. The gear icon opens a global
          rename/delete manager so users can tidy up stale tags in bulk. */}
      {tagsByUsage.length > 0 && (
        <div className="mb-6">
          <div className="flex items-center justify-between mb-2">
            <button
              onClick={() => setHashtagsExpanded(!hashtagsExpanded)}
              className="flex items-center gap-1 text-sm font-semibold text-gray-700 hover:text-gray-900"
            >
              {hashtagsExpanded ? (
                <ChevronDown className="w-4 h-4" />
              ) : (
                <ChevronRight className="w-4 h-4" />
              )}
              <Tag className="w-3.5 h-3.5" />
              Hashtags
            </button>
            <button
              onClick={() => setShowTagManager(true)}
              className="p-1 text-gray-400 hover:text-primary-600 rounded"
              title="Manage hashtags"
            >
              <Settings2 className="w-3.5 h-3.5" />
            </button>
          </div>
          {hashtagsExpanded && (
            <div className="flex flex-wrap gap-1.5 pl-1">
              <button
                onClick={() => setActiveTag(null)}
                className={`px-2 py-0.5 rounded-full text-xs border transition-colors ${
                  activeTag === null
                    ? "bg-primary-600 border-primary-600 text-white"
                    : "border-gray-300 text-gray-600 hover:bg-gray-50"
                }`}
              >
                All
              </button>
              {tagsByUsage.map((tag) => (
                <button
                  key={tag}
                  onClick={() => setActiveTag(activeTag === tag ? null : tag)}
                  className={`px-2 py-0.5 rounded-full text-xs border transition-colors ${
                    activeTag === tag
                      ? "bg-primary-600 border-primary-600 text-white"
                      : "border-gray-200 text-gray-600 hover:bg-primary-50 hover:border-primary-300 hover:text-primary-700"
                  }`}
                >
                  #{tag}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {showTagManager && <HashtagManagerModal onClose={() => setShowTagManager(false)} />}

      {/* Import / Export */}
      <div className="border-t border-gray-200 pt-4">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
          Import / Export
        </p>
        <div className="space-y-1.5">
          <button
            onClick={handleExport}
            className="flex items-center gap-2 w-full px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 rounded-lg transition-colors"
          >
            <Download className="w-4 h-4 text-gray-400" />
            Export .ics file
          </button>

          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={importing || !canPublish()}
            className="flex items-center gap-2 w-full px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 rounded-lg transition-colors disabled:opacity-50"
          >
            <Upload className="w-4 h-4 text-gray-400" />
            {importing ? "Importing..." : "Import .ics file"}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".ics,.ical,.ifb,.icalendar"
            onChange={handleImport}
            className="hidden"
          />

          {importError && (
            <p className="text-xs text-red-600 px-3 py-1">{importError}</p>
          )}

          <p className="text-xs text-gray-400 px-3">
            Compatible with Google Calendar, Apple Calendar, and Outlook
          </p>
        </div>
      </div>
    </>
  );
}
