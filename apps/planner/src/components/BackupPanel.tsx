import { useState, useRef } from "react";
import { X, Download, Check, AlertCircle, HardDrive, Upload, Lock, Cloud, Calendar, List, Layers, ChevronLeft, Trash2 } from "lucide-react";
import { useNostr } from "../contexts/NostrContext";
import { useCalendar } from "../contexts/CalendarContext";
import { useTasks } from "../contexts/TasksContext";
import { useSettings } from "../contexts/SettingsContext";
import { isNip44Available } from "../lib/crypto";
import {
  republishEvents,
  buildBackupBlob,
  summarizeCounts,
  findBackupRefs,
  downloadBackup,
  clearBackupRef,
  encryptBackupEnvelope,
  decryptBackupEnvelope,
} from "../lib/backup";
import type { RawEvent, BackupEntry, BackupEnvelopeV3 } from "../lib/backup";
import { npubEncode } from "nostr-tools/nip19";

/**
 * Current encrypted-backup-file format (version 3). Wraps a
 * {@link BackupEnvelopeV3} (AES-256-GCM + NIP-44 hybrid) plus an npub binding
 * so a user can tell a downloaded file is theirs before attempting decrypt.
 */
interface EncryptedBackupFileV3 {
  planner: true;
  version: 3;
  npub: string;
  envelope: BackupEnvelopeV3;
}

/**
 * Legacy encrypted-backup-file format (version 2). Direct NIP-44 encrypt of
 * the whole backup JSON — broke silently for backups over ~60KB. Read-only
 * support retained so old files can still be restored.
 */
interface EncryptedBackupFileV2 {
  planner: true;
  version: 2;
  npub: string;
  encrypted: true;
  data: string;
}

interface PlaintextBackupFile {
  version: number;
  events: RawEvent[];
  preferences?: Record<string, unknown>;
}

type BackupFile = EncryptedBackupFileV3 | EncryptedBackupFileV2 | PlaintextBackupFile;

interface BackupPanelProps {
  onClose: () => void;
}

