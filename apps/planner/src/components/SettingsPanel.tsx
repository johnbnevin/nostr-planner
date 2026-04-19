import { useState } from "react";
import { X, Shield, ShieldOff, AlertTriangle, Bell, Archive, Share2, Radio } from "lucide-react";
import { useSettings, type NotifyMethod } from "../contexts/SettingsContext";
import { useCalendar } from "../contexts/CalendarContext";
import { useNostr } from "../contexts/NostrContext";
import { SUGGESTED_RELAYS } from "../lib/nostr";
import { isTauri } from "../lib/platform";

interface SettingsPanelProps {
  onClose: () => void;
  onBackup: () => void;
  onShareView: () => void;
}

export function SettingsPanel({ onClose, onBackup, onShareView }: SettingsPanelProps) {
  const {
    nip44Available,
    publicCalendars,
    togglePublicCalendar,
    notification,
    setNotification,
    primaryRelay,
    setPrimaryRelay,
  } = useSettings();
  const { calendars } = useCalendar();
  const { nip65Relays } = useNostr();

  // Set of relay URLs the user can choose from their NIP-65 list, plus the
  // suggested hardcoded list. Deduplicated; NIP-65 entries take precedence.
  const nip65Urls = [...new Set([...nip65Relays.read, ...nip65Relays.write])];
  const builtInOptions = SUGGESTED_RELAYS.filter((u) => !nip65Urls.includes(u));

  // "Custom" is selected when the current primary doesn't appear in either
  // list above — i.e. it was entered manually.
  const isBuiltInOrNip65 = nip65Urls.includes(primaryRelay) || builtInOptions.includes(primaryRelay);
  const [customMode, setCustomMode] = useState<boolean>(!isBuiltInOrNip65);
  const [customUrl, setCustomUrl] = useState<string>(isBuiltInOrNip65 ? "" : primaryRelay);
  const [customError, setCustomError] = useState<string>("");

  const applyCustom = () => {
    const trimmed = customUrl.trim();
    if (!/^wss?:\/\//i.test(trimmed)) {
      setCustomError("URL must start with wss:// or ws://");
      return;
    }
    setCustomError("");
    setPrimaryRelay(trimmed);
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold">Settings</h2>
          <button
            onClick={onClose}
            className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 space-y-5">
          {/* Quick actions */}
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => {
                onClose();
                onBackup();
              }}
              className="flex items-center justify-center gap-2 px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              <Archive className="w-4 h-4 text-gray-600" />
              <span className="text-gray-700">Backup / Restore</span>
            </button>
            <button
              onClick={() => {
                onClose();
                onShareView();
              }}
              className="flex items-center justify-center gap-2 px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              <Share2 className="w-4 h-4 text-gray-600" />
              <span className="text-gray-700">Share View</span>
            </button>
          </div>

          {/* Encryption status */}
          <div>
            <h3 className="text-sm font-semibold text-gray-700 mb-2 flex items-center gap-2">
              <Shield className="w-4 h-4" /> Privacy
            </h3>

            {nip44Available ? (
              <div className="flex items-start gap-2 p-3 bg-emerald-50 rounded-lg mb-3">
                <Shield className="w-4 h-4 text-emerald-600 mt-0.5 flex-shrink-0" />
                <div className="text-sm text-emerald-800">
                  <span className="font-medium">NIP-44 encryption active.</span>{" "}
                  Your calendar data is encrypted by default. Relays cannot see
                  your events or even know it's a calendar.
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-2 p-3 bg-amber-50 rounded-lg mb-3">
                <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" />
                <div className="text-sm text-amber-800">
                  <span className="font-medium">
                    NIP-44 encryption not available.
                  </span>{" "}
                  Your signer does not support NIP-44. You can only publish to
                  public calendars until encryption is available.
                </div>
              </div>
            )}
          </div>

          {/* Primary relay */}
          <div>
            <h3 className="text-sm font-semibold text-gray-700 mb-2 flex items-center gap-2">
              <Radio className="w-4 h-4" /> Primary Relay
            </h3>
            <p className="text-xs text-gray-400 mb-3">
              All reads and interactive publishes go here first. Other
              relays in your list receive background copies during idle
              time for durability, but never slow the app down. Pick one
              you control or trust for fast, reliable performance.
            </p>

            <div className="space-y-1">
              {nip65Urls.length > 0 && (
                <div className="mb-2">
                  <div className="text-xs text-gray-500 mb-1 px-1">From your Nostr relays (NIP-65)</div>
                  {nip65Urls.map((url) => (
                    <label
                      key={`nip65-${url}`}
                      className={`flex items-center gap-2 p-2 rounded-lg cursor-pointer transition-colors ${
                        primaryRelay === url && !customMode ? "bg-primary-50" : "hover:bg-gray-50"
                      }`}
                    >
                      <input
                        type="radio"
                        name="primary-relay"
                        checked={primaryRelay === url && !customMode}
                        onChange={() => {
                          setCustomMode(false);
                          setCustomError("");
                          setPrimaryRelay(url);
                        }}
                        className="w-4 h-4 text-primary-600"
                      />
                      <span className="text-sm text-gray-700 break-all">{url}</span>
                    </label>
                  ))}
                </div>
              )}

              {builtInOptions.length > 0 && (
                <div className="mb-2">
                  <div className="text-xs text-gray-500 mb-1 px-1">Suggested</div>
                  {builtInOptions.map((url) => (
                    <label
                      key={`suggested-${url}`}
                      className={`flex items-center gap-2 p-2 rounded-lg cursor-pointer transition-colors ${
                        primaryRelay === url && !customMode ? "bg-primary-50" : "hover:bg-gray-50"
                      }`}
                    >
                      <input
                        type="radio"
                        name="primary-relay"
                        checked={primaryRelay === url && !customMode}
                        onChange={() => {
                          setCustomMode(false);
                          setCustomError("");
                          setPrimaryRelay(url);
                        }}
                        className="w-4 h-4 text-primary-600"
                      />
                      <span className="text-sm text-gray-700 break-all">{url}</span>
                    </label>
                  ))}
                </div>
              )}

              <div>
                <label
                  className={`flex items-start gap-2 p-2 rounded-lg cursor-pointer transition-colors ${
                    customMode ? "bg-primary-50" : "hover:bg-gray-50"
                  }`}
                >
                  <input
                    type="radio"
                    name="primary-relay"
                    checked={customMode}
                    onChange={() => setCustomMode(true)}
                    className="mt-0.5 w-4 h-4 text-primary-600"
                  />
                  <div className="flex-1">
                    <span className="text-sm text-gray-700">Custom</span>
                    <p className="text-xs text-gray-400">
                      Enter any relay URL you control or trust
                    </p>
                  </div>
                </label>
                {customMode && (
                  <div className="mt-2 pl-6 space-y-1">
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={customUrl}
                        onChange={(e) => { setCustomUrl(e.target.value); setCustomError(""); }}
                        onKeyDown={(e) => { if (e.key === "Enter") applyCustom(); }}
                        placeholder="wss://relay.example.com"
                        className="flex-1 min-w-0 px-2 py-1.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                      />
                      <button
                        onClick={applyCustom}
                        disabled={!customUrl.trim()}
                        className="px-3 py-1.5 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
                      >
                        Set
                      </button>
                    </div>
                    {customError && (
                      <p className="text-xs text-red-600">{customError}</p>
                    )}
                    {!customError && customUrl.trim() && customUrl.trim() === primaryRelay && (
                      <p className="text-xs text-emerald-600">Active</p>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Public calendars */}
          {calendars.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-gray-700 mb-2 flex items-center gap-2">
                <ShieldOff className="w-4 h-4" /> Public Calendars
              </h3>
              <p className="text-xs text-gray-400 mb-3">
                Events on public calendars are published as standard NIP-52
                events. Other Nostr clients can read them. Other users can
                subscribe to or display your public calendar. This is
                different from shared calendars, which are encrypted and
                only visible to members you invite.
              </p>
              <div className="space-y-1">
                {calendars.map((cal) => (
                  <label
                    key={cal.dTag}
                    className="flex items-center gap-2 p-2 rounded-lg hover:bg-gray-50 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={publicCalendars.has(cal.dTag)}
                      onChange={() => togglePublicCalendar(cal.dTag)}
                      className="w-4 h-4 rounded"
                    />
                    <span
                      className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                      style={{ backgroundColor: cal.color || "#4c6ef5" }}
                    />
                    <span className="text-sm text-gray-700">{cal.title}</span>
                    {publicCalendars.has(cal.dTag) && (
                      <span className="text-xs text-amber-600 ml-auto">
                        Public
                      </span>
                    )}
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* Notifications */}
          <div>
            <h3 className="text-sm font-semibold text-gray-700 mb-2 flex items-center gap-2">
              <Bell className="w-4 h-4" /> Notifications
            </h3>

            <label className="flex items-center gap-2 cursor-pointer p-2 rounded-lg hover:bg-gray-50 mb-2">
              <input
                type="checkbox"
                checked={notification.enabled}
                onChange={(e) => setNotification({ enabled: e.target.checked })}
                className="w-4 h-4 text-primary-600 rounded"
              />
              <div>
                <span className="text-sm text-gray-700">Enable notifications</span>
                <p className="text-xs text-gray-400">
                  Get notified before events start
                </p>
              </div>
            </label>

            {notification.enabled && (
              <div className="space-y-3 pl-2">
                {/* Method */}
                <div>
                  <label className="block text-xs text-gray-500 mb-1.5">
                    How to notify
                  </label>
                  <div className="space-y-1">
                    {([
                      ["in-app", "In-app alert", "Banner shown inside the calendar"],
                      ["push", "Push notification", isTauri() ? "System notification from the app" : "Browser notification (must allow when prompted)"],
                    ] as [NotifyMethod, string, string][]).map(([method, label, desc]) => (
                      <label
                        key={method}
                        className={`flex items-start gap-2 p-2 rounded-lg cursor-pointer transition-colors ${
                          notification.method === method ? "bg-primary-50" : "hover:bg-gray-50"
                        }`}
                      >
                        <input
                          type="radio"
                          name="notify-method"
                          checked={notification.method === method}
                          onChange={() => {
                            setNotification({ method });
                            if (method === "push") {
                              import("../lib/notify").then((m) => m.requestPermission());
                            }
                          }}
                          className="mt-0.5 w-4 h-4 text-primary-600"
                        />
                        <div>
                          <span className="text-sm text-gray-700">{label}</span>
                          <p className="text-xs text-gray-400">{desc}</p>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>

                {/* Timing */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">
                      All-day events
                    </label>
                    <select
                      value={notification.allDayMinsBefore}
                      onChange={(e) => setNotification({ allDayMinsBefore: Number(e.target.value) })}
                      className="w-full px-2 py-1.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                    >
                      <option value={0}>At start of day</option>
                      <option value={60}>1 hour before</option>
                      <option value={120}>2 hours before</option>
                      <option value={480}>8 hours before</option>
                      <option value={720}>12 hours before</option>
                      <option value={1440}>1 day before</option>
                      <option value={2880}>2 days before</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">
                      Timed events
                    </label>
                    <select
                      value={notification.timedMinsBefore}
                      onChange={(e) => setNotification({ timedMinsBefore: Number(e.target.value) })}
                      className="w-full px-2 py-1.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                    >
                      <option value={0}>At event time</option>
                      <option value={5}>5 minutes before</option>
                      <option value={10}>10 minutes before</option>
                      <option value={15}>15 minutes before</option>
                      <option value={30}>30 minutes before</option>
                      <option value={60}>1 hour before</option>
                      <option value={120}>2 hours before</option>
                      <option value={1440}>1 day before</option>
                    </select>
                  </div>
                </div>

                <p className="text-xs text-gray-400">
                  Individual events can opt out via the notification checkbox when creating or editing.
                </p>
              </div>
            )}
          </div>

        </div>

        <div className="p-4 border-t border-gray-100">
          <button
            onClick={onClose}
            className="w-full px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
