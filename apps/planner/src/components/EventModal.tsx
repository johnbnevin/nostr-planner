import { useState } from "react";
import { X, Link as LinkIcon, Tag, Repeat, Calendar, ShieldAlert, Bell, BellOff, ChevronDown, Settings2, MapPin } from "lucide-react";
import { LocationManagerModal } from "./LocationManagerModal";
import { useNostr } from "../contexts/NostrContext";
import { useCalendar } from "../contexts/CalendarContext";
import { useSharing } from "../contexts/SharingContext";
import { useSettings } from "../contexts/SettingsContext";
import {
  KIND_DATE_EVENT,
  KIND_TIME_EVENT,
  buildDateEventTags,
  buildTimeEventTags,
  generateDTag,
  advanceDate,
  type CalendarEvent,
  type RecurrenceFreq,
} from "../lib/nostr";
import { encryptEventWithSharedKey } from "../lib/crypto";
import { format } from "date-fns";

/**
 * Props for {@link EventModal}.
 *
 * The modal operates in three modes depending on which props are provided:
 * - **Create:** `event` is null, `extendSeries` is undefined. A blank form.
 * - **Edit:** `event` is a CalendarEvent. Fields are pre-populated for update.
 * - **Extend series:** `extendSeries` is set. Pre-fills from the template event
 *   and generates new instances starting after the last existing one.
 */
interface EventModalProps {
  /** Existing event to edit, or null for new event creation. */
  event: CalendarEvent | null;
  /** Pre-fill the start date when creating from a date click on the calendar. */
  prefillDate: Date | null;
  /** Pre-fill the form from an existing event BUT save as a new event (duplicate flow). */
  prefillEvent?: CalendarEvent;
  /** When set, we're extending an existing recurrence series from this start date. */
  extendSeries?: {
    seriesId: string;
    freq: RecurrenceFreq;
    fromDate: Date; // the next date after the last existing instance
    templateEvent: CalendarEvent; // copy title, location, tags, etc. from this
  };
  onClose: () => void;
  /** Opens the settings panel (used when notifications are off and user wants to enable). */
  onOpenSettings?: () => void;
}

/**
 * Modal form for creating, editing, or extending calendar events.
 *
 * Encryption mode is determined automatically based on the selected calendars:
 * 1. **Shared calendar selected:** Encrypts with the calendar's AES-256-GCM key
 *    (symmetric, all members hold the same key via NIP-44 key envelopes).
 * 2. **Private calendar (default):** Encrypts with NIP-44 to the user's own
 *    pubkey. The event is published as kind 30078 (opaque app data), not as a
 *    NIP-52 calendar kind, so other Nostr clients cannot index it.
 * 3. **Plaintext (opt-in via settings):** Publishes as standard NIP-52 kinds.
 *
 * Recurring events are materialized as individual Nostr events (one per instance)
 * since NIP-52 has no recurrence spec. Recurrence metadata is stored in JSON
 * content on the first instance for later reconstruction.
 *
 * All saves use optimistic UI — events appear immediately in the calendar view
 * before relay confirmation, with a background sync afterward.
 */
