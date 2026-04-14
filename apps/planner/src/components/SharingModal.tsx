import { useState, useEffect } from "react";
import {
  X,
  Users,
  UserPlus,
  UserMinus,
  Copy,
  Check,
  Link as LinkIcon,
  LogOut,
  AlertCircle,
  Loader,
} from "lucide-react";
import { useCalendar } from "../contexts/CalendarContext";
import { useSharing } from "../contexts/SharingContext";
import { lookupNip05 } from "../lib/sharing";
import { nip19 } from "nostr-tools";

/** @see {@link SharingModal} */
interface SharingModalProps {
  /** The `d` tag of the calendar to manage sharing for. */
  calDTag: string;
  onClose: () => void;
}

/** Try to parse a user input (npub, nprofile, hex pubkey, or email NIP-05) to a hex pubkey. */
async function resolveInput(input: string): Promise<string | null> {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // NIP-05 email
  if (trimmed.includes("@")) {
    return lookupNip05(trimmed);
  }

  // npub / nprofile
  if (trimmed.startsWith("npub") || trimmed.startsWith("nprofile")) {
    try {
      const decoded = nip19.decode(trimmed);
      if (decoded.type === "npub") return decoded.data as string;
      if (decoded.type === "nprofile")
        return (decoded.data as { pubkey: string }).pubkey;
    } catch {
      return null;
    }
  }

  // bare hex pubkey
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return trimmed.toLowerCase();

  return null;
}

/** Shorten a hex pubkey to npub and truncate for display. */
function shortNpub(pubkey: string): string {
  try {
    const npub = nip19.npubEncode(pubkey);
    return `${npub.slice(0, 12)}…${npub.slice(-6)}`;
  } catch {
    return `${pubkey.slice(0, 8)}…`;
  }
}

/**
 * Modal for managing shared calendar membership and invite links.
 *
 * Renders different UIs depending on the user's role:
 *
 * **Owner view** (calendar creator):
 * - Member list with remove buttons. Removing a member triggers an AES key
 *   rotation — the old key is discarded, a new key is generated, and new
 *   NIP-44 key envelopes are sent to all remaining members. This invalidates
 *   any outstanding invite links.
 * - Add-member input accepting npub, nprofile, hex pubkey, or NIP-05 email
 *   (resolved via `/.well-known/nostr.json`).
 * - Invite link section — a URL containing the calendar dTag + AES-256-GCM
 *   key, base64-encoded in the hash fragment. The link is pre-fetched on
 *   mount so it's ready to copy immediately.
 *
 * **Member view** (invited participant):
 * - Shows who shared the calendar (owner npub).
 * - "Leave shared calendar" with confirmation step.
 *
 * **Private calendar** (not yet shared):
 * - "Enable Sharing" button that converts to a shared calendar by generating
 *   an AES-256-GCM key and publishing the key envelope.
 */
