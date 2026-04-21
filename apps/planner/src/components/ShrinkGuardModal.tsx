/**
 * ShrinkGuardModal — confirmation for a save that would drastically
 * shrink the snapshot. Opens from the amber ShieldAlert cloud icon
 * in the header when `backupPhase === "blocked"` (see useAutoBackup's
 * shrink-guard + SnapshotShrinkError throw path in lib/backup.ts).
 *
 * Three user-facing options:
 *   1. Keep my current state — do nothing. The underlying state is
 *      still "dirty"; any further edit will re-attempt the save and
 *      either succeed (state grew back) or re-trigger the block.
 *   2. Restore what's on the cloud — throw away local edits, re-apply
 *      the remote snapshot as the canonical state. Clears blocked.
 *   3. Save anyway — bypass the shrink-guard for this one save. Used
 *      when the user legitimately deleted data and wants it published.
 */

import { ShieldAlert, X, AlertTriangle } from "lucide-react";
import type { BlockedDetails } from "../hooks/useAutoBackup";

interface Props {
  details: BlockedDetails;
  onClose: () => void;
  onProceedAnyway: () => Promise<void> | void;
  onDiscardLocal: () => Promise<void> | void;
}

const KIND_LABEL: Record<BlockedDetails["kind"], string> = {
  "events-zero": "The new snapshot has no events at all.",
  "events-halved": "The new snapshot drops more than half of your events.",
  "calendars-halved": "The new snapshot drops more than half of your calendars.",
  "tasks-halved": "The new snapshot drops more than half of your habits + lists.",
};

export function ShrinkGuardModal({ details, onClose, onProceedAnyway, onDiscardLocal }: Props) {
  const r = details.remote;
  const w = details.working;
  const row = (label: string, remoteN: number, workingN: number) => {
    const shrunk = workingN < remoteN;
    return (
      <tr className="border-t border-gray-100">
        <td className="py-2 pr-4 text-gray-600">{label}</td>
        <td className="py-2 pr-4 tabular-nums text-right">{remoteN}</td>
        <td className={`py-2 tabular-nums text-right font-semibold ${shrunk ? "text-red-700" : "text-gray-900"}`}>
          {workingN}
        </td>
      </tr>
    );
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full">
        <div className="flex items-center justify-between p-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <ShieldAlert className="w-5 h-5 text-amber-600" /> Save blocked
          </h2>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          <div className="flex items-start gap-2 p-3 bg-amber-50 rounded-lg">
            <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" />
            <div className="text-sm text-amber-900">{KIND_LABEL[details.kind]} The auto-save won't overwrite your cloud backup until you confirm what you want to do.</div>
          </div>

          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className="py-2 pr-4 text-left text-xs font-medium text-gray-500"></th>
                <th className="py-2 pr-4 text-right text-xs font-medium text-gray-500">Now on cloud</th>
                <th className="py-2 text-right text-xs font-medium text-gray-500">Would save</th>
              </tr>
            </thead>
            <tbody>
              {row("Events", r.events, w.events)}
              {row("Calendars", r.calendars, w.calendars)}
              {row("Habits", r.habits, w.habits)}
              {row("Lists", r.lists, w.lists)}
            </tbody>
          </table>

          <div className="space-y-2 pt-1">
            <button
              onClick={onClose}
              className="w-full p-3 border border-gray-200 rounded-xl text-sm font-medium hover:bg-gray-50 transition-colors text-left"
            >
              <div>Keep my current state</div>
              <div className="text-xs text-gray-500 mt-0.5">Do nothing. Next edit will re-attempt; if it's still shrunken, this prompt returns.</div>
            </button>

            <button
              onClick={() => void onDiscardLocal()}
              className="w-full p-3 border border-emerald-200 rounded-xl text-sm font-medium text-emerald-800 hover:bg-emerald-50 transition-colors text-left"
            >
              <div>Restore what's on the cloud</div>
              <div className="text-xs text-emerald-700 mt-0.5">Discard local edits. Replace with the cloud snapshot shown above.</div>
            </button>

            <button
              onClick={() => void onProceedAnyway()}
              className="w-full p-3 border border-red-200 rounded-xl text-sm font-medium text-red-800 hover:bg-red-50 transition-colors text-left"
            >
              <div>Save anyway</div>
              <div className="text-xs text-red-700 mt-0.5">Publish the smaller snapshot. Use this if you intentionally deleted everything above.</div>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
