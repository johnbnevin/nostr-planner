/**
 * useAutoBackup — automatic Blossom backup triggered by data changes.
 *
 * Lifecycle:
 *   idle (green cloud)
 *     ↓ user edits data
 *   dirty + countdown (red cloud with "15s → 0s" badge)
 *     ↓ countdown reaches 0
 *   saving (red spinner)
 *     ├─ success → idle
 *     └─ failure → error (red exclamation + retry countdown)
 *          ↓ retry countdown reaches 0
 *        saving
 *          └─ …
 *
 * The debounce timer lives in a ref and is deliberately NOT cleared by the
 * change-detection effect's cleanup — React re-running that effect on every
 * unrelated re-render was previously wiping the timer before it could fire,
 * which is why "cloud stays red but never saves" was happening.
 */

import { useEffect, useRef, useCallback, useState } from "react";
import { useNostr } from "../contexts/NostrContext";
import { useCalendar } from "../contexts/CalendarContext";
import { useSettings } from "../contexts/SettingsContext";
import { useTasks } from "../contexts/TasksContext";
import { performFullBackup } from "../lib/backup";
import { logger } from "../lib/logger";
import { lsSet } from "../lib/storage";

const log = logger("auto-backup");

/** 15s of no further changes before autosave fires. */
const DEBOUNCE_MS = 15_000;
/** After a failure, wait this long before auto-retrying. */
const RETRY_AFTER_FAILURE_MS = 30_000;
const LAST_BACKUP_KEY = "nostr-planner-last-autobackup";

export type BackupPhase = "idle" | "dirty" | "saving" | "error";

