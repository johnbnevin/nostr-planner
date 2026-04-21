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
import { saveSnapshot, buildSnapshot, SnapshotShrinkError, loadSnapshot, type Snapshot, type SnapshotShrinkKind } from "../lib/backup";
import { logger } from "../lib/logger";
import { lsSet } from "../lib/storage";

const log = logger("auto-backup");

// 10 s: long enough to coalesce a burst of edits (typing a title,
// picking tags, toggling habit checkboxes) into one upload, short
// enough that cross-device propagation still feels prompt. Tuned up
// from 3 s once Blossom deletePreviousBlob landed — every save also
// burns a DELETE round-trip, so fewer saves is cheaper.
const DEBOUNCE_MS = 10_000;
const RETRY_AFTER_FAILURE_MS = 30_000;
const LAST_BACKUP_KEY = "nostr-planner-last-autobackup";

export type BackupPhase = "idle" | "dirty" | "saving" | "error" | "blocked";

export interface BlockedDetails {
  kind: SnapshotShrinkKind;
  remote: { events: number; calendars: number; habits: number; lists: number };
  working: { events: number; calendars: number; habits: number; lists: number };
}

/** localStorage key storing the JSON array of the two prior-generation
 *  shas (oldest first) so cross-session pruning works. Scoped per pubkey
 *  so a second account on the same device doesn't read the wrong list. */
const priorShasKey = (pubkey: string) => `nostr-planner-prior-shas-${pubkey}`;

function readPriorShas(pubkey: string): string[] {
  try {
    const raw = localStorage.getItem(priorShasKey(pubkey));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === "string" && /^[0-9a-f]{64}$/.test(s)).slice(-2);
  } catch { return []; }
}
function writePriorShas(pubkey: string, shas: string[]): void {
  try { lsSet(priorShasKey(pubkey), JSON.stringify(shas.slice(-2))); }
  catch { /* ignore quota errors etc. */ }
}