export function SharingModal({ calDTag, onClose }: SharingModalProps) {
  const {
    calendars,
    removeMember,
    convertToShared,
    leaveSharedCalendarAndCleanup,
  } = useCalendar();
  const {
    calendarMembers,
    isSharedCalendar,
    isOwnedSharedCalendar,
    addMember,
    getInviteLink,
  } = useSharing();

  const cal = calendars.find((c) => c.dTag === calDTag);
  const isShared = isSharedCalendar(calDTag);
  const isOwner = isOwnedSharedCalendar(calDTag);
  const ownerPubkey = cal?.ownerPubkey;
  // A calendar we own that hasn't been converted to shared yet —
  // show the "Enable Sharing" CTA instead of member management.
  const isOwnedPrivate = !isShared && !ownerPubkey;
  const members = calendarMembers.get(calDTag) || [];

  const [inputValue, setInputValue] = useState("");
  const [resolving, setResolving] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [addingPubkey, setAddingPubkey] = useState<string | null>(null);
  const [removingPubkey, setRemovingPubkey] = useState<string | null>(null);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [linkLoading, setLinkLoading] = useState(false);
  const [leavingConfirm, setLeavingConfirm] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [rotatingWarning, setRotatingWarning] = useState<string | null>(null);
  const [converting, setConverting] = useState(false);
  const [convertError, setConvertError] = useState<string | null>(null);

  const handleConvertToShared = async () => {
    setConverting(true);
    setConvertError(null);
    try {
      await convertToShared(calDTag);
    } catch (err) {
      setConvertError(String(err));
    } finally {
      setConverting(false);
    }
  };

  // Pre-fetch invite link for owners so it's ready to copy
  useEffect(() => {
    if (!isOwner) return;
    setLinkLoading(true);
    getInviteLink(calDTag, calendars)
      .then(setInviteLink)
      .catch(() => setInviteLink(null))
      .finally(() => setLinkLoading(false));
  }, [calDTag, isOwner, getInviteLink, calendars]);

  const handleAdd = async () => {
    setAddError(null);
    setResolving(true);
    try {
      const pubkey = await resolveInput(inputValue);
      if (!pubkey) {
        setAddError("Could not resolve to a Nostr pubkey. Enter npub, nprofile, or email@domain (NIP-05).");
        return;
      }
      if (members.includes(pubkey)) {
        setAddError("This person is already a member.");
        return;
      }
      setAddingPubkey(pubkey);
      await addMember(calDTag, pubkey);
      setInputValue("");
      // Refresh invite link since member list changed
      const link = await getInviteLink(calDTag, calendars);
      setInviteLink(link);
    } catch (err) {
      setAddError(String(err));
    } finally {
      setResolving(false);
      setAddingPubkey(null);
    }
  };

  /** Remove a member and rotate the shared AES key so the removed member
   *  can no longer decrypt new events or use old invite links. */
  const handleRemove = async (memberPubkey: string) => {
    setRotatingWarning(null);
    setRemovingPubkey(memberPubkey);
    try {
      await removeMember(calDTag, memberPubkey);
      // Key was rotated — old invite links are invalid, fetch the new one
      const link = await getInviteLink(calDTag, calendars);
      setInviteLink(link);
      setRotatingWarning("Key rotated. Existing invite links are now invalid — share the new one.");
    } catch (err) {
      setAddError(`Remove failed: ${err}`);
    } finally {
      setRemovingPubkey(null);
    }
  };

  const handleCopyLink = async () => {
    if (!inviteLink) return;
    await navigator.clipboard.writeText(inviteLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleLeave = async () => {
    setLeaving(true);
    try {
      await leaveSharedCalendarAndCleanup(calDTag);
      onClose();
    } catch {
      setLeaving(false);
      setLeavingConfirm(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div className="flex items-center gap-2">
            <Users className="w-5 h-5 text-primary-600" />
            <h2 className="font-semibold text-gray-900">
              {cal?.title || "Shared Calendar"}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-gray-400 hover:text-gray-700 rounded-lg hover:bg-gray-100"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
          {/* Private calendar: offer to enable sharing */}
          {isOwnedPrivate && (
            <div>
              <p className="text-sm text-gray-600 mb-3">
                This calendar is private. Enable sharing to invite others with end-to-end encryption.
              </p>
              <button
                onClick={handleConvertToShared}
                disabled={converting}
                className="flex items-center gap-2 px-4 py-2.5 bg-primary-600 text-white rounded-xl text-sm hover:bg-primary-700 disabled:opacity-50 w-full justify-center"
              >
                {converting ? (
                  <Loader className="w-4 h-4 animate-spin" />
                ) : (
                  <Users className="w-4 h-4" />
                )}
                {converting ? "Enabling sharing…" : "Enable Sharing"}
              </button>
              {convertError && (
                <p className="mt-2 text-xs text-red-600">{convertError}</p>
              )}
            </div>
          )}

          {/* Member perspective: not owner */}
          {!isOwner && ownerPubkey && (
            <div className="flex items-start gap-3 bg-blue-50 rounded-xl p-3 text-sm text-blue-800">
              <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0 text-blue-500" />
              <div>
                <p className="font-medium">Shared with you by</p>
                <p className="font-mono text-xs mt-0.5">{shortNpub(ownerPubkey)}</p>
              </div>
            </div>
          )}

          {/* Member list (owner view) */}
          {isOwner && (
            <div>
              <p className="text-sm font-semibold text-gray-700 mb-2">
                Members ({members.length})
              </p>
              {members.length === 0 ? (
                <p className="text-sm text-gray-400 italic">No members yet — add one below or share the invite link.</p>
              ) : (
                <ul className="space-y-1.5">
                  {members.map((m) => (
                    <li
                      key={m}
                      className="flex items-center justify-between gap-2 px-3 py-2 bg-gray-50 rounded-lg"
                    >
                      <span className="font-mono text-xs text-gray-700 truncate">
                        {shortNpub(m)}
                      </span>
                      <button
                        onClick={() => handleRemove(m)}
                        disabled={removingPubkey === m}
                        className="p-1 text-red-400 hover:text-red-600 disabled:opacity-50 flex-shrink-0"
                        title="Remove member (rotates key)"
                      >
                        {removingPubkey === m ? (
                          <Loader className="w-4 h-4 animate-spin" />
                        ) : (
                          <UserMinus className="w-4 h-4" />
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {rotatingWarning && (
                <p className="mt-2 text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-2">
                  {rotatingWarning}
                </p>
              )}
            </div>
          )}

          {/* Add member (owner only) */}
          {isOwner && (
            <div>
              <p className="text-sm font-semibold text-gray-700 mb-2">Add member</p>
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="npub…, nprofile…, or user@domain.com"
                  value={inputValue}
                  onChange={(e) => {
                    setInputValue(e.target.value);
                    setAddError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleAdd();
                  }}
                  className="flex-1 min-w-0 px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-400"
                />
                <button
                  onClick={handleAdd}
                  disabled={!inputValue.trim() || resolving || !!addingPubkey}
                  className="px-3 py-2 bg-primary-600 text-white rounded-lg text-sm hover:bg-primary-700 disabled:opacity-50 flex items-center gap-1.5"
                >
                  {resolving || addingPubkey ? (
                    <Loader className="w-4 h-4 animate-spin" />
                  ) : (
                    <UserPlus className="w-4 h-4" />
                  )}
                  Add
                </button>
              </div>
              {addError && (
                <p className="mt-1.5 text-xs text-red-600">{addError}</p>
              )}
              <p className="mt-1.5 text-xs text-gray-400">
                Accepts npub, nprofile, or NIP-05 email (e.g. alice@example.com)
              </p>
            </div>
          )}

          {/* Invite link (owner only) */}
          {isOwner && (
            <div>
              <p className="text-sm font-semibold text-gray-700 mb-2 flex items-center gap-1.5">
                <LinkIcon className="w-3.5 h-3.5" />
                Invite link
              </p>
              <div className="flex items-start gap-2 px-3 py-2 mb-2 bg-amber-50 border border-amber-200 rounded-lg">
                <span className="text-amber-500 text-sm flex-shrink-0 mt-0.5">&#9888;</span>
                <p className="text-xs text-amber-800">
                  This link grants full calendar access. Anyone with it can read all events. Share only over encrypted channels and treat it like a password.
                </p>
              </div>
              <div className="flex gap-2">
                <input
                  readOnly
                  value={linkLoading ? "Generating…" : (inviteLink || "Unavailable")}
                  className="flex-1 min-w-0 px-3 py-2 text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded-lg font-mono truncate"
                />
                <button
                  onClick={handleCopyLink}
                  disabled={!inviteLink || linkLoading}
                  className="px-3 py-2 border border-gray-300 text-gray-700 rounded-lg text-sm hover:bg-gray-50 disabled:opacity-50 flex items-center gap-1.5 flex-shrink-0"
                  title="Copy to clipboard"
                >
                  {copied ? (
                    <Check className="w-4 h-4 text-green-600" />
                  ) : (
                    <Copy className="w-4 h-4" />
                  )}
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
            </div>
          )}

          {/* Leave (member perspective) */}
          {!isOwner && (
            <div className="pt-2 border-t border-gray-100">
              {leavingConfirm ? (
                <div className="space-y-2">
                  <p className="text-sm text-gray-700">
                    Leave this shared calendar? You'll lose access to its events.
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={handleLeave}
                      disabled={leaving}
                      className="px-3 py-1.5 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 flex items-center gap-1.5"
                    >
                      {leaving ? <Loader className="w-3.5 h-3.5 animate-spin" /> : null}
                      Confirm Leave
                    </button>
                    <button
                      onClick={() => setLeavingConfirm(false)}
                      className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setLeavingConfirm(true)}
                  className="flex items-center gap-1.5 text-sm text-red-500 hover:text-red-700"
                >
                  <LogOut className="w-4 h-4" />
                  Leave shared calendar
                </button>
              )}
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-gray-100">
          <button
            onClick={onClose}
            className="w-full px-4 py-2 text-sm text-gray-600 hover:text-gray-900 border border-gray-200 rounded-xl hover:bg-gray-50"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