export function EventModal({ event, prefillDate, prefillEvent, extendSeries, onClose, onOpenSettings }: EventModalProps) {
  const { pubkey, signEvent, publishEvent } = useNostr();
  const { refreshEvents, allTags, tagsByUsage, locationsByUsage, calendars, addEventOptimistic, getSeriesEvents } = useCalendar();
  const { getSharedKeyForCalendars } = useSharing();
  const { shouldEncrypt, canPublish, notification } = useSettings();
  const notificationsEnabled = notification.enabled;

  const isExtend = !!extendSeries;
  const isDuplicate = !event && !!prefillEvent;
  const templateEvent = extendSeries?.templateEvent;
  // Priority: explicit edit target > extend template > duplicate prefill.
  const sourceEvent = event || templateEvent || prefillEvent;

  const now = prefillEvent?.start || extendSeries?.fromDate || prefillDate || new Date();
  const isEdit = !!event && !isExtend;

  const [title, setTitle] = useState(sourceEvent?.title || "");
  const [allDay, setAllDay] = useState(sourceEvent?.allDay ?? true);
  const [startDate, setStartDate] = useState(
    isExtend
      ? format(extendSeries!.fromDate, "yyyy-MM-dd")
      : event
        ? format(event.start, "yyyy-MM-dd")
        : format(now, "yyyy-MM-dd")
  );
  const [startTime, setStartTime] = useState(
    sourceEvent && !sourceEvent.allDay
      ? format(sourceEvent.start, "HH:mm")
      : format(now, "HH:mm")
  );
  const [endDate, setEndDate] = useState(
    sourceEvent?.end ? format(sourceEvent.end, "yyyy-MM-dd") : ""
  );
  const [endTime, setEndTime] = useState(
    sourceEvent?.end && !sourceEvent.allDay
      ? format(sourceEvent.end, "HH:mm")
      : ""
  );
  const [location, setLocation] = useState(sourceEvent?.location || "");
  const [link, setLink] = useState(sourceEvent?.link || "");
  const [description, setDescription] = useState(
    (() => {
      if (!sourceEvent?.content) return "";
      try {
        const parsed = JSON.parse(sourceEvent.content);
        return parsed?.description || "";
      } catch {
        return sourceEvent.content;
      }
    })()
  );
  const [hashtags, setHashtags] = useState<string[]>(
    sourceEvent?.hashtags || []
  );
  const [tagInput, setTagInput] = useState("");
  const [showTagSuggestions, setShowTagSuggestions] = useState(false);
  const [showAllTags, setShowAllTags] = useState(false);
  const [showLocationDropdown, setShowLocationDropdown] = useState(false);
  const [showLocationManager, setShowLocationManager] = useState(false);

  // Recurrence
  const [recurring, setRecurring] = useState(
    isExtend || !!event?.recurrence
  );
  const [recurrenceFreq, setRecurrenceFreq] = useState<RecurrenceFreq>(
    extendSeries?.freq || event?.recurrence?.freq || "weekly"
  );
  const [recurrenceCount, setRecurrenceCount] = useState(
    isExtend ? 26 : event?.recurrence?.count || 4
  );

  // Calendar assignment
  const [selectedCalendars, setSelectedCalendars] = useState<string[]>(
    sourceEvent?.calendarRefs || []
  );

  // Notification opt-in — defaults to true (follows global setting), user can opt out per event
  const [notify, setNotify] = useState<boolean>(sourceEvent?.notify !== false);

  // When editing an event that's part of a series, user can opt to propagate
  // shared fields (title/tags/location/etc.) to every sibling instance.
  // Per-instance fields (start/end dates) are preserved on each sibling.
  const isSeriesEdit = !!event?.seriesId && !isExtend;
  const [applyToSeries, setApplyToSeries] = useState(false);

  const [saving, setSaving] = useState(false);
  const [saveProgress, setSaveProgress] = useState({ current: 0, total: 0 });
  const [errorMsg, setErrorMsg] = useState("");

  const tagSuggestions = allTags.filter(
    (t) =>
      !hashtags.includes(t) &&
      t.toLowerCase().includes(tagInput.toLowerCase())
  );

  const addTag = (tag: string) => {
    const cleaned = tag.trim().toLowerCase().replace(/^#/, "");
    if (cleaned && !hashtags.includes(cleaned) && hashtags.length < 50) {
      setHashtags([...hashtags, cleaned]);
    }
    setTagInput("");
    setShowTagSuggestions(false);
  };

  const removeTag = (tag: string) => {
    setHashtags(hashtags.filter((t) => t !== tag));
  };

  const toggleCalendarSelection = (dTag: string) => {
    setSelectedCalendars((prev) =>
      prev.includes(dTag) ? prev.filter((c) => c !== dTag) : [...prev, dTag]
    );
  };

  // Encryption is decided by the calendar assignment — private calendars
  // always encrypt, shared calendars use the shared AES key, public calendars
  // skip encryption entirely.
  const encrypt = shouldEncrypt(selectedCalendars);

  /**
   * Persist a single unsigned event. Routing depends on calendar type:
   *
   * 1. **Shared calendar** (AES-GCM shared key present) — encrypt with the
   *    shared key, sign, publish to relays so other members can decrypt.
   * 2. **Public calendar** (no shared key, no encrypt flag) — sign, publish
   *    as a plaintext NIP-52 event for interop with other Nostr clients.
   * 3. **Private calendar** (default: encrypt flag set, no shared key) —
   *    DO NOTHING HERE. The optimistic-UI add already put it in in-memory
   *    state; auto-backup will persist it into the Blossom blob (encrypted
   *    with AES-256-GCM at the envelope level). Private events never touch
   *    Nostr relays — no signer round-trip, no metadata leak, no per-event
   *    bunker approval.
   */
  const publishOne = async (unsigned: {
    kind: number;
    created_at: number;
    tags: string[][];
    content: string;
  }) => {
    const dTag = unsigned.tags.find((t) => t[0] === "d")?.[1] || "";
    const sharedKeyInfo = getSharedKeyForCalendars(selectedCalendars);
    if (sharedKeyInfo) {
      const encrypted = await encryptEventWithSharedKey(
        sharedKeyInfo.key, sharedKeyInfo.calDTag,
        unsigned.kind, dTag, unsigned.tags, unsigned.content
      );
      const signed = await signEvent({ ...unsigned, tags: encrypted.tags, content: encrypted.content });
      await publishEvent(signed);
    } else if (encrypt) {
      // Private calendar: Blossom blob is the only persistence layer.
      return;
    } else {
      const signed = await signEvent(unsigned);
      await publishEvent(signed);
    }
  };

  const handleSave = async () => {
    if (!title.trim() || !canPublish(selectedCalendars)) return;
    // Sanitize link: reject non-http(s) schemes to prevent XSS via javascript: URIs
    const safeLink = link && /^https?:\/\//i.test(link) ? link : "";

    // Validate that end date/time is not before start date/time
    if (!recurring && endDate && startDate) {
      const startMs = allDay
        ? new Date(`${startDate}T00:00:00`).getTime()
        : new Date(`${startDate}T${startTime || "00:00"}`).getTime();
      const endMs = allDay
        ? new Date(`${endDate}T00:00:00`).getTime()
        : new Date(`${endDate}T${endTime || "00:00"}`).getTime();
      if (endMs < startMs) {
        setErrorMsg("End date/time cannot be before start.");
        return;
      }
    }

    setSaving(true);

    try {
      // Build content: if recurring, store as JSON with description + recurrence
      let content: string;
      if (recurring) {
        content = JSON.stringify({
          description: description || undefined,
          recurrence: { freq: recurrenceFreq, count: recurrenceCount },
        });
      } else {
        content = description;
      }

      if (isSeriesEdit && applyToSeries) {
        // Propagate shared fields (title, location, link, hashtags, calendars,
        // notify, description) to every instance. Each instance keeps its own
        // start/end dates and its own d-tag so sync/deletions still line up.
        const siblings = getSeriesEvents(event!.seriesId!);
        setSaveProgress({ current: 0, total: siblings.length });
        const BATCH_SIZE = 5;
        const updated: Array<{
          unsigned: { kind: number; created_at: number; tags: string[][]; content: string };
          optimistic: CalendarEvent;
        }> = [];

        for (const sib of siblings) {
          let kind: number;
          let tags: string[][];
          if (sib.allDay) {
            kind = KIND_DATE_EVENT;
            tags = buildDateEventTags({
              dTag: sib.dTag,
              title: title.trim(),
              startDate: format(sib.start, "yyyy-MM-dd"),
              endDate: sib.end ? format(sib.end, "yyyy-MM-dd") : undefined,
              location: location || undefined,
              link: safeLink || undefined,
              hashtags: hashtags.length > 0 ? hashtags : undefined,
              calendarRefs: selectedCalendars.length > 0 ? selectedCalendars : undefined,
              seriesId: sib.seriesId,
              notify,
            });
          } else {
            kind = KIND_TIME_EVENT;
            const startUnix = Math.floor(sib.start.getTime() / 1000);
            const endUnix = sib.end ? Math.floor(sib.end.getTime() / 1000) : undefined;
            tags = buildTimeEventTags({
              dTag: sib.dTag,
              title: title.trim(),
              startUnix,
              endUnix,
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              location: location || undefined,
              link: safeLink || undefined,
              hashtags: hashtags.length > 0 ? hashtags : undefined,
              calendarRefs: selectedCalendars.length > 0 ? selectedCalendars : undefined,
              seriesId: sib.seriesId,
              notify,
            });
          }

          updated.push({
            unsigned: { kind, created_at: Math.floor(Date.now() / 1000), tags, content: description },
            optimistic: {
              ...sib,
              title: title.trim(),
              content: description,
              location: location || undefined,
              link: safeLink || undefined,
              hashtags,
              calendarRefs: selectedCalendars,
              notify,
              tags,
              createdAt: Math.floor(Date.now() / 1000),
            },
          });
        }

        for (const u of updated) addEventOptimistic(u.optimistic);
        for (let b = 0; b < updated.length; b += BATCH_SIZE) {
          const batch = updated.slice(b, b + BATCH_SIZE);
          await Promise.all(batch.map((u) => publishOne(u.unsigned)));
          setSaveProgress({ current: Math.min(b + BATCH_SIZE, updated.length), total: updated.length });
        }
      } else if (recurring) {
        // Use existing seriesId when extending, or create a new one
        const seriesId = extendSeries?.seriesId || generateDTag();

        // Generate individual instances as separate Nostr events.
        // Build all events first, then publish in parallel batches of 5
        // to maintain backpressure while avoiding sequential round-trips.
        const BATCH_SIZE = 5;
        setSaveProgress({ current: 0, total: recurrenceCount });
        const pendingPublishes: Array<{ unsigned: { kind: number; created_at: number; tags: string[][]; content: string } }> = [];
        for (let i = 0; i < recurrenceCount; i++) {
          const instanceDTag = (!isExtend && i === 0) ? (event?.dTag || generateDTag()) : generateDTag();
          const baseStart = new Date(
            allDay ? `${startDate}T00:00:00` : `${startDate}T${startTime}`
          );
          const instanceStart = advanceDate(baseStart, recurrenceFreq, i);

          let kind: number;
          let tags: string[][];

          if (allDay) {
            kind = KIND_DATE_EVENT;
            const instEndDate = endDate
              ? format(advanceDate(new Date(`${endDate}T00:00:00`), recurrenceFreq, i), "yyyy-MM-dd")
              : undefined;

            tags = buildDateEventTags({
              dTag: instanceDTag,
              title: title.trim(),
              startDate: format(instanceStart, "yyyy-MM-dd"),
              endDate: instEndDate,
              location: location || undefined,
              link: safeLink || undefined,
              hashtags: hashtags.length > 0 ? hashtags : undefined,
              calendarRefs:
                selectedCalendars.length > 0 ? selectedCalendars : undefined,
              seriesId,
              notify,
            });
          } else {
            kind = KIND_TIME_EVENT;
            const startUnix = Math.floor(instanceStart.getTime() / 1000);
            let endUnix: number | undefined;
            if (endDate && endTime) {
              const instanceEnd = advanceDate(new Date(`${endDate}T${endTime}`), recurrenceFreq, i);
              endUnix = Math.floor(instanceEnd.getTime() / 1000);
            }

            tags = buildTimeEventTags({
              dTag: instanceDTag,
              title: title.trim(),
              startUnix,
              endUnix,
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              location: location || undefined,
              link: safeLink || undefined,
              hashtags: hashtags.length > 0 ? hashtags : undefined,
              calendarRefs:
                selectedCalendars.length > 0 ? selectedCalendars : undefined,
              seriesId,
              notify,
            });
          }

          // Optimistic UI update for each instance
          const instanceEnd = allDay
            ? (endDate ? advanceDate(new Date(`${endDate}T00:00:00`), recurrenceFreq, i) : undefined)
            : (endDate && endTime ? advanceDate(new Date(`${endDate}T${endTime}`), recurrenceFreq, i) : undefined);
          addEventOptimistic({
            id: instanceDTag,
            pubkey: pubkey!,
            kind,
            dTag: instanceDTag,
            title: title.trim(),
            content: i === 0 ? content : description,
            start: instanceStart,
            end: instanceEnd,
            allDay,
            location: location || undefined,
            link: safeLink || undefined,
            hashtags,
            calendarRefs: selectedCalendars,
            seriesId,
            notify,
            tags,
            createdAt: Math.floor(Date.now() / 1000),
          });

          pendingPublishes.push({
            unsigned: {
              kind,
              created_at: Math.floor(Date.now() / 1000),
              tags,
              content: i === 0 ? content : description,
            },
          });
        }

        // Publish in parallel batches
        for (let b = 0; b < pendingPublishes.length; b += BATCH_SIZE) {
          const batch = pendingPublishes.slice(b, b + BATCH_SIZE);
          await Promise.all(batch.map((p) => publishOne(p.unsigned)));
          setSaveProgress({ current: Math.min(b + BATCH_SIZE, pendingPublishes.length), total: recurrenceCount });
        }
      } else {
        // Single event
        const dTag = event?.dTag || generateDTag();
        let kind: number;
        let tags: string[][];

        if (allDay) {
          kind = KIND_DATE_EVENT;
          tags = buildDateEventTags({
            dTag,
            title: title.trim(),
            startDate,
            endDate: endDate || undefined,
            location: location || undefined,
            link: link || undefined,
            hashtags: hashtags.length > 0 ? hashtags : undefined,
            calendarRefs:
              selectedCalendars.length > 0 ? selectedCalendars : undefined,
            notify,
          });
        } else {
          kind = KIND_TIME_EVENT;
          const startUnix = Math.floor(
            new Date(`${startDate}T${startTime}`).getTime() / 1000
          );
          const endUnix =
            endDate && endTime
              ? Math.floor(
                  new Date(`${endDate}T${endTime}`).getTime() / 1000
                )
              : undefined;

          tags = buildTimeEventTags({
            dTag,
            title: title.trim(),
            startUnix,
            endUnix,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            location: location || undefined,
            link: link || undefined,
            hashtags: hashtags.length > 0 ? hashtags : undefined,
            calendarRefs:
              selectedCalendars.length > 0 ? selectedCalendars : undefined,
            notify,
          });
        }

        // Optimistic UI update — show event immediately
        const optimisticEvent: CalendarEvent = {
          id: dTag,
          pubkey: pubkey!,
          kind,
          dTag,
          title: title.trim(),
          content,
          start: allDay
            ? new Date(`${startDate}T00:00:00`)
            : new Date(`${startDate}T${startTime}`),
          end:
            endDate
              ? allDay
                ? new Date(`${endDate}T00:00:00`)
                : endTime
                  ? new Date(`${endDate}T${endTime}`)
                  : undefined
              : undefined,
          allDay,
          location: location || undefined,
          link: safeLink || undefined,
          hashtags,
          calendarRefs: selectedCalendars,
          notify,
          tags,
          createdAt: Math.floor(Date.now() / 1000),
        };
        addEventOptimistic(optimisticEvent);

        const unsigned = {
          kind,
          created_at: Math.floor(Date.now() / 1000),
          tags,
          content,
        };
        await publishOne(unsigned);
      }

      onClose();
      // Background sync — don't block the UI
      refreshEvents().catch(() => {});
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMsg(`Failed to save event: ${msg}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold">
            {isExtend ? "Extend Series" : isEdit ? "Edit Event" : isDuplicate ? "Duplicate Event" : "New Event"}
          </h2>
          <button
            onClick={onClose}
            className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {/* Title */}
          <input
            type="text"
            placeholder="Event title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full px-3 py-2 text-lg border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
            autoFocus
          />

          {/* All-day toggle — intentionally not a <label>: the user wants
              the toggle to fire ONLY when the checkbox itself is clicked,
              not the surrounding "All day" text. */}
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={allDay}
              onChange={(e) => setAllDay(e.target.checked)}
              className="w-4 h-4 text-primary-600 rounded cursor-pointer"
            />
            <span className="text-sm text-gray-700">All day</span>
          </div>

          {/* Start date/time */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">
                Start date
              </label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
            {!allDay && (
              <div>
                <label className="block text-xs text-gray-500 mb-1">
                  Start time
                </label>
                <input
                  type="time"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </div>
            )}
          </div>

          {/* End date/time */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">
                End date (optional)
              </label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
            {!allDay && (
              <div>
                <label className="block text-xs text-gray-500 mb-1">
                  End time
                </label>
                <input
                  type="time"
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </div>
            )}
          </div>

          {/* Link */}
          <div>
            <label className="text-xs text-gray-500 mb-1 flex items-center gap-1">
              <LinkIcon className="w-3 h-3" /> Link (optional)
            </label>
            <input
              type="url"
              placeholder="https://..."
              value={link}
              onChange={(e) => setLink(e.target.value)}
              onBlur={() => {
                if (link && !/^https?:\/\//i.test(link)) setLink("");
              }}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
          </div>

          {/* Location — combined text input + dropdown of known locations.
              "Manage" link opens a modal to rename/delete locations globally.
              Known locations are derived from every event's location field
              so they persist automatically via the snapshot. */}
          <div>
            <label className="text-xs text-gray-500 mb-1 flex items-center gap-1">
              <MapPin className="w-3 h-3" /> Location (optional)
              {locationsByUsage.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowLocationManager(true)}
                  className="ml-auto flex items-center gap-1 text-gray-400 hover:text-primary-600"
                  title="Manage locations"
                >
                  <Settings2 className="w-3 h-3" />
                  Manage
                </button>
              )}
            </label>
            <div className="relative">
              <input
                type="text"
                placeholder="Type or pick a saved location"
                value={location}
                onChange={(e) => {
                  setLocation(e.target.value);
                  setShowLocationDropdown(true);
                }}
                onFocus={() => setShowLocationDropdown(true)}
                onBlur={() => setTimeout(() => setShowLocationDropdown(false), 150)}
                className="w-full px-3 py-2 pr-9 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
              {locationsByUsage.length > 0 && (
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setShowLocationDropdown((v) => !v)}
                  className="absolute right-1 top-1/2 -translate-y-1/2 p-1.5 text-gray-400 hover:text-gray-600 rounded"
                  title="Show saved locations"
                >
                  <ChevronDown className={`w-4 h-4 transition-transform ${showLocationDropdown ? "rotate-180" : ""}`} />
                </button>
              )}
              {(() => {
                if (!showLocationDropdown) return null;
                const q = location.trim().toLowerCase();
                const matches = locationsByUsage
                  .filter((loc) => loc.toLowerCase() !== q)
                  .filter((loc) => q === "" || loc.toLowerCase().includes(q));
                if (matches.length === 0) return null;
                return (
                  <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-20 max-h-56 overflow-y-auto">
                    {matches.map((loc) => (
                      <button
                        key={loc}
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          setLocation(loc);
                          setShowLocationDropdown(false);
                        }}
                        className="w-full text-left px-3 py-1.5 text-sm hover:bg-primary-50 transition-colors truncate"
                      >
                        {loc}
                      </button>
                    ))}
                  </div>
                );
              })()}
            </div>
            {showLocationManager && (
              <LocationManagerModal onClose={() => setShowLocationManager(false)} />
            )}
          </div>

          {/* Tags */}
          <div>
            <label className="text-xs text-gray-500 mb-1 flex items-center gap-1">
              <Tag className="w-3 h-3" /> Tags
            </label>
            {/* Selected tags — X button enlarged for an easy mobile tap target. */}
            <div className="flex flex-wrap gap-1.5 mb-2">
              {hashtags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1 pl-2.5 pr-1 py-0.5 rounded-full text-xs bg-primary-100 text-primary-800"
                >
                  #{tag}
                  <button
                    onClick={() => removeTag(tag)}
                    className="ml-0.5 w-5 h-5 flex items-center justify-center rounded-full hover:bg-primary-200 active:bg-primary-300 text-primary-700"
                    aria-label={`Remove tag ${tag}`}
                    title="Remove tag"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </span>
              ))}
            </div>
            {/* Quick-pick popular tags */}
            {(() => {
              const available = tagsByUsage.filter((t) => !hashtags.includes(t));
              if (available.length === 0) return null;
              const ROW_SIZE = 4;
              const collapsed = available.slice(0, ROW_SIZE * 2);
              const shown = showAllTags ? available : collapsed;
              const hasMore = available.length > ROW_SIZE * 2;
              return (
                <div className="mb-2">
                  <div className="flex flex-wrap gap-1.5">
                    {shown.map((tag) => (
                      <button
                        key={tag}
                        type="button"
                        onClick={() => addTag(tag)}
                        className="px-2 py-0.5 rounded-full text-xs border border-gray-200 text-gray-600 hover:bg-primary-50 hover:border-primary-300 hover:text-primary-700 transition-colors"
                      >
                        #{tag}
                      </button>
                    ))}
                  </div>
                  {hasMore && (
                    <button
                      type="button"
                      onClick={() => setShowAllTags(!showAllTags)}
                      className="mt-1.5 text-xs text-primary-600 hover:text-primary-700"
                    >
                      {showAllTags ? "Show less" : `See all (${available.length})`}
                    </button>
                  )}
                </div>
              );
            })()}
            {/* Tag text input with autocomplete */}
            <div className="relative">
              <input
                type="text"
                placeholder="Add tag and press Enter"
                value={tagInput}
                onChange={(e) => {
                  setTagInput(e.target.value);
                  setShowTagSuggestions(e.target.value.length > 0);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (tagInput.trim()) addTag(tagInput);
                  }
                }}
                onFocus={() => {
                  if (tagInput.length > 0) setShowTagSuggestions(true);
                }}
                onBlur={() =>
                  setTimeout(() => setShowTagSuggestions(false), 150)
                }
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 text-sm"
              />
              {showTagSuggestions && tagSuggestions.length > 0 && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-10 max-h-32 overflow-y-auto">
                  {tagSuggestions.map((tag) => (
                    <button
                      key={tag}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => addTag(tag)}
                      className="w-full text-left px-3 py-1.5 text-sm hover:bg-primary-50 transition-colors"
                    >
                      #{tag}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Recurrence */}
          <div className="border border-gray-200 rounded-lg p-3">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={recurring}
                onChange={(e) => setRecurring(e.target.checked)}
                className="w-4 h-4 text-primary-600 rounded"
              />
              <Repeat className="w-4 h-4 text-gray-500" />
              <span className="text-sm text-gray-700">Recurring event</span>
            </label>
            {recurring && (
              <div className="mt-3 flex items-center gap-3">
                <label className="text-xs text-gray-500">Repeat</label>
                <select
                  value={recurrenceFreq}
                  onChange={(e) =>
                    setRecurrenceFreq(e.target.value as RecurrenceFreq)
                  }
                  className="px-2 py-1.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                >
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="bi-weekly">Bi-weekly</option>
                  <option value="monthly">Monthly</option>
                  <option value="yearly">Yearly</option>
                </select>
                <label className="text-xs text-gray-500">for</label>
                <input
                  type="number"
                  min={2}
                  max={52}
                  value={recurrenceCount}
                  onChange={(e) =>
                    setRecurrenceCount(Math.min(Math.max(parseInt(e.target.value) || 2, 2), 52))
                  }
                  className="w-16 px-2 py-1.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
                <span className="text-xs text-gray-500">times</span>
              </div>
            )}
          </div>

          {/* Calendar assignment */}
          {calendars.length > 0 && (
            <div>
              <label className="text-xs text-gray-500 mb-1.5 flex items-center gap-1">
                <Calendar className="w-3 h-3" /> Calendars
              </label>
              <div className="flex flex-wrap gap-2">
                {calendars.map((cal) => (
                  <button
                    key={cal.dTag}
                    onClick={() => toggleCalendarSelection(cal.dTag)}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors ${
                      selectedCalendars.includes(cal.dTag)
                        ? "border-transparent text-white"
                        : "border-gray-300 text-gray-600 hover:bg-gray-50"
                    }`}
                    style={
                      selectedCalendars.includes(cal.dTag)
                        ? { backgroundColor: cal.color || "#4c6ef5" }
                        : undefined
                    }
                  >
                    <span
                      className="w-2.5 h-2.5 rounded-full"
                      style={{ backgroundColor: cal.color || "#4c6ef5" }}
                    />
                    {cal.title}
                  </button>
                ))}
              </div>
              {selectedCalendars.length === 0 && (
                <p className="mt-1.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                  Pick a calendar, or this event will land in your default calendar only.
                </p>
              )}
            </div>
          )}

          {/* Notification toggle */}
          <label className={`flex items-center gap-2 p-2 -mx-2 rounded-lg ${notificationsEnabled ? "cursor-pointer hover:bg-gray-50" : "opacity-50 cursor-default"}`}>
            {notify && notificationsEnabled ? (
              <Bell className="w-4 h-4 text-primary-500" />
            ) : (
              <BellOff className="w-4 h-4 text-gray-400" />
            )}
            <input
              type="checkbox"
              checked={notify && notificationsEnabled}
              disabled={!notificationsEnabled}
              onChange={(e) => setNotify(e.target.checked)}
              className="w-4 h-4 text-primary-600 rounded"
            />
            <div>
              <span className="text-sm text-gray-700">Notify me</span>
              <p className="text-xs text-gray-400">
                {!notificationsEnabled ? (
                  <>
                    Notifications are off.{" "}
                    {onOpenSettings && (
                      <button
                        type="button"
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); onOpenSettings(); }}
                        className="text-primary-500 hover:text-primary-700 underline"
                      >
                        Turn on in settings
                      </button>
                    )}
                  </>
                ) : notify ? (
                  "Notification will fire per your settings"
                ) : (
                  "No notification for this event"
                )}
              </p>
            </div>
          </label>

          {/* Description */}
          <div>
            <label className="block text-xs text-gray-500 mb-1">
              Description (optional)
            </label>
            <textarea
              placeholder="Add description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 resize-none"
            />
          </div>

          {/* Apply-to-series checkbox — only shown when editing an event that
              belongs to a recurring series. Lives at the bottom so it's the
              last choice the user makes before hitting Save. */}
          {isSeriesEdit && (
            <div className="flex items-center gap-2 p-2 bg-primary-50 border border-primary-200 rounded-lg">
              <input
                id="apply-to-series"
                type="checkbox"
                checked={applyToSeries}
                onChange={(e) => setApplyToSeries(e.target.checked)}
                className="w-4 h-4 text-primary-600 rounded cursor-pointer"
              />
              <label htmlFor="apply-to-series" className="text-sm text-primary-800 cursor-pointer flex-1">
                Apply these changes to all {getSeriesEvents(event!.seriesId!).length} events in the series
                <p className="text-xs text-primary-700/80">Dates stay the same on each instance; title, tags, location, calendars, etc. all update.</p>
              </label>
            </div>
          )}
        </div>

        {/* Publishing gate: if the signer lacks NIP-44 and plaintext mode is off,
            we block publishing entirely. This enforces the privacy-first rule that
            private events must never leak as plaintext NIP-52 kinds. */}
        {!canPublish(selectedCalendars) && (
          <div className="mx-4 mb-0 flex items-center gap-2 p-3 bg-amber-50 rounded-lg">
            <ShieldAlert className="w-4 h-4 text-amber-600 flex-shrink-0" />
            <span className="text-xs text-amber-800">
              Publishing disabled — your Nostr extension doesn't support NIP-44
              encryption. Enable plaintext in Settings to publish without encryption.
            </span>
          </div>
        )}

        {saving && saveProgress.total > 1 && (
          <div className="mx-4 p-3 bg-primary-50 rounded-lg">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-medium text-primary-800">
                Saving to Nostr relays...
              </span>
              <span className="text-xs text-primary-600">
                {saveProgress.current}/{saveProgress.total}
              </span>
            </div>
            <div className="h-1.5 bg-primary-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-primary-500 transition-all duration-200"
                style={{
                  width: `${(saveProgress.current / saveProgress.total) * 100}%`,
                }}
              />
            </div>
            <p className="text-xs text-primary-600 mt-1.5">
              This may take some time with multiple events.
            </p>
          </div>
        )}

        {errorMsg && (
          <div className="mx-4 mb-2 p-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg flex items-center justify-between">
            <span>{errorMsg}</span>
            <button onClick={() => setErrorMsg("")} className="ml-2 text-red-500 hover:text-red-700">
              <X size={14} />
            </button>
          </div>
        )}

        <div className="p-4 border-t border-gray-200 flex justify-end gap-3">
          <button
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!title.trim() || saving || !canPublish(selectedCalendars)}
            className="px-4 py-2 text-sm bg-primary-600 hover:bg-primary-700 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving
              ? "Saving..."
              : isExtend
                ? `Add ${recurrenceCount} more`
                : recurring
                  ? `Create ${recurrenceCount} events`
                  : isEdit
                    ? "Update"
                    : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
