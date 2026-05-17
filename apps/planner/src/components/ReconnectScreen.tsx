import { useEffect, useRef, useState } from "react";
import { Loader, LogOut, RefreshCw, Wifi, WifiOff } from "lucide-react";
import { useNostr } from "../contexts/NostrContext";
import type { ReconnectStatus } from "../lib/nip46Signer";

interface ReconnectScreenProps {
  onSwitchAccount: () => void;
  /** Retained for backwards-compat; the reconnect ladder now waits
   *  persistently across attempts and the user doesn't need to click anything. */
  onWaitLonger?: () => void;
}

/**
 * Returning-user splash shown while the bunker reconnect ladder is in
 * progress. The ladder is persistent (8 attempts, exponential backoff up
 * to 5 min between, pauses while offline/hidden) so this screen now
 * accurately reflects "we're still trying" rather than asking the user
 * to "wait longer" every minute.
 *
 * State drawn from `reconnectStatus` exposed by NostrContext.
 */
export function ReconnectScreen({ onSwitchAccount }: ReconnectScreenProps) {
  const { logout, retryAutoLogin, reconnectStatus } = useNostr();
  // Total elapsed seconds since this screen mounted — used as a soft
  // indicator only, not a hard timeout (the ladder runs on its own clock).
  const [elapsed, setElapsed] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    intervalRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, []);

  const statusLabel = formatStatus(reconnectStatus, elapsed);
  const paused = reconnectStatus?.phase === "paused";
  const exhausted = reconnectStatus?.phase === "exhausted";

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary-50 to-primary-100 p-4 safe-area-pad">
      <div className="bg-white rounded-2xl shadow-xl p-8 max-w-sm w-full space-y-5 text-center">
        <div className="flex justify-center">
          <div className="bg-primary-100 p-4 rounded-full">
            {paused && reconnectStatus?.reason === "offline" ? (
              <WifiOff className="w-10 h-10 text-primary-600" />
            ) : paused ? (
              <Wifi className="w-10 h-10 text-primary-600" />
            ) : (
              <Loader className="w-10 h-10 text-primary-600 animate-spin" />
            )}
          </div>
        </div>

        <div>
          <h1 className="text-xl font-bold text-gray-900">
            {exhausted ? "Couldn't reconnect" : paused && reconnectStatus?.reason === "offline" ? "Waiting for network" : "Reconnecting…"}
          </h1>
          <p className="mt-2 text-sm text-gray-500">
            {exhausted
              ? "Your signer didn't respond. Your data is safe — choose a login method to continue."
              : "Reaching your signer. If your signer app (Amber, nsec.app, bunker, or a browser extension) is installed, approve the request there."}
          </p>
        </div>

        {/* Live status line from the ladder */}
        <div className="text-xs text-gray-500 italic">
          {statusLabel}
        </div>

        <div className="space-y-2">
          {!exhausted && (
            <button
              onClick={retryAutoLogin}
              className="w-full flex items-center justify-center gap-1.5 text-sm font-medium text-gray-600 hover:text-gray-900 bg-gray-50 hover:bg-gray-100 border border-gray-200 rounded-lg py-2 transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Restart now
            </button>
          )}
          <button
            onClick={onSwitchAccount}
            className="w-full text-sm text-gray-600 hover:text-gray-900 py-2"
          >
            Use a different login method
          </button>
          <button
            onClick={logout}
            className="w-full flex items-center justify-center gap-1 text-xs text-gray-400 hover:text-red-500 py-1"
          >
            <LogOut className="w-3 h-3" />
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}

function formatStatus(status: ReconnectStatus | null, elapsed: number): string {
  if (!status) return `Reaching relay… (${elapsed}s)`;
  switch (status.phase) {
    case "attempting":
      return `Attempt ${status.attempt} of ${status.maxAttempts}…`;
    case "waiting":
      return `Attempt ${status.nextAttempt - 1} of ${status.maxAttempts} failed — retrying in ${Math.round(status.nextDelayMs / 1000)}s`;
    case "paused":
      return status.reason === "offline"
        ? "Network appears offline — we'll resume the moment connectivity returns."
        : "Paused while the app is in the background.";
    case "success":
      return "Signer connected — restoring your session…";
    case "exhausted":
      return `Couldn't reach signer: ${status.lastError}`;
  }
}
