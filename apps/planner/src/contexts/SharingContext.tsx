/**
 * SharingContext — shared calendar key management and member operations.
 *
 * Responsibilities:
 *  - Manages shared-calendar AES-256-GCM keys (in-memory only, never persisted
 *    as plaintext) and their distribution via NIP-44 key envelopes (kind 30078).
 *  - Tracks which calendars are shared and who owns them.
 *  - Provides key loading, member CRUD (add only — remove requires event
 *    re-encryption and lives in CalendarContext), invite link generation/acceptance,
 *    and leave/cleanup operations.
 *
 * This context is placed BETWEEN SettingsProvider and CalendarProvider in the
 * provider chain. It does NOT depend on CalendarContext (no circular dep).
 * CalendarContext consumes SharingContext for key lookups and state.
 *
 * @module SharingContext
 */

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { useNostr } from "./NostrContext";
import { logger } from "../lib/logger";
import {
  DTAG_CAL_KEY_PREFIX,
  type CalendarCollection,
} from "../lib/nostr";
import {
  isNip44Available,
} from "../lib/crypto";
import {
  exportKeyToBase64,
  importKeyFromBase64,
  publishKeyEnvelope,
  publishMemberList,
  fetchOwnKeyData,
  fetchMyInvitations,
  saveSharedCalOwner,
  removeSharedCalOwner,
  loadSharedCalOwners,
  encodeInvitePayload,
  decodeInvitePayload,
  isAcceptedShare,
  isRejectedShare,
  acceptShare,
  rejectShare,
} from "../lib/sharing";

/** A shared-calendar invitation awaiting the user's explicit accept/reject.
 *  Invitations from owners the user hasn't consented to are NOT auto-imported
 *  (that would let any third party inject a calendar); they surface here. */
export interface PendingInvitation {
  calDTag: string;
  ownerPubkey: string;
  keyBase64: string;
}

/** Time-to-live for cached shared keys before a re-fetch is triggered. */
const SHARED_KEYS_TTL_MS = 5 * 60_000; // 5 minutes

export interface SharingContextValue {
  // ── State ──────────────────────────────────────────────────────────
  /** calDTag -> AES-256-GCM CryptoKey (for both owned and member calendars). */
  sharedKeys: Map<string, CryptoKey>;
  /** calDTag -> ownerPubkey (for shared calendars we are a member of, not owner). */
  sharedCalOwners: Map<string, string>;
  /** calDTag -> member pubkeys (only for calendars we own + have shared). */
  calendarMembers: Map<string, string[]>;
  /** Incoming shared-calendar invitations from owners the user hasn't yet
   *  accepted. Surfaced for an explicit accept/reject decision. */
  pendingInvitations: PendingInvitation[];

  // ── State setters (consumed by CalendarContext for removeMember/convertToShared) ──
  setSharedKeys: React.Dispatch<React.SetStateAction<Map<string, CryptoKey>>>;
  setSharedCalOwners: React.Dispatch<React.SetStateAction<Map<string, string>>>;
  setCalendarMembers: React.Dispatch<React.SetStateAction<Map<string, string[]>>>;

  // ── Refs (consumed by CalendarContext for doRefresh and re-encryption) ──
  sharedKeysRef: React.MutableRefObject<Map<string, CryptoKey>>;
  sharedKeysLoadedAtRef: React.MutableRefObject<number>;
  keyRotatingRef: React.MutableRefObject<boolean>;

  // ── Key loading ────────────────────────────────────────────────────
  /** Load shared keys from Nostr relay (own backups, member lists, invitations). */
  loadSharedKeysFromNostr: (force?: boolean) => Promise<Map<string, CryptoKey>>;

  // ── Helpers ────────────────────────────────────────────────────────
  /** True if the calendar has a shared AES key (owned or member). */
  isSharedCalendar: (calDTag: string) => boolean;
  /** True if the calendar is shared AND we are the owner (not a member). */
  isOwnedSharedCalendar: (calDTag: string) => boolean;
  /** Look up the AES shared key for a set of calendar refs. */
  getSharedKeyForCalendars: (calendarRefs: string[]) => { key: CryptoKey; calDTag: string } | null;

  // ── Member operations ──────────────────────────────────────────────
  /** Add a member to a shared calendar and distribute the AES key via NIP-44. */
  addMember: (calDTag: string, memberPubkey: string) => Promise<void>;

