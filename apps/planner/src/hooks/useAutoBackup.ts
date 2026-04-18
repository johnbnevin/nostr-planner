/**
 * useAutoBackup — debounced Blossom snapshot saves.
 *
 * Lifecycle:
 *   idle (green cloud)
 *     ↓ data changes
 *   dirty + countdown (red cloud + corner countdown "15→0")
 *     ↓ countdown hits 0
 *   saving (red spinner)
 *     ├─ success → idle
 *     └─ failure → error (red CloudAlert + retry countdown 30s)
 *          ↓ countdown hits 0 → saving again …
 *
 * The debounce timer lives in a ref and is deliberately NOT cleared on
 * every render — the previous design wiped it whenever any dependency
 * shifted, which silently stalled autosaves forever.
 */

import { useEffect, useRef, useCallback, useState } from "react";
import { useNostr } from "../contexts/NostrContext";
import { useCalendar } from "../contexts/CalendarContext";
import { useSettings } from "../contexts/SettingsContext";
import { useTasks } from "../contexts/TasksContext";
import { saveSnapshot, buildSnapshot } from "../lib/backup";
import { logger } from "../lib/logger";
import { lsSet } from "../lib/storage";

const log = logger("auto-backup");

// 3 s: short enough that cross-device propagation feels instant, long
// enough to coalesce bursts of typing / tag-picking / checkbox toggles
// into a single upload. Was 15 s back when the encrypt step was slow;
// the current AES-GCM + NIP-44 path is ~100 ms on a phone so there's no
// benefit to waiting longer.
const DEBOUNCE_MS = 3_000;
const RETRY_AFTER_FAILURE_MS = 30_000;
const LAST_BACKUP_KEY = "nostr-planner-last-autobackup";

export type BackupPhase = "idle" | "dirty" | "saving" | "error";

export function useAutoBackup(): {
  phase: BackupPhase;
  /** Seconds until the next save fires (debounced or retry). Null when idle/saving. */
  countdown: number | null;
  /** Human-readable text of the most recent failure. */
  lastError: string | null;
  /** Force a save right now, bypassing the debounce. */
  backupNow: () => Promise<void>;
} {
  const { pubkey, relays, signEvent, publishEvent, signer } = useNostr();
  const { events, calendars, eventsLoading, lastRemoteSha, setLastRemoteSha } = useCalendar();
  const { habits, completions, lists, loading: tasksLoading } = useTasks();
  const { getSettings, autoBackup } = useSettings();

  const [phase, setPhase] = useState<BackupPhase>("idle");
  const [lastError, setLastError] = useState<string | null>(null);
  const [saveDueAt, setSaveDueAt] = useState<number | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backingUpRef = useRef(false);
  const fingerprint = useRef("");
  const initialLoadDone = useRef(false);

  // Stable refs so the stable-identity doBackup always sees latest state.
  const stateRef = useRef({
    pubkey, relays, signEvent, publishEvent, signer,
    getSettings, autoBackup, lastRemoteSha, setLastRemoteSha,
    events, calendars, habits, completions, lists,
  });
  stateRef.current = {
    pubkey, relays, signEvent, publishEvent, signer,
    getSettings, autoBackup, lastRemoteSha, setLastRemoteSha,
    events, calendars, habits, completions, lists,
  };

  const computeFingerprint = (): string => {
    const { events, calendars, habits, completions, lists, getSettings } = stateRef.current;
    let eh = events.length;
    for (const e of events) {
      eh = (eh * 31 + e.start.getTime()) | 0;
      eh = (eh * 31 + (e.end?.getTime() ?? 0)) | 0;
      eh = (eh * 31 + e.createdAt) | 0;
      eh = (eh * 31 + e.content.length) | 0;
      eh = (eh * 31 + e.title.length) | 0;
    }
    let ch = calendars.length;
    for (const c of calendars) {
      ch = (ch * 31 + c.eventRefs.length) | 0;
      ch = (ch * 31 + c.title.length) | 0;
    }
    const hh = habits.length;
    const ck = Object.keys(completions).length;
    let cc = 0;
    for (const k in completions) cc += completions[k].length;
    let lh = lists.length;
    for (const l of lists) {
      lh = (lh * 31 + l.items.length) | 0;
      for (const i of l.items) lh = (lh * 31 + (i.done ? 1 : 0)) | 0;
    }
    return `${eh}|${ch}|${hh}|${ck}:${cc}|${lh}|${JSON.stringify(getSettings())}`;
  };

  const scheduleSave = (delayMs: number) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setSaveDueAt(Date.now() + delayMs);
    timerRef.current = setTimeout(() => { void doBackup(); }, delayMs);
  };

  const doBackup = useCallback(async () => {
    const s = stateRef.current;
    if (backingUpRef.current || !s.pubkey || !s.signer?.nip44) return;
    backingUpRef.current = true;
    setPhase("saving");
    setSaveDueAt(null);
    try {
      const snapshot = buildSnapshot({
        calendars: s.calendars,
        events: s.events,
        habits: s.habits,
        completions: s.completions,
        lists: s.lists,
        settings: s.getSettings(),
      });
      const ptr = await saveSnapshot(
        s.pubkey, snapshot, s.signEvent, s.publishEvent, s.signer.nip44,
        s.relays, s.lastRemoteSha ?? undefined
      );
      s.setLastRemoteSha(ptr.sha256);
      lsSet(LAST_BACKUP_KEY, new Date().toISOString());
      setLastError(null);
      setPhase("idle");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("save failed:", msg);
      setLastError(msg);
      setPhase("error");
      scheduleSave(RETRY_AFTER_FAILURE_MS);
    } finally {
      backingUpRef.current = false;
    }
  }, []);

  // Change detection — runs every render; cheap enough.
  // NO cleanup that clears the timer: that was the autosave-never-fires bug.
  useEffect(() => {
    if (!pubkey || !autoBackup || eventsLoading || tasksLoading) return;
    if (!initialLoadDone.current) {
      initialLoadDone.current = true;
      fingerprint.current = computeFingerprint();
      return;
    }
    const next = computeFingerprint();
    if (next === fingerprint.current) return;
    fingerprint.current = next;
    setLastError(null);
    setPhase((prev) => (prev === "saving" ? prev : "dirty"));
    scheduleSave(DEBOUNCE_MS);
  });

  // autoBackup toggled off → cancel pending.
  useEffect(() => {
    if (autoBackup) return;
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    setSaveDueAt(null);
    setPhase("idle");
    setLastError(null);
  }, [autoBackup]);

  // Unmount.
  useEffect(() => () => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
  }, []);

  // Flush on unload (best-effort).
  useEffect(() => {
    const handleUnload = () => {
      if (phase !== "dirty" || !stateRef.current.pubkey || !stateRef.current.autoBackup) return;
      void doBackup();
    };
    window.addEventListener("beforeunload", handleUnload);
    return () => window.removeEventListener("beforeunload", handleUnload);
  }, [phase, doBackup]);

  // Countdown ticker.
  useEffect(() => {
    if (saveDueAt === null) { setCountdown(null); return; }
    const tick = () => setCountdown(Math.max(0, Math.ceil((saveDueAt - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [saveDueAt]);

  return { phase, countdown, lastError, backupNow: doBackup };
}

export function getLastAutoBackupTime(): string | null {
  return localStorage.getItem(LAST_BACKUP_KEY);
}
