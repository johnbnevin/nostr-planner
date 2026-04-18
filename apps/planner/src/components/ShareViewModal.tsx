import { useMemo, useState } from "react";
import { Check, Copy, Share2, X, Smartphone } from "lucide-react";
import { useBuildShareUrl } from "../hooks/useViewShare";
import { useCalendar } from "../contexts/CalendarContext";
import { useSettings } from "../contexts/SettingsContext";

interface ShareViewModalProps {
  onClose: () => void;
}

/**
 * "Share this view" modal. Generates a URL capturing the current view
 * mode, calendar filter, tag filter, panel toggles, and focus date. On a
 * phone, the user can open that URL and tap "Add to Home Screen" to create
 * a launcher icon that opens the app pre-filtered — the closest thing to a
 * proper OS widget we can offer from a web app.
 */
export function ShareViewModal({ onClose }: ShareViewModalProps) {
  const build = useBuildShareUrl();
  const { calendars, activeCalendarIds, activeTag, viewMode } = useCalendar();
  const { showDaily, showLists } = useSettings();

  const url = useMemo(() => build(), [build]);
  const [copied, setCopied] = useState(false);

  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard denied */ }
  };

  const share = async () => {
    type WithShare = Navigator & { share?: (data: ShareData) => Promise<void> };
    const nav = navigator as WithShare;
    if (!nav.share) {
      await copyUrl();
      return;
    }
    try {
      await nav.share({
        title: "Planner view",
        text: "Open this Planner view",
        url,
      });
    } catch { /* user cancelled */ }
  };

  const activeCalNames = calendars
    .filter((c) => activeCalendarIds.has(c.dTag))
    .map((c) => c.title);

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between p-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
            <Share2 className="w-5 h-5" />
            Share this view
          </h2>
          <button
            onClick={onClose}
            className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          <p className="text-sm text-gray-600">
            Generate a URL that opens the app with your current filters applied —
            tap Add to Home Screen on it for a one-tap widget launcher.
          </p>

          {/* Summary of what's encoded */}
          <div className="p-3 bg-gray-50 rounded-lg border border-gray-200 space-y-1.5">
            <p className="text-xs font-semibold text-gray-700 uppercase tracking-wide">This view includes</p>
            <p className="text-sm text-gray-800">
              <span className="text-gray-500">View mode:</span> {viewMode}
            </p>
            <p className="text-sm text-gray-800">
              <span className="text-gray-500">Calendars:</span>{" "}
              {activeCalNames.length === 0
                ? "none"
                : activeCalNames.length === calendars.length
                  ? "all"
                  : activeCalNames.join(", ")}
            </p>
            {activeTag && (
              <p className="text-sm text-gray-800">
                <span className="text-gray-500">Tag filter:</span> #{activeTag}
              </p>
            )}
            <p className="text-sm text-gray-800">
              <span className="text-gray-500">Panels:</span>{" "}
              {!showDaily && !showLists
                ? "calendar only"
                : [showDaily && "daily habits", showLists && "to-do lists"].filter(Boolean).join(" + ")}
            </p>
          </div>

          {/* URL + copy */}
          <div>
            <label className="text-xs font-semibold text-gray-700 uppercase tracking-wide mb-1 block">
              Shareable link
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                readOnly
                value={url}
                onFocus={(e) => e.currentTarget.select()}
                className="flex-1 px-3 py-2 text-xs font-mono border border-gray-300 rounded-lg bg-gray-50 focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
              <button
                onClick={copyUrl}
                className="flex items-center gap-1 px-3 py-2 bg-primary-600 hover:bg-primary-700 text-white text-sm rounded-lg transition-colors"
              >
                {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>

          {/* How-to */}
          <div className="p-3 bg-primary-50 rounded-lg border border-primary-200 space-y-2">
            <p className="text-sm font-semibold text-primary-900 flex items-center gap-1.5">
              <Smartphone className="w-4 h-4" />
              Add to home screen
            </p>
            <ol className="list-decimal list-inside text-xs text-primary-800 space-y-1">
              <li>Tap Share below (or copy the link and open it in your mobile browser).</li>
              <li>In your browser's share sheet, choose <em>Add to Home Screen</em>.</li>
              <li>Tap the new icon to launch this view directly. Filters reapply automatically.</li>
            </ol>
          </div>

          <button
            onClick={share}
            className="w-full flex items-center justify-center gap-2 py-2.5 bg-primary-600 hover:bg-primary-700 text-white font-medium rounded-xl transition-colors"
          >
            <Share2 className="w-4 h-4" />
            Share…
          </button>
        </div>
      </div>
    </div>
  );
}
