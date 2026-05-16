import { CloudOff, CloudUpload, Loader, WifiOff } from "lucide-react";
import { useNostr } from "../contexts/NostrContext";
import { useOnline } from "../lib/online";

/**
 * Compact connectivity / sync indicator for the header.
 *
 * Visible only when something is interesting:
 *   - Offline → red Wi-Fi-off icon (cached reads still work).
 *   - Reconnecting signer → spinner with attempt counter.
 *   - Pending outbox writes → cloud icon with count badge.
 *   - All good and signer healthy → nothing rendered.
 */
export function SyncStatusPill({ compact = false }: { compact?: boolean }) {
  const { autoLoginState, reconnectStatus, outboxDepth, signer } = useNostr();
  const online = useOnline();

  const signerMissing = !signer && (autoLoginState === "reconnecting" || autoLoginState === "attempting");

  if (online && !signerMissing && outboxDepth === 0) return null;

  if (!online) {
    return (
      <span
        className={`inline-flex items-center gap-1 rounded-full bg-red-50 text-red-700 border border-red-200 ${compact ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-0.5 text-xs"}`}
        title="Offline — changes will sync when you reconnect"
      >
        <WifiOff className={compact ? "w-3 h-3" : "w-3.5 h-3.5"} />
        {!compact && <span>Offline</span>}
        {outboxDepth > 0 && (
          <span className="font-semibold tabular-nums">{outboxDepth}</span>
        )}
      </span>
    );
  }

  if (signerMissing) {
    const attempt = reconnectStatus?.phase === "attempting"
      ? `${reconnectStatus.attempt}/${reconnectStatus.maxAttempts}`
      : reconnectStatus?.phase === "waiting"
        ? `${reconnectStatus.nextAttempt - 1}/${reconnectStatus.maxAttempts}`
        : null;
    return (
      <span
        className={`inline-flex items-center gap-1 rounded-full bg-amber-50 text-amber-700 border border-amber-200 ${compact ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-0.5 text-xs"}`}
        title="Reconnecting to your signer"
      >
        <Loader className={`${compact ? "w-3 h-3" : "w-3.5 h-3.5"} animate-spin`} />
        {!compact && <span>Reconnecting{attempt ? ` ${attempt}` : ""}</span>}
      </span>
    );
  }

  // Online + outbox has pending writes.
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full bg-amber-50 text-amber-700 border border-amber-200 ${compact ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-0.5 text-xs"}`}
      title={`${outboxDepth} change${outboxDepth === 1 ? "" : "s"} waiting to sync`}
    >
      {outboxDepth > 5 ? (
        <CloudOff className={compact ? "w-3 h-3" : "w-3.5 h-3.5"} />
      ) : (
        <CloudUpload className={compact ? "w-3 h-3" : "w-3.5 h-3.5"} />
      )}
      <span className="font-semibold tabular-nums">{outboxDepth}</span>
      {!compact && <span>pending</span>}
    </span>
  );
}
