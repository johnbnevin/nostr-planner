import { useEffect, useRef, useState } from "react";
import { Loader, LogOut, RefreshCw } from "lucide-react";
import { useNostr } from "../contexts/NostrContext";

interface ReconnectScreenProps {
  onSwitchAccount: () => void;
  /** Called when user clicks "Wait longer" — App.tsx uses this to prevent
   *  routing to LoginScreen if the 60-second bunker window expires. */
  onWaitLonger: () => void;
}

/** Must match the bunker reconnect timeout in NostrContext (connectBunkerUri 60 000 ms). */
const ATTEMPT_SECONDS = 60;
const SHOW_WAIT_LONGER_AT = 15;
const WAIT_LONGER_EXTENSION = 60;

const statusMessages = [
  { at: 0,  text: "Reaching relay…" },
  { at: 6,  text: "Waiting for signer response…" },
  { at: 15, text: "Slow connection — still trying…" },
  { at: 30, text: "Taking a while. If your signer app has a pending approval, open it now." },
  { at: 50, text: "Almost out of time. Check that your signer (Amber, nsec.app…) is reachable." },
];

/**
 * Returning-user splash shown while auto-login is in progress.
 *
 * - Countdown tracks the live 60-second bunker reconnect window.
 *   The key prop on this component (managed by App.tsx) resets elapsed
 *   when a new attempt starts, so the countdown always reflects the
 *   current attempt.
 * - "Wait longer" extends the visual timer only — the underlying
 *   connection attempt is not touched. App.tsx silently restarts it
 *   when the 60-second window expires.
 * - "Cancel and retry" immediately starts a fresh attempt.
 */
export function ReconnectScreen({ onSwitchAccount, onWaitLonger }: ReconnectScreenProps) {
  const { logout, retryAutoLogin } = useNostr();
  const [elapsed, setElapsed] = useState(0);
  const [timeLimit, setTimeLimit] = useState(ATTEMPT_SECONDS);
  const [waitingLonger, setWaitingLonger] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    intervalRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, []);

  const remaining = Math.max(0, timeLimit - elapsed);
  const pct = Math.min(100, (elapsed / timeLimit) * 100);

  const filtered = statusMessages.filter((m) => elapsed >= m.at);
  const status = filtered.length > 0 ? filtered[filtered.length - 1].text : statusMessages[0].text;

  const handleWaitLonger = () => {
    setTimeLimit((t) => t + WAIT_LONGER_EXTENSION);
    setWaitingLonger(true);
    onWaitLonger();
  };

  const handleCancelRetry = () => {
    retryAutoLogin();
    // key change in App.tsx will remount this component, resetting the countdown
  };

  const showWaitLonger = elapsed >= SHOW_WAIT_LONGER_AT && !waitingLonger;

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary-50 to-primary-100 p-4 safe-area-pad">
      <div className="bg-white rounded-2xl shadow-xl p-8 max-w-sm w-full space-y-5 text-center">
        <div className="flex justify-center">
          <div className="bg-primary-100 p-4 rounded-full">
            <Loader className="w-10 h-10 text-primary-600 animate-spin" />
          </div>
        </div>

        <div>
          <h1 className="text-xl font-bold text-gray-900">Reconnecting…</h1>
          <p className="mt-2 text-sm text-gray-500">
            Reaching your signer. If your signer app (Amber, nsec.app,
            bunker, or a browser extension) is installed, approve the
            request there.
          </p>
        </div>

        {/* Progress bar + countdown — aligned to the live 60-second attempt */}
        <div className="space-y-1.5">
          <div className="w-full bg-gray-100 rounded-full h-1.5 overflow-hidden">
            <div
              className="h-full bg-primary-500 rounded-full transition-all duration-1000"
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="flex items-center justify-between text-xs text-gray-400">
            <span className="italic text-left">{status}</span>
            <span className="tabular-nums font-medium text-gray-500 ml-2 shrink-0">{remaining}s</span>
          </div>
        </div>

        <div className="space-y-2">
          {showWaitLonger && (
            <button
              onClick={handleWaitLonger}
              className="w-full flex items-center justify-center gap-1.5 text-sm font-medium text-primary-700 bg-primary-50 hover:bg-primary-100 border border-primary-200 rounded-lg py-2 transition-colors"
            >
              Wait longer
            </button>
          )}
          {waitingLonger && (
            <button
              onClick={handleCancelRetry}
              className="w-full flex items-center justify-center gap-1.5 text-sm font-medium text-gray-600 hover:text-gray-900 bg-gray-50 hover:bg-gray-100 border border-gray-200 rounded-lg py-2 transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Cancel and retry
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
