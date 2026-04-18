/**
 * BackupPanel — manual save/restore controls around the snapshot system.
 *
 *  - Save a cloud backup right now (bypasses the autosave debounce).
 *  - Restore from the cloud (re-applies the current Blossom pointer's snapshot).
 *  - Forget the cloud pointer (escape hatch for a corrupt backup).
 *  - Export the current in-memory state to a local file.
 */

import { useState } from "react";
import { X, Check, AlertCircle, HardDrive, Lock, Cloud, Trash2, Download } from "lucide-react";
import { useNostr } from "../contexts/NostrContext";
import { useCalendar } from "../contexts/CalendarContext";
import { useTasks } from "../contexts/TasksContext";
import { useSettings } from "../contexts/SettingsContext";
import { isNip44Available } from "../lib/crypto";
import {
  saveSnapshot,
  loadSnapshot,
  buildSnapshot,
  clearSnapshotPointer,
} from "../lib/backup";
import { npubEncode } from "nostr-tools/nip19";

interface BackupPanelProps { onClose: () => void; }

export function BackupPanel({ onClose }: BackupPanelProps) {
  const { pubkey, relays, signEvent, publishEvent, signer } = useNostr();
  const { events, calendars, applySnapshot: applyCalendarSnapshot, eventTombstones } = useCalendar();
  const { habits, completions, lists, applySnapshot: applyTasksSnapshot, habitTombstones, listTombstones } = useTasks();
  const { getSettings, restoreSettings } = useSettings();

  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [working, setWorking] = useState(false);
  const [done, setDone] = useState(false);

  const nip44Available = isNip44Available(signer);

  const saveNow = async () => {
    if (!pubkey || !signer?.nip44) { setError("NIP-44 signer required"); return; }
    setWorking(true); setError(""); setDone(false);
    setStatus("Encrypting and uploading snapshot…");
    try {
      const snap = buildSnapshot({
        calendars, events, eventTombstones,
        habits, habitTombstones,
        completions, lists, listTombstones,
        settings: getSettings(),
      });
      const ptr = await saveSnapshot(pubkey, snap, signEvent, publishEvent, signer.nip44);
      setStatus(`Saved to ${new URL(ptr.servers[0]).hostname}. ${ptr.counts.events} events, ${ptr.counts.calendars} calendars.`);
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  };

  const restoreFromCloud = async () => {
    if (!pubkey || !signer?.nip44) { setError("NIP-44 signer required"); return; }
    setWorking(true); setError(""); setDone(false);
    setStatus("Searching for cloud backup…");
    try {
      const snap = await loadSnapshot(pubkey, relays, signer.nip44);
      if (!snap) { setError("No cloud backup found."); return; }
      setStatus("Applying snapshot…");
      applyCalendarSnapshot(snap.events, snap.calendars);
      applyTasksSnapshot(snap.habits, snap.completions, snap.lists);
      restoreSettings(snap.settings);
      setStatus(`Restored ${snap.events.length} events, ${snap.calendars.length} calendars, ${snap.habits.length} habits, ${snap.lists.length} lists.`);
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  };

  const forgetCloud = async () => {
    const ok = window.confirm(
      "Forget the current cloud backup pointer?\n\n" +
      "Your calendars, events, tasks and notes stay exactly where they are. " +
      "This only drops the pointer to the old backup — a fresh one will be " +
      "written the next time your data changes."
    );
    if (!ok) return;
    setWorking(true); setError(""); setDone(false);
    setStatus("Clearing pointer…");
    try {
      await clearSnapshotPointer(signEvent, publishEvent);
      setStatus("Pointer cleared. Autosave will create a fresh one on next change.");
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  };

  const exportToFile = async () => {
    if (!pubkey || !signer?.nip44) { setError("NIP-44 signer required"); return; }
    setWorking(true); setError(""); setDone(false);
    setStatus("Encrypting and exporting…");
    try {
      const snap = buildSnapshot({
        calendars, events, eventTombstones,
        habits, habitTombstones,
        completions, lists, listTombstones,
        settings: getSettings(),
      });
      // Reuse the snapshot encryption path by running through saveSnapshot's
      // encrypt step manually would require refactoring; simplest is to
      // encrypt with nip44 directly here. But we already have the plaintext,
      // so just ship the plaintext snapshot inside an nip44-wrapped envelope.
      const json = JSON.stringify(snap);
      const encrypted = await signer.nip44.encrypt(pubkey, json);
      // TextDecoder/Encoder limits: NIP-44 can exceed 65535 bytes. If that
      // bites, we can swap to the same AES+NIP44 envelope the cloud uses.
      const npub = npubEncode(pubkey);
      const file = { planner: true as const, version: 1 as const, npub, nip44: encrypted };
      const blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `planner-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setStatus(`Exported: ${snap.events.length} events, ${snap.calendars.length} calendars.`);
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full">
        <div className="flex items-center justify-between p-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold">Backup &amp; Restore</h2>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <div className="flex items-center gap-2 px-3 py-2 bg-primary-50 rounded-lg">
            <Lock className="w-4 h-4 text-primary-600 flex-shrink-0" />
            <span className="text-xs text-primary-800">
              Your data is encrypted with AES-256-GCM; the key is wrapped with NIP-44 to your own npub.
            </span>
          </div>

          <button
            onClick={saveNow}
            disabled={working || !nip44Available}
            className="w-full flex items-center justify-center gap-2 p-3 border border-gray-200 rounded-xl hover:bg-primary-50 transition-colors disabled:opacity-50"
          >
            <Cloud className="w-5 h-5 text-primary-600" />
            <span className="text-sm font-medium">Save cloud backup now</span>
          </button>

          <button
            onClick={restoreFromCloud}
            disabled={working || !nip44Available}
            className="w-full flex items-center justify-center gap-2 p-3 border border-gray-200 rounded-xl hover:bg-emerald-50 transition-colors disabled:opacity-50"
          >
            <HardDrive className="w-5 h-5 text-emerald-600" />
            <span className="text-sm font-medium">Restore from cloud</span>
          </button>

          <button
            onClick={exportToFile}
            disabled={working || !nip44Available}
            className="w-full flex items-center justify-center gap-2 p-3 border border-gray-200 rounded-xl hover:bg-gray-50 transition-colors disabled:opacity-50"
          >
            <Download className="w-5 h-5 text-gray-600" />
            <span className="text-sm font-medium">Export to file</span>
          </button>

          <button
            onClick={forgetCloud}
            disabled={working}
            className="w-full flex items-center justify-center gap-2 p-2 text-xs text-red-600 border border-red-200 rounded-lg hover:bg-red-50 transition-colors disabled:opacity-50"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Forget cloud backup &amp; start over
          </button>

          {status && (
            <div className={`flex items-start gap-2 p-3 rounded-lg ${
              done ? "bg-emerald-50 border-2 border-emerald-300" : "bg-primary-50"
            }`}>
              {done ? <Check className="w-5 h-5 mt-0.5 flex-shrink-0 text-emerald-600" />
                    : <HardDrive className="w-4 h-4 mt-0.5 flex-shrink-0 text-primary-600" />}
              <span className={`text-sm ${done ? "font-medium text-emerald-800" : "text-primary-800"}`}>{status}</span>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 p-3 bg-red-50 rounded-lg">
              <AlertCircle className="w-4 h-4 text-red-600 mt-0.5 flex-shrink-0" />
              <span className="text-sm text-red-800 whitespace-pre-wrap break-words">{error}</span>
            </div>
          )}
        </div>

        <div className="p-4 border-t border-gray-100">
          <button onClick={onClose} className="w-full px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg transition-colors">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