export function BackupPanel({ onClose }: BackupPanelProps) {
  const { pubkey, relays, signEvent, publishEvent, signer } = useNostr();
  const { forceFullRefresh } = useCalendar();
  const { refreshTasks } = useTasks();
  const { getSettings, restoreSettings } = useSettings();
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [working, setWorking] = useState(false);
  const [done, setDone] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Blossom restore state
  const [blossomView, setBlossomView] = useState(false);
  const [blossomEntries, setBlossomEntries] = useState<BackupEntry[]>([]);
  const [blossomLoading, setBlossomLoading] = useState(false);

  const nip44 = isNip44Available(signer);

  const handleDownloadFile = async () => {
    if (!pubkey) {
      setError("Not logged in");
      return;
    }

    if (!nip44) {
      setError("NIP-44 encryption is required to save backup files. Please use a Nostr extension that supports NIP-44 (e.g. nos2x, Alby).");
      return;
    }

    setWorking(true);
    setError("");
    setDone(false);
    setStatus("Fetching all data from relays...");

    try {
      const result = await buildBackupBlob(pubkey, relays, getSettings());

      if (!result) {
        setError("No events to back up");
        return;
      }

      setStatus(`Found ${result.counts.total} items. Encrypting...`);

      const envelope = await encryptBackupEnvelope(result.json, signer!.nip44, pubkey);
      const npub = npubEncode(pubkey);

      const fileData: EncryptedBackupFileV3 = {
        planner: true,
        version: 3,
        npub,
        envelope,
      };

      const blob = new Blob([JSON.stringify(fileData, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const date = new Date().toISOString().slice(0, 10);
      a.download = `planner-backup-${date}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setStatus(
        `Encrypted backup saved with ${result.counts.total} items.`
      );
      setDone(true);
    } catch (err) {
      setError(`Download failed: ${err}`);
    } finally {
      setWorking(false);
    }
  };

  const handleRestoreFromFile = async (file: File) => {
    if (!pubkey) return;

    setWorking(true);
    setError("");
    setDone(false);
    setStatus("Reading backup file...");

    const MAX_BACKUP_SIZE = 50 * 1024 * 1024; // 50 MB
    if (file.size > MAX_BACKUP_SIZE) {
      setError(`File too large (${Math.round(file.size / 1024 / 1024)} MB). Maximum backup size is 50 MB.`);
      setWorking(false);
      return;
    }

    try {
      const text = await file.text();
      let parsed: BackupFile;

      try {
        parsed = JSON.parse(text);
      } catch {
        setError("Invalid JSON file. Please select a valid Planner backup file.");
        setWorking(false);
        return;
      }

      let rawEvents: RawEvent[];
      let preferences: Record<string, unknown> | undefined;

      const isV3 = (p: BackupFile): p is EncryptedBackupFileV3 =>
        "envelope" in p && p.version === 3;
      const isV2 = (p: BackupFile): p is EncryptedBackupFileV2 =>
        "encrypted" in p && p.encrypted === true && p.version === 2;

      if (isV3(parsed) || isV2(parsed)) {
        if (!nip44) {
          setError("NIP-44 encryption is required to decrypt this backup. Please use a Nostr extension that supports NIP-44.");
          setWorking(false);
          return;
        }

        const npub = npubEncode(pubkey);
        if (parsed.npub !== npub) {
          setError(
            `This backup belongs to a different npub (${parsed.npub.slice(0, 16)}...). ` +
            `You are logged in as ${npub.slice(0, 16)}.... ` +
            `You can only restore your own backups.`
          );
          setWorking(false);
          return;
        }

        setStatus("Decrypting backup...");
        const decrypted = isV3(parsed)
          ? await decryptBackupEnvelope(parsed.envelope as unknown as Record<string, unknown>, signer!.nip44, pubkey)
          : await signer!.nip44.decrypt(pubkey, parsed.data);
        const inner = JSON.parse(decrypted);

        if (!inner.events || !Array.isArray(inner.events)) {
          setError("Decrypted backup has no events. File may be corrupted.");
          setWorking(false);
          return;
        }

        rawEvents = inner.events;
        preferences = inner.preferences;

      // Legacy unencrypted v1 format
      } else if ("events" in parsed && Array.isArray(parsed.events)) {
        rawEvents = parsed.events;
        preferences = (parsed as PlaintextBackupFile).preferences;

      } else {
        setError("Unrecognized backup format. Please select a valid Planner backup file.");
        setWorking(false);
        return;
      }

      if (rawEvents.length === 0) {
        setError("No events found in backup file.");
        setWorking(false);
        return;
      }

      const { calCount, colCount, taskCount } = summarizeCounts(rawEvents);

      setStatus(
        `Found ${rawEvents.length} items (${calCount} events, ${colCount} calendars, ${taskCount} task list(s)). Re-publishing to relays...`
      );

      const published = await republishEvents(rawEvents, { signEvent, publishEvent });

      if (preferences) {
        restoreSettings(preferences as Parameters<typeof restoreSettings>[0]);
      }

      await Promise.all([forceFullRefresh(), refreshTasks()]);

      setStatus(
        `Restore complete! ${published}/${rawEvents.length} items re-published.`
      );
      setDone(true);
    } catch (err) {
      setError(`Restore failed: ${err}`);
    } finally {
      setWorking(false);
    }
  };

  const handleShowBlossomRestore = async () => {
    if (!pubkey) return;
    setBlossomLoading(true);
    setError("");
    setBlossomEntries([]);
    setBlossomView(true);
    try {
      const entries = await findBackupRefs(pubkey, relays);
      setBlossomEntries(entries);
      if (entries.length === 0) {
        setError("No Blossom backups found on your relays.");
      }
    } catch (err) {
      setError(`Failed to fetch backups: ${err}`);
    } finally {
      setBlossomLoading(false);
    }
  };

  const handleRestoreFromBlossom = async (entry: BackupEntry) => {
    if (!pubkey) return;
    setWorking(true);
    setError("");
    setDone(false);
    setStatus("Downloading backup from Blossom...");
    try {
      const backup = await downloadBackup({ sha256: entry.sha256, servers: entry.servers }, signer?.nip44, pubkey);
      if (!backup || backup.events.length === 0) {
        setError("Could not download or verify this backup from any server.");
        setWorking(false);
        return;
      }

      const { calCount, colCount, taskCount } = summarizeCounts(backup.events);
      setStatus(
        `Found ${backup.events.length} items (${calCount} events, ${colCount} calendars, ${taskCount} task list(s)). Re-publishing to relays...`
      );

      const published = await republishEvents(backup.events, { signEvent, publishEvent });

      if (backup.preferences) {
        restoreSettings(backup.preferences as Parameters<typeof restoreSettings>[0]);
      }

      await Promise.all([forceFullRefresh(), refreshTasks()]);

      setStatus(`Restore complete! ${published}/${backup.events.length} items re-published.`);
      setDone(true);
      setBlossomView(false);
    } catch (err) {
      setError(`Restore failed: ${err}`);
    } finally {
      setWorking(false);
    }
  };

  const handleResetBackups = async () => {
    if (!pubkey) return;
    const confirmed = window.confirm(
      "Forget your cloud backups and start over?\n\n" +
      "Your calendars, events, tasks, and notes stay exactly where they are — " +
      "nothing in your planner will change.\n\n" +
      "This only throws away the list of old cloud backups (the ones shown on " +
      "this screen). If auto-backup is on, a clean new cloud backup will be " +
      "made the next time you change something."
    );
    if (!confirmed) return;
    setWorking(true);
    setError("");
    setStatus("Forgetting old cloud backups...");
    try {
      await clearBackupRef(signEvent, publishEvent);
      setBlossomEntries([]);
      setStatus("Old cloud backups forgotten. A fresh one will be made the next time your data changes.");
      setDone(true);
    } catch (err) {
      setError(`Reset failed: ${err}`);
    } finally {
      setWorking(false);
    }
  };

  const formatDate = (ts: string) => {
    try {
      const d = new Date(ts);
      return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    } catch { return ts; }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full">
        <div className="flex items-center justify-between p-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold">Backup & Restore</h2>
          <button
            onClick={onClose}
            className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {blossomView ? (
            <>
              <button
                type="button"
                onClick={() => { setBlossomView(false); setError(""); }}
                className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700"
              >
                <ChevronLeft className="w-3 h-3" />Back
              </button>

              <p className="text-sm text-gray-600">
                Select a backup to restore from Blossom storage.
              </p>

              {blossomLoading && (
                <div className="flex items-center gap-2 p-3 bg-primary-50 rounded-lg">
                  <HardDrive className="w-4 h-4 text-primary-600 animate-pulse" />
                  <span className="text-sm text-primary-800">Searching relays for backups...</span>
                </div>
              )}

              {!blossomLoading && (
                <button
                  onClick={handleResetBackups}
                  disabled={working}
                  className="w-full flex items-center justify-center gap-2 p-2 text-xs text-red-600 border border-red-200 rounded-lg hover:bg-red-50 transition-colors disabled:opacity-50"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Forget cloud backups & start over
                </button>
              )}

              {blossomEntries.map((entry, i) => (
                <div
                  key={entry.sha256}
                  className="border border-gray-200 rounded-xl p-4 space-y-3"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-gray-900">
                      {i === 0 ? "Latest" : i === 1 ? "Previous" : "Oldest"}
                    </span>
                    <span className="text-xs text-gray-400">{formatDate(entry.timestamp)}</span>
                  </div>

                  <div className="grid grid-cols-3 gap-2">
                    <div className="flex items-center gap-1.5 text-xs text-gray-600">
                      <Calendar className="w-3.5 h-3.5 text-primary-500" />
                      <span>{entry.calendarEvents} events</span>
                    </div>
                    <div className="flex items-center gap-1.5 text-xs text-gray-600">
                      <Layers className="w-3.5 h-3.5 text-primary-500" />
                      <span>{entry.calendarCollections} calendars</span>
                    </div>
                    <div className="flex items-center gap-1.5 text-xs text-gray-600">
                      <List className="w-3.5 h-3.5 text-primary-500" />
                      <span>{entry.taskLists} task lists</span>
                    </div>
                  </div>

                  <div className="flex items-center justify-between">
                    <span className="text-xs text-gray-400">
                      {entry.totalEvents} total items
                    </span>
                    <button
                      onClick={() => handleRestoreFromBlossom(entry)}
                      disabled={working}
                      className="text-sm font-medium text-primary-600 hover:text-primary-800 disabled:opacity-50"
                    >
                      Restore this backup
                    </button>
                  </div>
                </div>
              ))}
            </>
          ) : (
            <>
              <p className="text-sm text-gray-500">
                Your data is backed up automatically to Blossom decentralized storage
                whenever it changes. As an extra safeguard, save an encrypted backup
                file to your device every so often.
              </p>

              <div className="flex items-center gap-2 px-3 py-2 bg-primary-50 rounded-lg">
                <Lock className="w-4 h-4 text-primary-600 flex-shrink-0" />
                <span className="text-xs text-primary-800">
                  Backup files are encrypted with NIP-44 and locked to your npub. Only you can decrypt them.
                </span>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <button
                  onClick={handleDownloadFile}
                  disabled={working}
                  className="flex flex-col items-center gap-2 p-4 border-2 border-dashed border-gray-300 rounded-xl hover:border-primary-400 hover:bg-primary-50 transition-colors disabled:opacity-50"
                >
                  <Download className="w-8 h-8 text-primary-600" />
                  <span className="text-sm font-medium">Save to File</span>
                  <span className="text-xs text-gray-400">Encrypted backup</span>
                </button>

                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={working}
                  className="flex flex-col items-center gap-2 p-4 border-2 border-dashed border-gray-300 rounded-xl hover:border-emerald-400 hover:bg-emerald-50 transition-colors disabled:opacity-50"
                >
                  <Upload className="w-8 h-8 text-emerald-600" />
                  <span className="text-sm font-medium">Restore from File</span>
                  <span className="text-xs text-gray-400">Decrypt & restore</span>
                </button>
              </div>

              <button
                onClick={handleShowBlossomRestore}
                disabled={working}
                className="w-full flex items-center justify-center gap-2 p-3 border border-gray-200 rounded-xl hover:bg-gray-50 transition-colors disabled:opacity-50"
              >
                <Cloud className="w-5 h-5 text-primary-600" />
                <span className="text-sm font-medium">Restore from Blossom</span>
                <span className="text-xs text-gray-400 ml-1">Last 3 backups</span>
              </button>

              <input
                ref={fileInputRef}
                type="file"
                accept=".json"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleRestoreFromFile(file);
                  e.target.value = "";
                }}
              />
            </>
          )}

          {status && (
            <div className={`flex items-start gap-2 p-3 rounded-lg ${
              done
                ? "bg-emerald-50 border-2 border-emerald-300"
                : "bg-primary-50"
            }`}>
              {done ? (
                <Check className="w-5 h-5 mt-0.5 flex-shrink-0 text-emerald-600" />
              ) : (
                <HardDrive className="w-4 h-4 mt-0.5 flex-shrink-0 text-primary-600" />
              )}
              <span className={`text-sm ${
                done ? "font-medium text-emerald-800" : "text-primary-800"
              }`}>{status}</span>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 p-3 bg-red-50 rounded-lg">
              <AlertCircle className="w-4 h-4 text-red-600 mt-0.5 flex-shrink-0" />
              <span className="text-sm text-red-800">{error}</span>
            </div>
          )}
        </div>

        <div className="p-4 border-t border-gray-100">
          <button
            onClick={onClose}
            className="w-full px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
