import { Loader, LogOut, RefreshCw } from "lucide-react";
import { useNostr } from "../contexts/NostrContext";
import { isStandalonePWA } from "../lib/platform";

interface ReconnectScreenProps {
  /** Show the full LoginScreen instead (e.g. user wants to switch accounts). */
  onSwitchAccount: () => void;
}

/**
 * Returning-user splash. Shown when localStorage has a saved pubkey but the
 * signer hasn't been re-established yet. The alternative — dropping the user
 * straight onto the full LoginScreen — looks like an unexpected logout when
 * all the app actually needs is another second or two to reach Amber/bunker.
 */
export function ReconnectScreen({ onSwitchAccount }: ReconnectScreenProps) {
  const { autoLoginState, retryAutoLogin, logout } = useNostr();
  const inPWA = isStandalonePWA();
  const attempting = autoLoginState === "attempting";

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary-50 to-primary-100 p-4 safe-area-pad">
      <div className="bg-white rounded-2xl shadow-xl p-8 max-w-sm w-full space-y-5 text-center">
        <div className="flex justify-center">
          <div className="bg-primary-100 p-4 rounded-full">
            {attempting ? (
              <Loader className="w-10 h-10 text-primary-600 animate-spin" />
            ) : (
              <RefreshCw className="w-10 h-10 text-primary-600" />
            )}
          </div>
        </div>
        <div>
          <h1 className="text-xl font-bold text-gray-900">
            {attempting ? "Reconnecting…" : "Session paused"}
          </h1>
          <p className="mt-2 text-sm text-gray-500">
            {attempting ? (
              "Reaching your signer. If your signer app (Amber, nsec.app, bunker) is installed, approve the request there."
            ) : inPWA ? (
              "Your browser extension isn't available in installed-app mode. Tap Try again after opening your signer, or switch to Amber / bunker / seed-phrase login."
            ) : (
              "Couldn't reach your signer. Open the extension or signer app and tap Try again."
            )}
          </p>
        </div>
        <div className="space-y-2">
          <button
            onClick={retryAutoLogin}
            disabled={attempting}
            className="w-full bg-primary-600 hover:bg-primary-700 text-white font-semibold py-2.5 px-4 rounded-xl transition-colors disabled:opacity-60"
          >
            {attempting ? "Connecting…" : "Try again"}
          </button>
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
