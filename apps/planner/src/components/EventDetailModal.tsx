import { useState } from "react";
import {
  X,
  Edit2,
  Trash2,
  MapPin,
  Clock,
  FileText,
  Link as LinkIcon,
  Tag,
  Repeat,
  Copy,
} from "lucide-react";
import { useCalendar } from "../contexts/CalendarContext";
import { format } from "date-fns";
import type { CalendarEvent } from "../lib/nostr";

interface EventDetailModalProps {
  event: CalendarEvent;
  onClose: () => void;
  onEdit: (event: CalendarEvent) => void;
  onExtendSeries?: (event: CalendarEvent) => void;
  onDuplicate?: (event: CalendarEvent) => void;
}

export function EventDetailModal({
  event,
  onClose,
  onEdit,
  onExtendSeries,
  onDuplicate,
}: EventDetailModalProps) {
  const { deleteEvent, deleteSeries, calendars, getSeriesEvents } = useCalendar();
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [confirmingSeries, setConfirmingSeries] = useState(false);

  const seriesCount = event.seriesId ? getSeriesEvents(event.seriesId).length : 0;

  const handleDelete = async () => {
    // Recurring: open the two-option confirm instead of the browser prompt.
    if (event.seriesId && seriesCount > 1) {
      setConfirmingSeries(true);
      return;
    }
    if (!confirm("Delete this event?")) return;
    setDeleting(true);
    setDeleteError("");
    try {
      await deleteEvent(event);
      onClose();
    } catch (err) {
      setDeleteError(`Failed to delete: ${err}`);
    } finally {
      setDeleting(false);
    }
  };

  const confirmDeleteOne = async () => {
    setConfirmingSeries(false);
    setDeleting(true);
    setDeleteError("");
    try {
      await deleteEvent(event);
      onClose();
    } catch (err) {
      setDeleteError(`Failed to delete: ${err}`);
    } finally {
      setDeleting(false);
    }
  };

  const confirmDeleteSeries = async () => {
    if (!event.seriesId) return;
    setConfirmingSeries(false);
    setDeleting(true);
    setDeleteError("");
    try {
      await deleteSeries(event.seriesId);
      onClose();
    } catch (err) {
      setDeleteError(`Failed to delete series: ${err}`);
    } finally {
      setDeleting(false);
    }
  };

  const eventCalendars = calendars.filter((c) =>
    event.calendarRefs.includes(c.dTag)
  );

  // Extract plain description from possibly-JSON content
  const description = (() => {
    try {
      const parsed = JSON.parse(event.content);
      return parsed?.description || "";
    } catch {
      return event.content;
    }
  })();

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full">
        <div className="flex items-center justify-between p-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">
            {event.title}
          </h2>
          <div className="flex items-center gap-1">
            {event.seriesId && onExtendSeries && (
              <button
                onClick={() => onExtendSeries(event)}
                className="p-1.5 hover:bg-primary-50 rounded-lg transition-colors"
                title={`Extend series (${getSeriesEvents(event.seriesId).length} events)`}
              >
                <Repeat className="w-4 h-4 text-primary-500" />
              </button>
            )}
            {onDuplicate && (
              <button
                onClick={() => onDuplicate(event)}
                className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors"
                title="Duplicate"
              >
                <Copy className="w-4 h-4 text-gray-500" />
              </button>
            )}
            <button
              onClick={() => onEdit(event)}
              className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors"
              title="Edit"
            >
              <Edit2 className="w-4 h-4 text-gray-500" />
            </button>
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="p-1.5 hover:bg-red-50 rounded-lg transition-colors"
              title="Delete"
            >
              <Trash2 className="w-4 h-4 text-red-500" />
            </button>
            <button
              onClick={onClose}
              className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {deleteError && (
          <div className="mx-4 mt-2 p-2 bg-red-50 border border-red-200 text-red-700 text-xs rounded-lg">{deleteError}</div>
        )}

        <div className="p-4 space-y-3">
          {/* Date/time */}
          <div className="flex items-start gap-3">
            <Clock className="w-5 h-5 text-gray-400 mt-0.5" />
            <div>
              {event.allDay ? (
                <div className="text-sm text-gray-700">
                  {format(event.start, "EEEE, MMMM d, yyyy")}
                  {event.end && (
                    <>
                      {" "}
                      &mdash; {format(event.end, "EEEE, MMMM d, yyyy")}
                    </>
                  )}
                  <span className="text-gray-400 ml-2">(all day)</span>
                </div>
              ) : (
                <div className="text-sm text-gray-700">
                  {format(event.start, "EEEE, MMMM d, yyyy")}
                  <br />
                  {format(event.start, "h:mm a")}
                  {event.end && <> &mdash; {format(event.end, "h:mm a")}</>}
                </div>
              )}
            </div>
          </div>

          {/* Location — tap to open in Maps. Uses the universal Google Maps
              search URL, which iOS/Android deep-link to their native Maps app
              when installed, and falls back to the web map otherwise. */}
          {event.location && (
            <div className="flex items-start gap-3">
              <MapPin className="w-5 h-5 text-gray-400 mt-0.5" />
              <a
                href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(event.location)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-primary-600 hover:text-primary-700 underline break-all"
                title="Open in Maps"
              >
                {event.location}
              </a>
            </div>
          )}

          {/* Link */}
          {event.link && (
            <div className="flex items-start gap-3">
              <LinkIcon className="w-5 h-5 text-gray-400 mt-0.5" />
              <a
                href={event.link}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-primary-600 hover:text-primary-700 underline break-all"
              >
                {event.link}
              </a>
            </div>
          )}

          {/* Tags */}
          {event.hashtags.length > 0 && (
            <div className="flex items-start gap-3">
              <Tag className="w-5 h-5 text-gray-400 mt-0.5" />
              <div className="flex flex-wrap gap-1.5">
                {event.hashtags.map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex px-2 py-0.5 rounded-full text-xs bg-primary-100 text-primary-800"
                  >
                    #{tag}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Calendars */}
          {eventCalendars.length > 0 && (
            <div className="flex items-start gap-3">
              <div className="w-5 h-5 flex items-center justify-center mt-0.5">
                <div className="w-3 h-3 rounded-sm bg-gray-400" />
              </div>
              <div className="flex flex-wrap gap-1.5">
                {eventCalendars.map((cal) => (
                  <span
                    key={cal.dTag}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium text-white"
                    style={{ backgroundColor: cal.color || "#4c6ef5" }}
                  >
                    {cal.title}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Series info */}
          {event.seriesId && (
            <div className="flex items-start gap-3">
              <Repeat className="w-5 h-5 text-gray-400 mt-0.5" />
              <span className="text-sm text-gray-700">
                Part of a recurring series ({getSeriesEvents(event.seriesId).length} events)
              </span>
            </div>
          )}

          {/* Description */}
          {description && (
            <div className="flex items-start gap-3">
              <FileText className="w-5 h-5 text-gray-400 mt-0.5" />
              <p className="text-sm text-gray-700 whitespace-pre-wrap">
                {description}
              </p>
            </div>
          )}
        </div>

        <div className="p-4 border-t border-gray-100">
          <button
            onClick={onClose}
            className="w-full px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
          >
            Close
          </button>
        </div>

        {/* Series delete confirmation — only appears for recurring events.
            The browser prompt can't express two destructive choices cleanly,
            so we render our own modal on top of the detail view. */}
        {confirmingSeries && (
          <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[60] p-4">
            <div className="bg-white rounded-2xl shadow-2xl max-w-sm w-full p-5 space-y-3">
              <h3 className="text-base font-semibold text-gray-900">Delete recurring event</h3>
              <p className="text-sm text-gray-600">
                This event is part of a series of {seriesCount}. What would you like to delete?
              </p>
              <div className="flex flex-col gap-2 pt-1">
                <button
                  onClick={confirmDeleteOne}
                  disabled={deleting}
                  className="w-full px-4 py-2 text-sm bg-red-50 hover:bg-red-100 text-red-700 rounded-lg transition-colors disabled:opacity-50"
                >
                  Just this event
                </button>
                <button
                  onClick={confirmDeleteSeries}
                  disabled={deleting}
                  className="w-full px-4 py-2 text-sm bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors disabled:opacity-50"
                >
                  All {seriesCount} events in the series
                </button>
                <button
                  onClick={() => setConfirmingSeries(false)}
                  disabled={deleting}
                  className="w-full px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
