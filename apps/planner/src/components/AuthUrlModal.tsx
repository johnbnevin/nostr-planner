import { useEffect, useState } from "react";
import { ExternalLink, ShieldCheck, X } from "lucide-react";
import { onAuthUrl } from "../lib/authUrl";

/**
 * Lightweight modal that surfaces NIP-46 `auth_url` approval requests.
 *
 * Why this exists: when a bunker (Amber, nsec.app, …) requires per-action
 * approval, it replies with an `auth_url` the user must visit. Calling
 * `window.open()` directly from the SDK callback is blocked by the
 * browser when there's no user gesture, and on mobile/standalone PWAs it
 * routes the user out of the app entirely — often killing the relay
 * subscription before approval can land. This modal queues the URL and
 * waits for the user to tap, which is a real gesture the browser will
 * honor.
 */
export function AuthUrlModal() {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    const off = onAuthUrl((u) => setUrl(u));
    return () => off();
  }, []);

  if (!url) return null;

  const open = () => {
    // window.open works in both browser PWA and Tauri webviews — the
    // Tauri runtime routes _blank URLs to the system browser. The
    // critical thing is that we're in a real user-gesture handler here,
    // which mobile Safari requires to honor the popup.
    const w = window.open(url, "_blank", "noopener,noreferrer");
    if (!w) {
      // Popup blocked — last resort, navigate the current tab. The PWA's
      // relay sub may drop, but the reconnect ladder will pick it up on
      // return.
      window.location.href = url;
    }
    setUrl(null);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-2xl shadow-xl max-w-sm w-full p-6 space-y-4 relative">
        <button
          onClick={() => setUrl(null)}
          className="absolute top-3 right-3 p-1 rounded-lg hover:bg-gray-100"
          aria-label="Dismiss"
        >
          <X className="w-4 h-4 text-gray-500" />
        </button>
        <div className="flex justify-center">
          <div className="bg-primary-100 p-3 rounded-full">
            <ShieldCheck className="w-8 h-8 text-primary-600" />
          </div>
        </div>
        <div className="text-center space-y-1">
          <h2 className="text-lg font-semibold text-gray-900">Approve in your signer</h2>
          <p className="text-sm text-gray-500">
            Your remote signer needs your approval to continue. Tap below to open the approval page.
          </p>
        </div>
        <button
          onClick={() => void open()}
          className="w-full flex items-center justify-center gap-2 bg-primary-600 hover:bg-primary-700 text-white py-2.5 rounded-xl text-sm font-medium"
        >
          <ExternalLink className="w-4 h-4" />
          Open approval page
        </button>
        <p className="text-[11px] text-gray-400 text-center break-all">{url}</p>
      </div>
    </div>
  );
}
