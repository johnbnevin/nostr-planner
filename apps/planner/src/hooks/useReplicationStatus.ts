/**
 * React hook over lib/replication.ts — subscribes to the latest
 * replication reports so UI can render "mirrored to N/M servers" hints.
 */
import { useEffect, useState } from "react";
import {
  getLastRelayReplication,
  getLastBlossomReplication,
  getPendingMirrorCounts,
  onReplicationChange,
  type ReplicationReport,
} from "../lib/replication";

export interface ReplicationSummary {
  lastRelay: ReplicationReport | null;
  lastBlossom: ReplicationReport | null;
  /** Pending mirrors awaiting retry. */
  pendingRelayMirrors: number;
  pendingBlossomMirrors: number;
}

export function useReplicationStatus(): ReplicationSummary {
  const [state, setState] = useState<ReplicationSummary>(() => {
    const counts = getPendingMirrorCounts();
    return {
      lastRelay: getLastRelayReplication(),
      lastBlossom: getLastBlossomReplication(),
      pendingRelayMirrors: counts.relays,
      pendingBlossomMirrors: counts.blossom,
    };
  });

  useEffect(() => {
    const off = onReplicationChange(() => {
      const counts = getPendingMirrorCounts();
      setState({
        lastRelay: getLastRelayReplication(),
        lastBlossom: getLastBlossomReplication(),
        pendingRelayMirrors: counts.relays,
        pendingBlossomMirrors: counts.blossom,
      });
    });
    // Periodic refresh so pending counts decay as retries complete.
    // The replication-change emitter doesn't fire on every retry success
    // (it would be noisy); 10s is fine for a status pill.
    const t = setInterval(() => {
      const counts = getPendingMirrorCounts();
      setState((prev) => {
        if (prev.pendingRelayMirrors === counts.relays && prev.pendingBlossomMirrors === counts.blossom) {
          return prev;
        }
        return { ...prev, pendingRelayMirrors: counts.relays, pendingBlossomMirrors: counts.blossom };
      });
    }, 10_000);
    return () => { off(); clearInterval(t); };
  }, []);

  return state;
}

/** Short single-line summary suitable for a tooltip. */
export function formatReplicationTooltip(s: ReplicationSummary): string {
  const parts: string[] = [];
  if (s.lastBlossom) {
    const ok = s.lastBlossom.mirrors.filter((m) => m.status === "ok").length;
    const total = s.lastBlossom.mirrors.length;
    parts.push(`Backup: ${s.lastBlossom.primary.replace(/^https?:\/\//, "").replace(/\/$/, "")} + ${ok}/${total} mirrors`);
  }
  if (s.lastRelay) {
    const ok = s.lastRelay.mirrors.filter((m) => m.status === "ok").length;
    const total = s.lastRelay.mirrors.length;
    parts.push(`Relays: primary + ${ok}/${total} mirrors`);
  }
  const pending = s.pendingRelayMirrors + s.pendingBlossomMirrors;
  if (pending > 0) parts.push(`${pending} mirror${pending === 1 ? "" : "s"} retrying`);
  return parts.join(" · ");
}
