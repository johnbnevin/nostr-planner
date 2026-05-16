/**
 * BackupPanel — manual save/restore controls around the snapshot system.
 *
 *  - Save a cloud backup right now (bypasses the autosave debounce).
 *  - Restore from the cloud (re-applies the current Blossom pointer's snapshot).
 *  - Forget the cloud pointer (escape hatch for a corrupt backup).
 *  - Export the current in-memory state to a local file.
 */

import { useState } from "react";
import { X, Check, AlertCircle, HardDrive, Lock, Cloud, Trash2, Download, History } from "lucide-react";
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
  wrapEnvelope,
  listUserBlobs,
  fetchSnapshotBySha,
  type BlobHandle,
} from "../lib/backup";
import { npubEncode } from "nostr-tools/nip19";
import { saveFile } from "../lib/fileSave";
import { useReplicationStatus } from "../hooks/useReplicationStatus";

interface BackupPanelProps { onClose: () => void; }

export function BackupPanel({ onClose }: BackupPanelProps) {
  const { pubkey, relays, signEvent, publishEvent, signer } = useNostr();
  const { events, calendars, applySnapshot: applyCalendarSnapshot, eventTombstones, setLastRemoteSha } = useCalendar();
  const { habits, completions, lists, applySnapshot: applyTasksSnapshot, habitTombstones, listTombstones } = useTasks();
  const { getSettings, restoreSettings } = useSettings();

  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [working, setWorking] = useState(false);
  const [done, setDone] = useState(false);
  // Recovery panel state — list of historical blobs available on the
  // Blossom servers the user has written to. Opened on demand from the
  // "Find older backups" button; each row can be previewed + restored.
  // `previews` maps sha -> decrypted counts (or "loading" / "failed")
  // so the user can see what each blob contains before choosing.
  const [recoverList, setRecoverList] = useState<BlobHandle[] | null>(null);
  const [recoverLoading, setRecoverLoading] = useState(false);
  type Preview = { events: number; calendars: number; habits: number; lists: number; savedAt?: string };
  const [previews, setPreviews] = useState<Record<string, Preview | "loading" | "failed">>({});
  const [shaInput, setShaInput] = useState<string>("");

  const nip44Available = isNip44Available(signer);
  const replication = useReplicationStatus();

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

  const findOlderBackups = async () => {
    if (!pubkey || !signer?.nip44) { setError("NIP-44 signer required"); return; }
    setRecoverLoading(true); setError(""); setStatus("");
    try {
      const blobs = await listUserBlobs(pubkey, signEvent);
      setRecoverList(blobs);
      if (blobs.length === 0) {
        setError("No blobs found on any Blossom server. If you have a specific sha256 noted somewhere, paste it in the Restore-by-sha input below.");
        return;
      }
      // Fire decrypts in parallel so each row can show event/calendar
      // counts — without this the user has no way to tell which blob
      // is "the good one". Mark loading first so the UI reflects it
      // immediately, then replace as each decrypt settles.
      setPreviews(Object.fromEntries(blobs.map((b) => [b.sha256, "loading" as const])));
      const nip44 = signer.nip44;
      blobs.forEach((b) => {
        void fetchSnapshotBySha(b.sha256, pubkey, nip44).then((snap) => {
          setPreviews((prev) => ({
            ...prev,
            [b.sha256]: snap
              ? {
                  events: snap.events.length,
                  calendars: snap.calendars.length,
                  habits: snap.habits.length,
                  lists: snap.lists.length,
                  savedAt: snap.savedAt,
                }
              : "failed",
          }));
        }).catch(() => {
          setPreviews((prev) => ({ ...prev, [b.sha256]: "failed" }));
        });
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRecoverLoading(false);
    }
  };

  const restoreFromBlob = async (sha: string) => {
    if (!pubkey || !signer?.nip44) { setError("NIP-44 signer required"); return; }
    setWorking(true); setError(""); setDone(false);
    setStatus(`Fetching and decrypting ${sha.slice(0, 8)}…`);
    try {
      const snap = await fetchSnapshotBySha(sha, pubkey, signer.nip44);
      if (!snap) { setError("Couldn't fetch or decrypt that blob — try another."); return; }
      applyCalendarSnapshot(snap.events, snap.calendars);
      applyTasksSnapshot(snap.habits, snap.completions, snap.lists);
      restoreSettings(snap.settings);

      // CRITICAL: immediately publish the restored state as the new
      // current pointer. Until this happens, the relay pointer still
      // points at the OLD (bad) blob, and any loadSnapshot re-run
      // before autosave fires in 10 s — page reload, tab visibility
      // cycle, restoreSettings changing primaryRelay which re-fires
      // CalendarApp's effects — would overwrite the restored UI state
      // with the bad blob again. Strip the _sha256 field (not part of
      // the Snapshot shape saveSnapshot expects) and re-encrypt the
      // same restored content as a fresh blob; that blob becomes the
      // new current, relay pointer is updated, future loads see it.
      setStatus(`Restored locally — republishing as current…`);
      const { _sha256: _drop, ...plainSnap } = snap;
      void _drop;
      const ptr = await saveSnapshot(
        pubkey, plainSnap, signEvent, publishEvent, signer.nip44, relays
      );
      setLastRemoteSha(ptr.sha256);
      setStatus(`Restored ${snap.events.length} events, ${snap.calendars.length} calendars, ${snap.habits.length} habits, ${snap.lists.length} lists. Published as new current snapshot ${ptr.sha256.slice(0, 8)}…`);
      setDone(true);
      // Collapse the recover list so the success banner is visible.
      setRecoverList(null);
      setPreviews({});
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  };

  const restoreBySha = async () => {
    const trimmed = shaInput.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(trimmed)) {
      setError("That doesn't look like a sha256 — expected 64 hex characters.");
      return;
    }
    await restoreFromBlob(trimmed);
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
      // Envelope-encrypt the snapshot: AES-256-GCM encrypts the full JSON
      // (arbitrary size), NIP-44 encrypts only the 32-byte AES key. This
      // is the same format saveSnapshot uploads to Blossom, and it avoids
      // NIP-44's 65 535-byte plaintext cap — a direct nip44.encrypt(json)
      // rejected anything over ~65 KB as "invalid plaintext size".
      const json = JSON.stringify(snap);
      const envelope = await wrapEnvelope(json, pubkey, signer.nip44);
      const npub = npubEncode(pubkey);
      const file = { planner: true as const, version: 2 as const, npub, envelope };
      // Route through saveFile so mobile (Tauri + iOS PWA) gets the
      // share sheet instead of relying on a.download — which iOS Safari
      // and some webviews block or send to an inaccessible location.
      await saveFile(
        JSON.stringify(file, null, 2),
        `planner-backup-${new Date().toISOString().slice(0, 10)}.json`,
        "application/json",
      );
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

          {/* Replication status — only shown once we've recorded a save
              this session. Lists primary + per-mirror outcomes so the
              user can see exactly where their last save landed. */}
          {replication.lastBlossom && (
            <div className="rounded-xl border border-gray-200 p-3 text-xs space-y-1">
              <div className="font-medium text-gray-700">Last cloud save replication</div>
              <div className="text-emerald-700">
                ✓ Primary: <span className="font-mono">{new URL(replication.lastBlossom.primary).host}</span>
              </div>
              {replication.lastBlossom.mirrors.length === 0 ? (
                <div className="text-gray-500 italic">No additional mirror servers known.</div>
              ) : (
                replication.lastBlossom.mirrors.map((m) => (
                  <div key={m.url} className={m.status === "ok" ? "text-emerald-700" : "text-amber-700"}>
                    {m.status === "ok" ? "✓" : "⚠"} {new URL(m.url).host}
                    {m.status === "failed" && m.error ? (
                      <span className="text-gray-400"> — {m.error}</span>
                    ) : null}
                  </div>
                ))
              )}
              {(replication.pendingBlossomMirrors > 0 || replication.pendingRelayMirrors > 0) && (
                <div className="text-amber-700 italic pt-1">
                  {replication.pendingBlossomMirrors + replication.pendingRelayMirrors} mirror
                  {replication.pendingBlossomMirrors + replication.pendingRelayMirrors === 1 ? "" : "s"} retrying in background
                </div>
              )}
            </div>
          )}

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
            onClick={findOlderBackups}
            disabled={working || recoverLoading || !nip44Available}
            className="w-full flex items-center justify-center gap-2 p-3 border border-amber-200 rounded-xl hover:bg-amber-50 transition-colors disabled:opacity-50"
          >
            <History className="w-5 h-5 text-amber-600" />
            <span className="text-sm font-medium">
              {recoverLoading ? "Searching Blossom servers…" : "Find older backups"}
            </span>
          </button>

          {recoverList && recoverList.length > 0 && (() => {
            // Filter out non-Planner blobs: any blob whose preview came
            // back "failed" was successfully fetched but didn't decrypt
            // to a Planner snapshot (or didn't decrypt at all). The
            // user's Blossom account can contain blobs from other apps
            // under the same pubkey — those shouldn't clutter the
            // restore list. Keep rows that are still loading so the user
            // sees progress as decrypts settle.
            const visible = recoverList.filter((b) => previews[b.sha256] !== "failed");
            const hidden = recoverList.length - visible.length;
            return (
              <div className="border border-amber-200 rounded-xl p-3 space-y-2 bg-amber-50/30 max-h-96 overflow-y-auto">
                <div className="text-xs text-amber-900">
                  {visible.length} Planner snapshot{visible.length === 1 ? "" : "s"} found, newest first. Counts
                  are decrypted client-side so you can tell which is which.
                  Restore immediately re-publishes the chosen blob as the
                  current snapshot so a page reload won't clobber it.
                </div>
                {hidden > 0 && (
                  <div className="text-[11px] text-amber-700 italic">
                    {hidden} other blob{hidden === 1 ? "" : "s"} in your account hidden — not Planner snapshots.
                  </div>
                )}
                {visible.map((b) => {
                  const when = b.uploaded > 0 ? new Date(b.uploaded * 1000) : null;
                  const kb = (b.size / 1024).toFixed(1);
                  const preview = previews[b.sha256];
                  return (
                    <div key={b.sha256} className="flex items-center justify-between gap-2 bg-white rounded-lg border border-amber-200 p-2">
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-mono text-gray-700 truncate">{b.sha256.slice(0, 12)}…</div>
                        <div className="text-[11px] text-gray-500">
                          {when ? when.toLocaleString() : "(no timestamp)"} · {kb} KB · {new URL(b.server).host}
                        </div>
                        <div className="text-[11px] mt-0.5">
                          {preview === "loading" || preview === undefined ? (
                            <span className="text-gray-400">Decrypting…</span>
                          ) : preview && preview !== "failed" ? (
                            <span className="text-emerald-700 font-medium">
                              {preview.events} events · {preview.calendars} calendars · {preview.habits} habits · {preview.lists} lists
                              {preview.savedAt ? ` · saved ${new Date(preview.savedAt).toLocaleString()}` : ""}
                            </span>
                          ) : null}
                        </div>
                      </div>
                      <button
                        onClick={() => void restoreFromBlob(b.sha256)}
                        disabled={working || preview === "loading" || preview === undefined}
                        title={
                          preview === "loading" || preview === undefined
                            ? "Wait for the snapshot to finish decrypting"
                            : ""
                        }
                        className="shrink-0 px-2 py-1 text-xs font-medium bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50 transition-colors"
                      >
                        Restore
                      </button>
                    </div>
                  );
                })}
              </div>
            );
          })()}

          {/* Restore by sha256 — escape hatch when the blob you want is
              not in the "Find older backups" list (servers garbage-collect
              old blobs; N-2 is pruned by us every save). If you have a
              sha noted elsewhere you can paste it here. */}
          <div className="border border-gray-200 rounded-xl p-3 space-y-2 bg-gray-50/50">
            <div className="text-xs font-medium text-gray-700">Restore by sha256</div>
            <div className="text-[11px] text-gray-500">
              If you have a snapshot sha noted from a log or elsewhere, paste
              it here to restore that specific version directly.
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={shaInput}
                onChange={(e) => setShaInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void restoreBySha(); }}
                placeholder="64-char hex sha256"
                className="flex-1 min-w-0 px-2 py-1.5 border border-gray-300 rounded-lg text-xs font-mono focus:outline-none focus:ring-2 focus:ring-primary-500"
                disabled={working || !nip44Available}
              />
              <button
                onClick={() => void restoreBySha()}
                disabled={working || !shaInput.trim() || !nip44Available}
                className="shrink-0 px-3 py-1.5 text-xs font-medium bg-gray-700 text-white rounded-lg hover:bg-gray-800 disabled:opacity-50 transition-colors"
              >
                Restore
              </button>
            </div>
          </div>

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