export function useAutoBackup(): {
  phase: BackupPhase;
  /** Seconds until the next autosave (either debounced or retry). Null when idle/saving. */
  countdown: number | null;
  /** Most recent failure message, for the error tooltip. */
  lastError: string | null;
  /** Trigger a save right now; bypasses the debounce but respects the single-flight guard. */
  backupNow: () => Promise<void>;
} {
  const { pubkey, relays, signEvent, publishEvent, signer } = useNostr();
  const { events, calendars, eventsLoading } = useCalendar();
  const { habits, completions, lists, loading: tasksLoading } = useTasks();
  const { getSettings, autoBackup } = useSettings();

  // ── State that drives the cloud icon ─────────────────────────────────
  const [phase, setPhase] = useState<BackupPhase>("idle");
  const [lastError, setLastError] = useState<string | null>(null);
  /** Unix ms when the pending save will fire. Null when not scheduled. */
  const [saveDueAt, setSaveDueAt] = useState<number | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);

  // ── Timers & single-flight tracking ──────────────────────────────────
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backingUpRef = useRef(false);
  const fingerprint = useRef("");
  const initialLoadDone = useRef(false);

  // ── Stable refs to the latest backup args (so doBackup's closure
  //    always sees fresh pubkey/signer/state even though doBackup itself
  //    is memoized with empty deps to keep its identity stable). ────────
  const argsRef = useRef({ pubkey, relays, signEvent, publishEvent, getSettings, autoBackup, signer });
  argsRef.current = { pubkey, relays, signEvent, publishEvent, getSettings, autoBackup, signer };

  const materializedRef = useRef<{ events: typeof events; calendars: typeof calendars }>({ events, calendars });
  materializedRef.current = { events, calendars };

  // ── Fingerprint: cheap hash of all user data so we can detect real
  //    changes vs. incidental re-renders. Kept deliberately non-memoed
  //    (plain function) to avoid identity-churn invalidating the change
  //    detection effect — the effect calls it inside its body. ──────────
  const computeFingerprint = (): string => {
    let hash = events.length;
    for (const e of events) {
      hash = (hash * 31 + e.start.getTime()) | 0;
      hash = (hash * 31 + (e.end?.getTime() ?? 0)) | 0;
      hash = (hash * 31 + e.createdAt) | 0;
      hash = (hash * 31 + e.content.length) | 0;
    }
    let calHash = calendars.length;
    for (const c of calendars) {
      calHash = (calHash * 31 + c.eventRefs.length) | 0;
      calHash = (calHash * 31 + c.title.length) | 0;
    }
    const habitHash = habits.length;
    const completionKeys = Object.keys(completions).length;
    let completionCount = 0;
    for (const k in completions) completionCount += completions[k].length;
    let listHash = lists.length;
    for (const l of lists) {
      listHash = (listHash * 31 + l.items.length) | 0;
      for (const i of l.items) listHash = (listHash * 31 + (i.done ? 1 : 0)) | 0;
    }
    const settingsPart = JSON.stringify(argsRef.current.getSettings());
    return `${hash}|${calHash}|${habitHash}|${completionKeys}:${completionCount}|${listHash}|${settingsPart}`;
  };

  const scheduleSave = (delayMs: number) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const due = Date.now() + delayMs;
    setSaveDueAt(due);
    timerRef.current = setTimeout(() => { void doBackup(); }, delayMs);
  };

  const doBackup = useCallback(async () => {
    const { pubkey: pk, relays: r, signEvent: se, publishEvent: pe, getSettings: gs, signer: s } = argsRef.current;
    if (backingUpRef.current || !pk) return;
    backingUpRef.current = true;
    setPhase("saving");
    setSaveDueAt(null);
    try {
      await performFullBackup(pk, r, gs(), se, pe, s?.nip44, materializedRef.current);
      lsSet(LAST_BACKUP_KEY, new Date().toISOString());
      setLastError(null);
      setPhase("idle");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("backup failed:", msg);
      setLastError(msg);
      setPhase("error");
      scheduleSave(RETRY_AFTER_FAILURE_MS);
    } finally {
      backingUpRef.current = false;
    }
  }, []);

  // ── Change detection ─────────────────────────────────────────────────
  // Runs on every render; cheap enough because computeFingerprint is O(n).
  // Critically: DOES NOT return a cleanup that clears the timer — that was
  // the bug that stalled autosaves forever across unrelated re-renders.
  useEffect(() => {
    if (!pubkey || !autoBackup || eventsLoading || tasksLoading) return;

    if (!initialLoadDone.current) {
      initialLoadDone.current = true;
      fingerprint.current = computeFingerprint();
      return;
    }

    const newFp = computeFingerprint();
    if (newFp === fingerprint.current) return;
    fingerprint.current = newFp;

    // Real change → enter dirty state and arm the debounce timer.
    setLastError(null);
    setPhase((prev) => (prev === "saving" ? prev : "dirty"));
    scheduleSave(DEBOUNCE_MS);
  });

  // ── autoBackup toggled off: cancel any pending save. ─────────────────
  useEffect(() => {
    if (autoBackup) return;
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    setSaveDueAt(null);
    setPhase("idle");
    setLastError(null);
  }, [autoBackup]);

  // ── Logout cleanup. ──────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    };
  }, []);

  // ── Flush on unload (best-effort — browser won't wait for async). ────
  useEffect(() => {
    const handleUnload = () => {
      if (phase !== "dirty" || !argsRef.current.pubkey || !argsRef.current.autoBackup) return;
      void doBackup();
    };
    window.addEventListener("beforeunload", handleUnload);
    return () => window.removeEventListener("beforeunload", handleUnload);
  }, [phase, doBackup]);

  // ── Countdown ticker. Runs while a save is scheduled. ────────────────
  useEffect(() => {
    if (saveDueAt === null) { setCountdown(null); return; }
    const tick = () => {
      const remainingMs = saveDueAt - Date.now();
      setCountdown(Math.max(0, Math.ceil(remainingMs / 1000)));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [saveDueAt]);

  return { phase, countdown, lastError, backupNow: doBackup };
}

export function getLastAutoBackupTime(): string | null {
  return localStorage.getItem(LAST_BACKUP_KEY);
}