  // ── Invite link ────────────────────────────────────────────────────
  /** Generate an invite URL for a shared calendar. */
  getInviteLink: (calDTag: string, calendars: CalendarCollection[]) => Promise<string>;
  /** Accept an invite link and store the shared calendar owner mapping. */
  acceptInviteLink: (encoded: string) => Promise<{ calDTag: string; title: string }>;
  /** Accept a pending invitation: import its key and record durable consent. */
  acceptInvitation: (calDTag: string) => Promise<void>;
  /** Reject a pending invitation: record durable refusal so it never reappears. */
  rejectInvitation: (calDTag: string) => void;

  // ── Leave / cleanup ────────────────────────────────────────────────
  /** Leave a shared calendar we are a member of and clean up local state. */
  leaveSharedCalendar: (calDTag: string) => Promise<void>;
}

const SharingContext = createContext<SharingContextValue | null>(null);

export function useSharing() {
  const ctx = useContext(SharingContext);
  if (!ctx)
    throw new Error("useSharing must be used within SharingProvider");
  return ctx;
}

const log = logger("sharing");

export function SharingProvider({ children }: { children: ReactNode }) {
  const { pubkey, relays, signEvent, publishEvent, signer } = useNostr();

  // ── Sharing state (in-memory keys, never persisted plaintext) ──────
  // calDTag -> AES-256-GCM CryptoKey (for both owned and member calendars)
  const [sharedKeys, setSharedKeys] = useState<Map<string, CryptoKey>>(new Map());
  // calDTag -> ownerPubkey (for shared calendars we're a *member* of, not owner)
  const [sharedCalOwners, setSharedCalOwners] = useState<Map<string, string>>(
    () => (pubkey ? loadSharedCalOwners(pubkey) : new Map())
  );
  // calDTag -> member pubkeys (only for calendars we own + have shared)
  const [calendarMembers, setCalendarMembers] = useState<Map<string, string[]>>(new Map());
  // Incoming invitations from owners the user hasn't consented to yet.
  const [pendingInvitations, setPendingInvitations] = useState<PendingInvitation[]>([]);

  // Cache shared keys — skip re-fetch if loaded within TTL
  const sharedKeysLoadedAtRef = useRef<number>(0);

  // Stable ref for data that doRefresh reads — avoids including mutable state
  // in its useCallback dep array while still giving it the latest values.
  const sharedKeysRef = useRef<Map<string, CryptoKey>>(new Map());

  // Guard: doRefresh bails if a key-rotation operation is in progress to avoid
  // decrypting events with the new key before old events are replaced on relays.
  const keyRotatingRef = useRef(false);

  // Keep stable ref in sync with state
  useEffect(() => { sharedKeysRef.current = sharedKeys; }, [sharedKeys]);

  // Clear shared keys from memory on logout to prevent stale key material
  // lingering in RAM. CryptoKey objects can't be explicitly zeroed (Web Crypto
  // API limitation), but dereferencing them allows GC to reclaim the memory.
  // Intentional synchronous setState on logout: resetting key material when
  // the user logs out is a security requirement, not a derived computation.
  useEffect(() => {
    if (!pubkey) {
      /* eslint-disable react-hooks/set-state-in-effect */
      setSharedKeys(new Map());
      setSharedCalOwners(new Map());
      setCalendarMembers(new Map());
      setPendingInvitations([]);
      /* eslint-enable react-hooks/set-state-in-effect */
      sharedKeysRef.current = new Map();
      sharedKeysLoadedAtRef.current = 0;
    }
  }, [pubkey]);

  // ── Sharing helpers ────────────────────────────────────────────────

  const isSharedCalendar = useCallback(
    (calDTag: string) => sharedKeys.has(calDTag),
    [sharedKeys]
  );

  const isOwnedSharedCalendar = useCallback(
    (calDTag: string) => sharedKeys.has(calDTag) && !sharedCalOwners.has(calDTag),
    [sharedKeys, sharedCalOwners]
  );

  const getSharedKeyForCalendars = useCallback(
    (calendarRefs: string[]): { key: CryptoKey; calDTag: string } | null => {
      for (const ref of calendarRefs) {
        const key = sharedKeys.get(ref);
        if (key) return { key, calDTag: ref };
      }
      return null;
    },
    [sharedKeys]
  );

  // ── Load shared keys from Nostr ────────────────────────────────────

  const loadSharedKeysFromNostr = useCallback(async (force = false): Promise<Map<string, CryptoKey>> => {
    if (!pubkey || !isNip44Available(signer)) return sharedKeysRef.current;
    // Skip if loaded recently (unless forced, e.g. from sharing modal)
    if (!force && Date.now() - sharedKeysLoadedAtRef.current < SHARED_KEYS_TTL_MS) return sharedKeysRef.current;

    // Single query for own key backups + member lists (halves relay traffic
    // vs the old pattern of two independent kind 30078 queries).
    const [{ keyBackups: ownKeyMap, memberLists: memberListMap }, inviteMap] = await Promise.all([
      fetchOwnKeyData({ pubkey, relays, nip44: signer!.nip44 }),
      fetchMyInvitations({ pubkey, relays, nip44: signer!.nip44 }),
    ]);

    const newKeys = new Map<string, CryptoKey>();
    const newOwners = loadSharedCalOwners(pubkey);

    // Own key backups (calendars we own or accepted via link)
    for (const [calDTag, keyBase64] of ownKeyMap) {
      try {
        const key = await importKeyFromBase64(keyBase64);
        newKeys.set(calDTag, key);
      } catch (err) {
        log.warn("failed to import key for calendar", calDTag, err);
      }
    }

    // Invitations from other owners. CONSENT GATE: a key envelope encrypted
    // to us only proves someone sent it — not that we agreed to join. Only
    // auto-import invitations we've explicitly accepted before (durable
    // consent, or an invite link we opened). Everything else is surfaced as a
    // pending invitation for an explicit decision; rejected ones are dropped.
    const pending: PendingInvitation[] = [];
    for (const [calDTag, { ownerPubkey, keyBase64 }] of inviteMap) {
      if (isRejectedShare(pubkey, ownerPubkey, calDTag)) continue;
      if (isAcceptedShare(pubkey, ownerPubkey, calDTag)) {
        try {
          const key = await importKeyFromBase64(keyBase64);
          newKeys.set(calDTag, key);
          newOwners.set(calDTag, ownerPubkey);
          saveSharedCalOwner(pubkey, calDTag, ownerPubkey);
        } catch (err) {
          log.warn("failed to import invite key for calendar", calDTag, err);
        }
      } else {
        pending.push({ calDTag, ownerPubkey, keyBase64 });
      }
    }

    sharedKeysRef.current = newKeys;
    setSharedKeys(newKeys);
    setSharedCalOwners(newOwners);
    setPendingInvitations(pending);
    sharedKeysLoadedAtRef.current = Date.now();

    // Member lists for calendars we own. MERGE rather than replace: a
    // transient empty fetch (flaky relay, NIP-42 not yet authed) must not wipe
    // the in-memory member lists for owned calendars — that would silently
    // un-share people and break key rotation on the next removeMember.
    setCalendarMembers((prev) => {
      if (memberListMap.size === 0) return prev;
      const next = new Map(prev);
      for (const [k, v] of memberListMap) next.set(k, v);
      return next;
    });
    return newKeys;
  }, [pubkey, relays, signer]);

  // ── Accept / reject a pending invitation ───────────────────────────

  const acceptInvitation = useCallback(
    async (calDTag: string) => {
      if (!pubkey) return;
      const inv = pendingInvitations.find((p) => p.calDTag === calDTag);
      if (!inv) return;
      const key = await importKeyFromBase64(inv.keyBase64);
      acceptShare(pubkey, inv.ownerPubkey, calDTag);
      saveSharedCalOwner(pubkey, calDTag, inv.ownerPubkey);
      setSharedKeys((prev) => {
        const next = new Map(prev).set(calDTag, key);
        sharedKeysRef.current = next;
        return next;
      });
      setSharedCalOwners((prev) => new Map(prev).set(calDTag, inv.ownerPubkey));
      setPendingInvitations((prev) => prev.filter((p) => p.calDTag !== calDTag));
    },
    [pubkey, pendingInvitations]
  );

  const rejectInvitation = useCallback(
    (calDTag: string) => {
      if (!pubkey) return;
      const inv = pendingInvitations.find((p) => p.calDTag === calDTag);
      if (inv) rejectShare(pubkey, inv.ownerPubkey, calDTag);
      setPendingInvitations((prev) => prev.filter((p) => p.calDTag !== calDTag));
    },
    [pubkey, pendingInvitations]
  );

  // ── Add member to shared calendar ─────────────────────────────────

  const addMember = useCallback(
    async (calDTag: string, memberPubkey: string) => {
      const sharedKey = sharedKeys.get(calDTag);
      if (!sharedKey) throw new Error("No shared key for this calendar");

      const keyBase64 = await exportKeyToBase64(sharedKey);

      // Distribute key to new member
      await publishKeyEnvelope({
        calDTag,
        memberPubkey,
        keyBase64,
        nip44: signer!.nip44,
        signEvent,
        publishEvent,
      });

      // Update member list
      const currentMembers = calendarMembers.get(calDTag) || [];
      if (!currentMembers.includes(memberPubkey)) {
        const newMembers = [...currentMembers, memberPubkey];
        setCalendarMembers((prev) => new Map(prev).set(calDTag, newMembers));
        await publishMemberList({
          ownerPubkey: pubkey!,
          calDTag,
          members: newMembers,
          nip44: signer!.nip44,
          signEvent,
          publishEvent,
        });
      }
    },
    [pubkey, signEvent, publishEvent, sharedKeys, calendarMembers, signer]
  );

  // ── Generate invite link ───────────────────────────────────────────

  const getInviteLink = useCallback(
    async (calDTag: string, calendars: CalendarCollection[]): Promise<string> => {
      if (!sharedKeys.has(calDTag)) throw new Error("No shared key for this calendar");
      const cal = calendars.find((c: CalendarCollection) => c.dTag === calDTag);
      const title = cal?.title || "Shared Calendar";

      // Invite payload no longer includes the raw key in the URL.
      // Key is only distributed via NIP-44 when the member is added by npub.
      const encoded = encodeInvitePayload({
        ownerPubkey: pubkey!,
        calDTag,
        title,
      });

      return `${window.location.origin}${window.location.pathname}#invite=${encoded}`;
    },
    [pubkey, sharedKeys]
  );

  // ── Accept invite link ────────────────────────────────────────────

  const acceptInviteLink = useCallback(
    async (encoded: string): Promise<{ calDTag: string; title: string }> => {
      const payload = decodeInvitePayload(encoded);
      if (!payload) throw new Error("Invalid invite link");
      if (!pubkey) throw new Error("Not logged in");

      const { o: ownerPubkey, c: calDTag, t: title } = payload;

      // Opening an invite link is an explicit act of consent — record it
      // durably so the owner's key envelope auto-imports (instead of landing
      // in the pending-invitations queue) on this and future sessions.
      acceptShare(pubkey, ownerPubkey, calDTag);
      // Key is never in the URL — it is distributed via NIP-44 when the owner
      // adds the member. Store the owner mapping so we know to look for key envelopes.
      setSharedCalOwners((prev) => new Map(prev).set(calDTag, ownerPubkey));
      saveSharedCalOwner(pubkey, calDTag, ownerPubkey);
      // If the envelope already arrived and is sitting in pending, clear it.
      setPendingInvitations((prev) => prev.filter((p) => p.calDTag !== calDTag));
      return { calDTag, title };
    },
    [pubkey]
  );

  // ── Leave shared calendar (member perspective) ─────────────────────

  const leaveSharedCalendar = useCallback(
    async (calDTag: string) => {
      if (!pubkey) return;

      // Remove from memory
      setSharedKeys((prev) => {
        const next = new Map(prev);
        next.delete(calDTag);
        return next;
      });
      setSharedCalOwners((prev) => {
        const next = new Map(prev);
        next.delete(calDTag);
        return next;
      });
      removeSharedCalOwner(pubkey, calDTag);

      // Delete own key backup from Nostr
      if (isNip44Available(signer)) {
        const coord = `30078:${pubkey}:${DTAG_CAL_KEY_PREFIX}${calDTag}`;
        try {
          const signed = await signEvent({
            kind: 5,
            created_at: Math.floor(Date.now() / 1000),
            tags: [["a", coord]],
            content: "left shared calendar",
          });
          await publishEvent(signed);
        } catch {
          // Best-effort
        }
      }
    },
    [pubkey, signEvent, publishEvent, signer]
  );

  const value: SharingContextValue = useMemo(() => ({
    sharedKeys,
    sharedCalOwners,
    calendarMembers,
    pendingInvitations,
    setSharedKeys,
    setSharedCalOwners,
    setCalendarMembers,
    sharedKeysRef,
    sharedKeysLoadedAtRef,
    keyRotatingRef,
    loadSharedKeysFromNostr,
    isSharedCalendar,
    isOwnedSharedCalendar,
    getSharedKeyForCalendars,
    addMember,
    getInviteLink,
    acceptInviteLink,
    acceptInvitation,
    rejectInvitation,
    leaveSharedCalendar,
  }), [sharedKeys, sharedCalOwners, calendarMembers, pendingInvitations, setSharedKeys, setSharedCalOwners, setCalendarMembers, loadSharedKeysFromNostr, isSharedCalendar, isOwnedSharedCalendar, getSharedKeyForCalendars, addMember, getInviteLink, acceptInviteLink, acceptInvitation, rejectInvitation, leaveSharedCalendar]);

  return (
    <SharingContext.Provider value={value}>
      {children}
    </SharingContext.Provider>
  );
}
