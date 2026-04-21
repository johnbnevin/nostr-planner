import { Loader, LogOut } from "lucide-react";
import { useNostr } from "../contexts/NostrContext";

interface ReconnectScreenProps {
  /** Show the full LoginScreen instead (e.g. auto-login is taking too
   *  long and the user wants to pick a different method). */
  onSwitchAccount: () => void;
}

/**
 * Returning-user splash shown only while auto-login is actively
 * attempting. Dropping the user straight onto the full LoginScreen
 * during that window would look like an unexpected logout when all
 * the app actually needs is another second or two to reach Amber /
 * bunker / the NIP-07 extension.
 *
 * If auto-login fails outright, App.tsx routes to LoginScreen directly
 * — the older "Session paused / Try again" branch that used to live
 * here never recovered in practice and was just a speed bump.
 */
export function ReconnectScreen({ onSwitchAccount }: ReconnectScreenProps) {
  const { logout } = useNostr();

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
        <div className="space-y-2">
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