export function useAutoBackup(): {
  phase: BackupPhase;
  /** Seconds until the next save fires (debounced or retry). Null when idle/saving. */
  countdown: number | null;
  /** Human-readable text of the most recent failure. */
  lastError: string | null;
  /** Force a save right now, bypassing the debounce. */
  backupNow: () => Promise<void>;
  /** Details of a blocked save (from the shrink-guard). Null unless phase === "blocked". */
  blockedDetails: BlockedDetails | null;
  /** User-chosen: proceed with the blocked save. Consumes a one-shot bypass flag. */
  proceedAnyway: () => Promise<void>;
  /** User-chosen: throw away local edits, reload the remote snapshot as current. */
  discardLocalChanges: () => Promise<void>;
} {
  const { pubkey, relays, signEvent, publishEvent, signer } = useNostr();
  const {
    events, calendars, eventsLoading, lastRemoteSha, setLastRemoteSha, eventTombstones,
    applySnapshot: applyCalendarSnapshot,
  } = useCalendar();
  const {
    habits, completions, lists, loading: tasksLoading, habitTombstones, listTombstones,
    applySnapshot: applyTasksSnapshot,
  } = useTasks();
  const { getSettings, autoBackup, restoreSettings } = useSettings();

  const [phase, setPhase] = useState<BackupPhase>("idle");
  const [lastError, setLastError] = useState<string | null>(null);
  const [saveDueAt, setSaveDueAt] = useState<number | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [blockedDetails, setBlockedDetails] = useState<BlockedDetails | null>(null);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backingUpRef = useRef(false);
  // A change that arrived while a save was already in flight. When the
  // in-flight save finishes we fire one more save so the later change
  // doesn't get silently dropped.
  const pendingRef = useRef(false);
  const fingerprint = useRef("");
  const initialLoadDone = useRef(false);
  // Two most recent prior-generation blob shas, oldest first. Retention
  // policy is N + N-1 + N-2; every save prunes the N-3 blob (= the
  // oldest entry in this array before we shift in a new one). Persisted
  // in localStorage so cross-session pruning works — without that,
  // every session leaked one blob on every server. The N-2 at index 0
  // is what gets passed into saveSnapshot as `shaToDelete`.
  const priorShasRef = useRef<string[]>([]);
  // One-shot bypass flag for the shrink-guard. Set by proceedAnyway(),
  // consumed on the next doBackup() call, then reset to false.
  const allowShrinkRef = useRef(false);
  // Seed priorShas from localStorage when the pubkey settles, so
  // pruning resumes where the last session left off.
  useEffect(() => {
    if (!pubkey) { priorShasRef.current = []; return; }
    priorShasRef.current = readPriorShas(pubkey);
  }, [pubkey]);

  // Stable refs so the stable-identity doBackup always sees latest state.
  const stateRef = useRef({
    pubkey, relays, signEvent, publishEvent, signer,
    getSettings, autoBackup, lastRemoteSha, setLastRemoteSha,
    events, calendars, habits, completions, lists,
    eventTombstones, habitTombstones, listTombstones,
  });
  stateRef.current = {
    pubkey, relays, signEvent, publishEvent, signer,
    getSettings, autoBackup, lastRemoteSha, setLastRemoteSha,
    events, calendars, habits, completions, lists,
    eventTombstones, habitTombstones, listTombstones,
  };

  // FNV-1a 32-bit string mixer. Cheap and distributes well enough that
  // same-length string edits (typo fixes, title tweaks) change the fingerprint.
  // The previous version hashed only string *lengths* which silently missed
  // many edits and caused autosaves to never fire.
  const hashStr = (s: string, h: number): number => {
    for (let i = 0; i < s.length; i++) {
      h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    }
    return h | 0;
  };

  const computeFingerprint = (): string => {
    const { events, calendars, habits, completions, lists, getSettings } = stateRef.current;
    let eh = events.length;
    for (const e of events) {
      eh = (eh * 31 + e.start.getTime()) | 0;
      eh = (eh * 31 + (e.end?.getTime() ?? 0)) | 0;
      eh = (eh * 31 + e.createdAt) | 0;
      eh = (eh * 31 + (e.updatedAt ?? 0)) | 0;
      eh = hashStr(e.title, eh);
      eh = hashStr(e.content, eh);
      eh = hashStr(e.location ?? "", eh);
      eh = hashStr(e.link ?? "", eh);
      eh = hashStr(e.hashtags.join(","), eh);
      eh = hashStr(e.calendarRefs.join(","), eh);
      eh = (eh * 31 + (e.notify === false ? 0 : 1)) | 0;
      eh = (eh * 31 + (e.deleted ? 1 : 0)) | 0;
    }
    let ch = calendars.length;
    for (const c of calendars) {
      ch = (ch * 31 + c.eventRefs.length) | 0;
      ch = hashStr(c.title, ch);
      ch = hashStr(c.color ?? "", ch);
    }
    let hh = habits.length;
    for (const h of habits) {
      hh = hashStr(h.id, hh);
      hh = hashStr(h.title, hh);
      hh = (hh * 31 + (h.updatedAt ?? 0)) | 0;
      hh = (hh * 31 + (h.deleted ? 1 : 0)) | 0;
    }
    let cc = 0;
    for (const k in completions) {
      cc = hashStr(k, cc);
      cc = hashStr(completions[k].join(","), cc);
    }
    let lh = lists.length;
    for (const l of lists) {
      lh = hashStr(l.id, lh);
      lh = hashStr(l.name, lh);
      lh = (lh * 31 + (l.updatedAt ?? 0)) | 0;
      lh = (lh * 31 + (l.deleted ? 1 : 0)) | 0;
      lh = (lh * 31 + l.items.length) | 0;
      for (const i of l.items) {
        lh = hashStr(i.id, lh);
        lh = hashStr(i.title, lh);
        lh = (lh * 31 + (i.done ? 1 : 0)) | 0;
      }
    }
    return `${eh}|${ch}|${hh}|${cc}|${lh}|${JSON.stringify(getSettings())}`;
  };

  const scheduleSave = (delayMs: number) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setSaveDueAt(Date.now() + delayMs);
    timerRef.current = setTimeout(() => { void doBackup(); }, delayMs);
  };

  const doBackup = useCallback(async () => {
    const s = stateRef.current;
    if (!s.pubkey || !s.signer?.nip44) return;
    if (backingUpRef.current) {
      // Another save is already uploading. Remember that something new
      // needs to go out and bail; we'll fire one more save when the
      // in-flight one finishes. Previously this branch silently returned
      // and the edit was lost until the next fingerprint change.
      pendingRef.current = true;
      return;
    }
    backingUpRef.current = true;
    setPhase("saving");
    setSaveDueAt(null);
    try {
      const snapshot = buildSnapshot({
        calendars: s.calendars,
        events: s.events,
        eventTombstones: s.eventTombstones,
        habits: s.habits,
        habitTombstones: s.habitTombstones,
        completions: s.completions,
        lists: s.lists,
        listTombstones: s.listTombstones,
        settings: s.getSettings(),
      });
      const allowShrink = allowShrinkRef.current;
      allowShrinkRef.current = false; // consume one-shot
      // Oldest of the two prior generations = N-2, which becomes N-3
      // once the new save lands. That's what we prune on success.
      const shaToDelete = priorShasRef.current[0];
      const ptr = await saveSnapshot(
        s.pubkey, snapshot, s.signEvent, s.publishEvent, s.signer.nip44,
        s.relays, s.lastRemoteSha ?? undefined,
        shaToDelete,
        allowShrink,
      );
      // Shift generations. Old state → [N-2, N-1]; new state → [N-1, N].
      // Specifically: drop the now-pruned N-3 (priorShasRef[0]) and
      // append what was "current" before this save (lastRemoteSha), then
      // setLastRemoteSha to the freshly-published sha. Cap at length 2.
      if (s.lastRemoteSha) {
        priorShasRef.current = [...priorShasRef.current.slice(1), s.lastRemoteSha].slice(-2);
      }
      if (s.pubkey) writePriorShas(s.pubkey, priorShasRef.current);
      s.setLastRemoteSha(ptr.sha256);
      lsSet(LAST_BACKUP_KEY, new Date().toISOString());
      setLastError(null);
      setBlockedDetails(null);
      setPhase("idle");
    } catch (err) {
      if (err instanceof SnapshotShrinkError) {
        // Save stopped at the shrink-guard. Surface the comparison to
        // the user via the ShrinkGuardModal (phase="blocked") and do
        // NOT schedule a retry — we'd just hit the guard again in 30 s.
        // Fingerprint-change path also won't re-schedule while blocked.
        log.warn(`save blocked by shrink-guard (${err.kind})`);
        const summarize = (s: Snapshot) => ({
          events: s.events.filter((e) => !e.deleted).length,
          calendars: s.calendars.length,
          habits: s.habits.filter((h) => !h.deleted).length,
          lists: s.lists.filter((l) => !l.deleted).length,
        });
        setBlockedDetails({
          kind: err.kind,
          remote: summarize(err.remote),
          working: summarize(err.working),
        });
        setLastError(null);
        setPhase("blocked");
        setSaveDueAt(null);
        if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        log.error("save failed:", msg);
        setLastError(msg);
        setPhase("error");
        scheduleSave(RETRY_AFTER_FAILURE_MS);
      }
    } finally {
      backingUpRef.current = false;
      if (pendingRef.current) {
        pendingRef.current = false;
        void doBackup();
      }
    }
  }, []);

  /** User pressed "Save anyway" in the ShrinkGuardModal. Sets the
   *  one-shot bypass flag and re-fires doBackup immediately. */
  const proceedAnyway = useCallback(async () => {
    allowShrinkRef.current = true;
    setPhase("saving");
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    setSaveDueAt(null);
    await doBackup();
  }, [doBackup]);

  /** User pressed "Restore what's on the cloud" — throw away the local
   *  state that tripped the guard and re-apply whatever the remote has.
   *  Bypasses the shrink-guard naturally (loaded state == remote, so
   *  no shrink vs remote on the subsequent save). */
  const discardLocalChanges = useCallback(async () => {
    const s = stateRef.current;
    if (!s.pubkey || !s.signer?.nip44) return;
    try {
      const remote = await loadSnapshot(s.pubkey, s.relays, s.signer.nip44);
      if (!remote) {
        setLastError("No remote snapshot to restore from.");
        return;
      }
      applyCalendarSnapshot(remote.events, remote.calendars);
      applyTasksSnapshot(remote.habits, remote.completions, remote.lists);
      restoreSettings(remote.settings);
      s.setLastRemoteSha(remote._sha256);
      // Reset fingerprint to the restored state so the change-detection
      // effect doesn't immediately interpret the apply as a "dirty" edit.
      fingerprint.current = computeFingerprint();
      setBlockedDetails(null);
      setLastError(null);
      setPhase("idle");
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
      setSaveDueAt(null);
    } catch (err) {
      setLastError(err instanceof Error ? err.message : String(err));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stable setters
  }, [applyCalendarSnapshot, applyTasksSnapshot, restoreSettings]);

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
    // While blocked by the shrink-guard, fingerprint changes don't
    // schedule a new save — they'd just hit the guard again. The
    // user has to resolve via the modal (Save anyway / Restore /
    // Keep current) before autosave resumes. But clearing phase
    // here if the state has grown back past the shrink threshold
    // is a nice UX: fingerprint updates mean the user is editing;
    // if they undo whatever shrunk the state, we drop out of
    // blocked. Simplest: drop blocked on any fingerprint change —
    // the next save attempt will either succeed (no longer shrunk)
    // or re-trigger the block.
    if (phase === "blocked") {
      setBlockedDetails(null);
      setPhase("dirty");
    } else {
      setLastError(null);
      setPhase((prev) => (prev === "saving" ? prev : "dirty"));
    }
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

  return {
    phase,
    countdown,
    lastError,
    backupNow: doBackup,
    blockedDetails,
    proceedAnyway,
    discardLocalChanges,
  };
}

export function getLastAutoBackupTime(): string | null {
  return localStorage.getItem(LAST_BACKUP_KEY);
}
