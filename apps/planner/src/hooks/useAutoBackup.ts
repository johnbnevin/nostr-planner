/**
 * useAutoBackup — automatic Blossom backup triggered by data changes.
 *
 * Trigger conditions:
 *   1. Auto-backup must be enabled in user settings (`autoBackup` flag).
 *   2. Initial data load must be complete (events, calendars, tasks all loaded).
 *   3. A data fingerprint (derived from events, calendars, habits, completions,
 *      lists, and settings) must differ from the last-seen fingerprint.
 *
 * When triggered, the hook debounces for 5 seconds of inactivity before
 * performing a full Blossom backup via `performFullBackup`. If a change is
 * still pending when the page unloads, a best-effort backup is fired.
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

const DEBOUNCE_MS = 5_000; // 5s after last change
const LAST_BACKUP_KEY = "nostr-planner-last-autobackup";
export function useAutoBackup(): { backingUp: boolean; backupNow: () => Promise<void> } {
  const { pubkey, relays, signEvent, publishEvent, signer } = useNostr();
  const { events, calendars, eventsLoading } = useCalendar();
  const { habits, completions, lists, loading: tasksLoading } = useTasks();
  const { getSettings, autoBackup } = useSettings();
  const settings = getSettings();

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Guard against concurrent backup runs */
  const backingUpRef = useRef(false);
  const [backingUp, setBackingUp] = useState(false);
  /** Serialized snapshot of all user data; compared to detect changes */
  const fingerprint = useRef("");
  /** Prevents a backup on the very first render (data load is not a "change") */
  const initialLoadDone = useRef(false);
  /** True when a change has been detected but backup hasn't run yet */
  const dirtyRef = useRef(false);

  // Stable ref to latest backup args so beforeunload can use them
  const argsRef = useRef({ pubkey, relays, signEvent, publishEvent, getSettings, autoBackup, signer });
  argsRef.current = { pubkey, relays, signEvent, publishEvent, getSettings, autoBackup, signer };

  // Build a cheap fingerprint of all data to detect any change.
  // Uses counts + lengths + key fields instead of serializing entire datasets,
  // which avoids building huge strings on every render for users with many events.
  const currentFingerprint = useCallback(() => {
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
    const settingsPart = JSON.stringify(settings);
    return `${hash}|${calHash}|${habitHash}|${completionKeys}:${completionCount}|${listHash}|${settingsPart}`;
  }, [events, calendars, habits, completions, lists, settings]);

  // Keep a ref to the latest decrypted calendar state so doBackup always
  // snapshots what the user is looking at right now — the materialized
  // payload is what makes cold-start Blossom loads instant.
  const materializedRef = useRef<{ events: typeof events; calendars: typeof calendars }>({ events, calendars });
  materializedRef.current = { events, calendars };

  const doBackup = useCallback(async () => {
    const { pubkey: pk, relays: r, signEvent: se, publishEvent: pe, getSettings: gs, signer: s } = argsRef.current;
    if (backingUpRef.current || !pk) return;
    backingUpRef.current = true;
    setBackingUp(true);
    try {
      await performFullBackup(pk, r, gs(), se, pe, s?.nip44, materializedRef.current);
      // Only clear the dirty flag and record the timestamp on success.
      // On failure, dirtyRef stays true so a retry fires if data changes again.
      dirtyRef.current = false;
      lsSet(LAST_BACKUP_KEY, new Date().toISOString());
    } catch (err) {
      log.error("backup failed", err);
    } finally {
      backingUpRef.current = false;
      setBackingUp(false);
    }
  }, []);

  useEffect(() => {
    if (!pubkey || !autoBackup || eventsLoading || tasksLoading) return;

    // Skip the very first load — don't backup just because we loaded data
    if (!initialLoadDone.current) {
      initialLoadDone.current = true;
      fingerprint.current = currentFingerprint();
      return;
    }

    const newFp = currentFingerprint();
    if (newFp === fingerprint.current) return;
    fingerprint.current = newFp;
    dirtyRef.current = true;

    // Debounce
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(doBackup, DEBOUNCE_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  // currentFingerprint already closes over events/calendars/habits/completions/lists/settings,
  // so adding them again here would be redundant and cause excessive re-runs.
  }, [pubkey, autoBackup, eventsLoading, tasksLoading, currentFingerprint, doBackup]);

  // Flush pending backup on page unload.
  // NOTE: This is best-effort only. `beforeunload` is synchronous — the browser
  // will not wait for the async `doBackup()` promise to resolve. The periodic
  // debounced backup (5s after last change) is the real safety net; this handler
  // just catches the narrow window between a change and the debounce firing.
  useEffect(() => {
    const handleUnload = () => {
      if (!dirtyRef.current || !argsRef.current.pubkey || !argsRef.current.autoBackup) return;
      doBackup();
    };
    window.addEventListener("beforeunload", handleUnload);
    return () => window.removeEventListener("beforeunload", handleUnload);
  }, [doBackup]);

  return { backingUp, backupNow: doBackup };
}

export function getLastAutoBackupTime(): string | null {
  return localStorage.getItem(LAST_BACKUP_KEY);
}
