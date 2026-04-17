/**
 * CalendarContext — central state manager for the planner application.
 *
 * Responsibilities:
 *  - Stores and exposes all calendar events (`CalendarEvent[]`) and calendar
 *    collections (`CalendarCollection[]`).
 *  - Manages shared-calendar AES-256-GCM keys (in-memory only, never persisted
 *    as plaintext) and their distribution via NIP-44 key envelopes (kind 30078).
 *  - Handles encryption and decryption of events: NIP-44 for personal calendars,
 *    AES-256-GCM for shared calendars.
 *  - Provides full CRUD for events and calendars: create, rename, recolor, delete,
 *    move, reorder, and toggle visibility.
 *  - Implements sharing workflows: create shared calendar, add/remove members,
 *    generate/accept invite links, key rotation on member removal, and
 *    conversion of private calendars to shared.
 *  - Performs incremental relay sync via `doRefresh`, with a two-pass decrypt
 *    strategy (calendars first for fast UI, then events in parallel batches).
 *  - One-time migration cleanup of legacy unencrypted events.
 *
 * @module CalendarContext
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
import { useSettings } from "./SettingsContext";
import { useSharing } from "./SharingContext";
import {
  KIND_DATE_EVENT,
  KIND_TIME_EVENT,
  KIND_CALENDAR,
  KIND_APP_DATA,
  generateDTag,
  buildDateEventTags,
  buildTimeEventTags,
  CALENDAR_COLORS,
  formatDateTag,
  type CalendarEvent,
  type CalendarCollection,
} from "../lib/nostr";
import {
  isNip44Available,
  isEncryptedEvent,
  isSharedEncryptedEvent,
  encryptEvent,
  encryptEventWithSharedKey,
} from "../lib/crypto";
import {
  generateSharedKey,
  exportKeyToBase64,
  publishOwnKeyBackup,
  publishKeyEnvelope,
  publishMemberList,
  revokeKeyEnvelope,
  removeSharedCalOwner,
  loadSharedCalOwners,
} from "../lib/sharing";
import { queryEvents } from "../lib/relay";
import {
  filterCalendarAppData,
  buildDeletedCoords,
  decryptCalendarData,
} from "../lib/calendarSync";
import type { NostrSigner } from "../lib/signer";
import { logger } from "../lib/logger";
import { lsSet } from "../lib/storage";
import { cacheCalendarData } from "../lib/eventCache";

const log = logger("calendar");

type ViewMode = "month" | "week" | "day";

interface CalendarContextValue {
  /** All decrypted calendar events for the current user (personal + shared). */
  events: CalendarEvent[];
  /** Events filtered by which calendars are currently toggled active. */
  filteredEvents: CalendarEvent[];
  /** All calendar collections (personal + shared) the user can see. */
  calendars: CalendarCollection[];
  /** Set of calendar d-tags that are currently toggled visible in the UI. */
  activeCalendarIds: Set<string>;
  /** Alphabetically sorted list of all unique hashtags across events. */
  allTags: string[];
  /** Hashtags sorted by usage frequency (most-used first). */
  tagsByUsage: string[];
  /** True while events are being fetched and/or decrypted from relays. */
  eventsLoading: boolean;
  /** The date the calendar view is currently centered on. */
  currentDate: Date;
  /** Current calendar view mode: month, week, or day. */
  viewMode: ViewMode;
  /** Navigate the calendar view to a specific date. */
  setCurrentDate: (d: Date) => void;
  /** Switch between month / week / day view. */
  setViewMode: (m: ViewMode) => void;
  /** Toggle a calendar's visibility on/off by its d-tag. */
  toggleCalendar: (dTag: string) => void;
  /** Create a new personal (private) calendar. */
  createCalendar: (title: string, color?: string) => Promise<void>;
  /** Create a new shared calendar with AES-256-GCM encryption. */
  createSharedCalendar: (title: string, color?: string) => Promise<void>;
  /** Replace the event coordinate list on a calendar collection. */
  updateCalendarEvents: (calDTag: string, eventCoords: string[]) => Promise<void>;
  /** Return all events belonging to a recurring series, sorted by start date. */
  getSeriesEvents: (seriesId: string) => CalendarEvent[];
  /** Rename a calendar and re-publish to relays. */
  renameCalendar: (dTag: string, newTitle: string) => Promise<void>;
  /** Change a calendar's display color and re-publish to relays. */
  recolorCalendar: (dTag: string, newColor: string) => Promise<void>;
  /** Delete a calendar and publish a kind-5 deletion event. */
  deleteCalendar: (dTag: string) => Promise<void>;
  /** Reorder calendars in the sidebar (local-only, not persisted to relays). */
  reorderCalendars: (orderedDTags: string[]) => void;
  /** Trigger an incremental refresh from relays (debounced). */
  refreshEvents: () => Promise<void>;
  /** Reset the `since` cursor and do a full re-fetch from relays. */
  forceFullRefresh: () => Promise<void>;
  /** Delete an event optimistically and publish a kind-5 deletion. */
  deleteEvent: (event: CalendarEvent) => Promise<void>;
  /** Move an event to a new start time, preserving duration, and re-publish. */
  moveEvent: (event: CalendarEvent, newStart: Date) => Promise<void>;
  // ── Sharing (operations that need calendar UI state) ──
  /** Remove a member, revoke their key, rotate the AES key, and re-encrypt. */
  removeMember: (calDTag: string, memberPubkey: string) => Promise<void>;
  /** Convert an existing private calendar into a shared calendar. */
  convertToShared: (calDTag: string) => Promise<void>;
  /** Leave a shared calendar: key cleanup (SharingContext) + UI removal. */
  leaveSharedCalendarAndCleanup: (calDTag: string) => Promise<void>;
  /** Add an event to state immediately (before relay confirmation). */
  addEventOptimistic: (event: CalendarEvent) => void;
  /** Replace in-memory calendar state wholesale. Called on snapshot restore. */
  applySnapshot: (events: CalendarEvent[], calendars: CalendarCollection[]) => void;
  /** sha256 of the Blossom snapshot this tab last loaded or saved. Consumed
   *  by useAutoBackup to detect concurrent writes from other devices. */
  lastRemoteSha: string | null;
  setLastRemoteSha: (sha: string | null) => void;
  /** True when the user has no calendars and needs to create their first one. */
  needsCalendarSetup: boolean;
  /** Create the user's first calendar during onboarding. */
  completeCalendarSetup: (name: string) => Promise<void>;
  /** Number of events that failed to decrypt in the last refresh. */
  decryptionErrors: number;
  /** Error message from the last failed relay sync, or null if healthy. */
  syncError: string | null;
}

const CalendarContext = createContext<CalendarContextValue | null>(null);

export function useCalendar() {
  const ctx = useContext(CalendarContext);
  if (!ctx)
    throw new Error("useCalendar must be used within CalendarProvider");
  return ctx;
}

// ── Helper: sign+publish with optional encryption ──────────────────────

/**
 * Sign and publish a Nostr event with an encryption decision tree:
 *
 * 1. If `sharedKey` + `sharedCalDTag` are provided, encrypt the event payload
 *    with AES-256-GCM (symmetric shared calendar encryption). The original
 *    kind is stored inside the ciphertext, and the published kind becomes
 *    KIND_APP_DATA (30078) with a `shared-cal` tag for routing.
 *
 * 2. Else if `encrypt` is true and a NIP-44-capable `signer` is available,
 *    encrypt the payload with NIP-44 (asymmetric, user-to-self). The original
 *    kind is likewise wrapped inside KIND_APP_DATA.
 *
 * 3. Otherwise, publish as plaintext with the original kind. This path is only
 *    taken for explicitly public calendars.
 *
 * After encryption (or not), the event is signed via the signer and published
 * to the user's relay set.
 */
type SignedNostrEvent = {
  id: string; pubkey: string; created_at: number; kind: number;
  tags: string[][]; content: string; sig: string;
};
type SignEventFn = (e: { kind: number; created_at: number; tags: string[][]; content: string }) => Promise<SignedNostrEvent>;
type PublishEventFn = (e: SignedNostrEvent) => Promise<void>;

/** Encrypt and sign an event, returning the signed event without publishing it.
 *  Used by bulk re-encryption flows so signing is sequential (preserving NIP-07
 *  UX) but publishing can be batched in parallel afterward. */
async function prepareSignedEvent(
  pubkey: string,
  kind: number,
  tags: string[][],
  content: string,
  encrypt: boolean,
  signEvent: SignEventFn,
  signer: NostrSigner | null,
  sharedKey?: CryptoKey,
  sharedCalDTag?: string
): Promise<SignedNostrEvent> {
  const dTag = tags.find((t) => t[0] === "d")?.[1] || generateDTag();
  let finalTags = tags;
  let finalContent = content;
  let finalKind = kind;

  if (sharedKey && sharedCalDTag) {
    const encrypted = await encryptEventWithSharedKey(sharedKey, sharedCalDTag, kind, dTag, tags, content);
    finalTags = encrypted.tags;
    finalContent = encrypted.content;
    finalKind = encrypted.kind;
  } else if (encrypt && signer) {
    const encrypted = await encryptEvent(pubkey, kind, dTag, tags, content, signer);
    finalTags = encrypted.tags;
    finalContent = encrypted.content;
    finalKind = encrypted.kind;
  }

  return signEvent({
    kind: finalKind,
    created_at: Math.floor(Date.now() / 1000),
    tags: finalTags,
    content: finalContent,
  });
}

async function signAndPublish(
  pubkey: string,
  kind: number,
  tags: string[][],
  content: string,
  encrypt: boolean,
  signEvent: SignEventFn,
  publishEvent: PublishEventFn,
  signer: NostrSigner | null,
  sharedKey?: CryptoKey,
  sharedCalDTag?: string
) {
  const signed = await prepareSignedEvent(pubkey, kind, tags, content, encrypt, signEvent, signer, sharedKey, sharedCalDTag);
  await publishEvent(signed);
}

/** Build the full NIP-52 tag array from a CalendarEvent (shared by move, convert, re-encrypt). */
function buildEventTags(e: CalendarEvent): string[][] {
  if (e.allDay) {
    return buildDateEventTags({
      dTag: e.dTag, title: e.title,
      startDate: formatDateTag(e.start),
      endDate: e.end ? formatDateTag(e.end) : undefined,
      location: e.location, link: e.link,
      hashtags: e.hashtags.length > 0 ? e.hashtags : undefined,
      calendarRefs: e.calendarRefs.length > 0 ? e.calendarRefs : undefined,
      seriesId: e.seriesId, notify: e.notify,
      recurrence: e.recurrence,
    });
  }
  return buildTimeEventTags({
    dTag: e.dTag, title: e.title,
    startUnix: Math.floor(e.start.getTime() / 1000),
    endUnix: e.end ? Math.floor(e.end.getTime() / 1000) : undefined,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    location: e.location, link: e.link,
    hashtags: e.hashtags.length > 0 ? e.hashtags : undefined,
    calendarRefs: e.calendarRefs.length > 0 ? e.calendarRefs : undefined,
    seriesId: e.seriesId, notify: e.notify,
    recurrence: e.recurrence,
  });
}

// ── Provider ──────────────────────────────────────────────────────────

export function CalendarProvider({ children }: { children: ReactNode }) {
  const { pubkey, relays, signEvent, publishEvent, signer } = useNostr();
  const { shouldEncrypt, canPublish } = useSettings();
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [calendars, setCalendars] = useState<CalendarCollection[]>([]);
  const [activeCalendarIds, setActiveCalendarIds] = useState<Set<string>>(
    new Set()
  );
  const [eventsLoading, setEventsLoading] = useState(true);
  const [lastRemoteSha, setLastRemoteSha] = useState<string | null>(null);
  const [deletedDTags, setDeletedDTags] = useState<Set<string>>(new Set());
  const [currentDate, setCurrentDate] = useState(new Date());
  const [viewMode, setViewMode] = useState<ViewMode>("month");
  const [needsCalendarSetup, setNeedsCalendarSetup] = useState(false);
  const [decryptionErrors, setDecryptionErrors] = useState(0);
  const [syncError, setSyncError] = useState<string | null>(null);

  // ── Sharing state (from SharingContext) ──────────────────────────
  const {
    sharedKeys,
    calendarMembers,
    setSharedKeys,
    setCalendarMembers,
    sharedKeysRef,
    keyRotatingRef,
    loadSharedKeysFromNostr,
    getSharedKeyForCalendars,
    leaveSharedCalendar,
  } = useSharing();

  // Track last fetch time for incremental sync
  const lastFetchRef = useRef<number>(0);
  const eventsRef = useRef<CalendarEvent[]>([]);
  const calendarsRef = useRef<CalendarCollection[]>([]);
  const deletedDTagsRef = useRef<Set<string>>(new Set());
  /** Guard so detached async work (e.g. migration cleanup) stops if the provider unmounts. */
  const mountedRef = useRef(true);
  // Debounce rapid refresh calls
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshPromiseRef = useRef<Promise<void> | null>(null);
  /** Guard against concurrent doRefresh calls (e.g. effect + manual trigger). */
  const refreshingRef = useRef(false);
  /** Stable ref to the latest doRefresh so the login effect always calls the
   *  current version without needing doRefresh in its dependency array. */
  const doRefreshRef = useRef<() => Promise<void>>(() => Promise.resolve());

  const allTags = useMemo(() => {
    const tagSet = new Set<string>();
    for (const e of events) {
      for (const t of e.hashtags) tagSet.add(t);
    }
    return [...tagSet].sort();
  }, [events]);

  const tagsByUsage = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of events) {
      for (const t of e.hashtags) counts.set(t, (counts.get(t) || 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([tag]) => tag);
  }, [events]);

  // Clear mountedRef on unmount so detached async work (migration cleanup) bails out.
  useEffect(() => () => { mountedRef.current = false; }, []);

  // Keep stable refs in sync with state so doRefresh can read latest values
  // without closing over the state (which would add them to its dep array).
  useEffect(() => { eventsRef.current = events; }, [events]);
  useEffect(() => { calendarsRef.current = calendars; }, [calendars]);
  useEffect(() => { deletedDTagsRef.current = deletedDTags; }, [deletedDTags]);

  // Re-load deletedDTags from localStorage whenever the logged-in user changes.
  // The useState initialiser only runs once on mount; without this effect, if
  // user A logs out and user B logs in within the same session, user A's
  // deletion set would shadow user B's events.
  useEffect(() => {
    if (!pubkey) {
      setDeletedDTags(new Set());
      return;
    }
    try {
      // Use sessionStorage for ephemeral deletion cache (kind 5 events on relays
      // are the canonical source; this is just a client-side hint). Falls back to
      // localStorage for migration from older versions.
      const raw = sessionStorage.getItem(`nostr-planner-deleted-${pubkey}`)
        || localStorage.getItem(`nostr-planner-deleted-${pubkey}`);
      setDeletedDTags(raw ? new Set(JSON.parse(raw)) : new Set());
    } catch {
      setDeletedDTags(new Set());
    }
  }, [pubkey]);

  const defaultCalendarId = calendars.length > 0 ? calendars[0].dTag : null;

  const filteredEvents = useMemo(() => {
    if (calendars.length === 0) return events;
    return events.filter((e) => {
      if (e.calendarRefs.length === 0) {
        return defaultCalendarId
          ? activeCalendarIds.has(defaultCalendarId)
          : true;
      }
      return e.calendarRefs.some((ref) => activeCalendarIds.has(ref));
    });
  }, [events, calendars, activeCalendarIds, defaultCalendarId]);

  // ── Refresh ────────────────────────────────────────────────────────

  const doRefresh = useCallback(async () => {
    if (!pubkey) return;
    // Skip refresh while a key-rotation is in progress: events are being
    // re-encrypted with the new key and publishing to relays. A refresh now
    // would attempt to decrypt with the new in-memory key against old ciphertext
    // still on the relay, causing spurious decryption errors.
    if (keyRotatingRef.current) {
      log.debug("skipping refresh — key rotation in progress");
      return;
    }
    // Prevent concurrent refresh calls (e.g. useEffect + manual trigger racing)
    if (refreshingRef.current) {
      log.debug("skipping refresh — already in progress");
      return;
    }
    refreshingRef.current = true;
    const isFirstLoad = lastFetchRef.current === 0 && calendarsRef.current.length === 0;
    setEventsLoading(true);
    setSyncError(null);
    log.time("refresh");

    try {
      // ── Phase 1: Load shared keys ──────────────────────────────────
      // Fetch/refresh AES-256-GCM shared calendar keys from Nostr
      // (own key backups, member lists, and incoming invitations).
      // Must complete before decryption so all keys are available.
      // Returns the freshly loaded keys directly so the decryption passes
      // below always use the latest keys, not a potentially stale state snapshot.
      const freshKeys = await loadSharedKeysFromNostr();
      log.debug("shared keys loaded");

      // Read current sharedCalOwners from localStorage (may have been updated above)
      const currentOwners = loadSharedCalOwners(pubkey);
      const foreignOwners = [...new Set(currentOwners.values())].filter(
        (o) => o !== pubkey
      );

      const sinceFilter = lastFetchRef.current > 0
        ? { since: lastFetchRef.current - 60 }
        : {};

      // ── Phase 2: Parallel relay queries ─────────────────────────────
      // Three queries run concurrently:
      //   a) Plaintext NIP-52 calendar kinds (31922, 31923, 31924)
      //   b) Kind 30078 app-data (contains NIP-44 or AES-GCM encrypted events)
      //   c) Kind 5 deletion events
      // All queries are scoped to the user + any shared-calendar foreign owners.
      const authorList = [pubkey, ...foreignOwners];
      const [rawCalendarEvents, rawAppData, rawDeletions] = await Promise.all([
        queryEvents(relays, {
          kinds: [KIND_DATE_EVENT, KIND_TIME_EVENT, KIND_CALENDAR],
          authors: authorList,
          ...sinceFilter,
        }),
        queryEvents(relays, {
          kinds: [KIND_APP_DATA],
          authors: authorList,
          ...sinceFilter,
        }),
        queryEvents(relays, {
          kinds: [5],
          authors: authorList,
          ...sinceFilter,
        }),
      ]);

      log.debug("relay query complete:", rawCalendarEvents.length, "plaintext,", rawAppData.length, "app-data,", rawDeletions.length, "deletions");

      // ── Phase 3: Filter non-calendar app-data ─────────────────────
      const rawEvents = [
        ...rawCalendarEvents,
        ...filterCalendarAppData(rawAppData),
      ];

      log.debug("after filtering:", rawEvents.length, "candidate events");
      lastFetchRef.current = Math.floor(Date.now() / 1000);

      // ── Phase 4: Remove deleted events ────────────────────────────
      const deletedCoords = buildDeletedCoords(rawDeletions, deletedDTagsRef.current);

      // ── Phase 5+6: Two-pass decrypt (calendars first, then events) ──
      // Treat as incremental whenever we have any in-memory state (e.g.
      // from IndexedDB or the Blossom materialized snapshot) so the relay
      // refresh MERGES onto that state rather than wiping it. Private
      // calendar events are Blossom-authoritative and never appear in
      // `rawEvents` — without the merge, every refresh would nuke them.
      const hasPriorState = eventsRef.current.length > 0 || calendarsRef.current.length > 0;
      const decryptResult = await decryptCalendarData({
        rawEvents,
        deletedCoords,
        pubkey,
        signer,
        sharedKeys: freshKeys,
        existingEvents: eventsRef.current,
        existingCalendars: calendarsRef.current,
        isIncremental: !!sinceFilter.since || hasPriorState,
      });

      if (decryptResult.calendars.length > 0) {
        setCalendars(decryptResult.calendars);
        setActiveCalendarIds(new Set(decryptResult.calendars.map((c) => c.dTag)));
      } else if (isFirstLoad && decryptResult.decryptErrors === 0) {
        // Only prompt for calendar setup if we truly found zero calendars AND
        // decryption didn't fail. If decrypt errors > 0, encrypted calendars
        // may exist but we couldn't read them (e.g. remote signer timeout).
        setNeedsCalendarSetup(true);
      }
      setDecryptionErrors(decryptResult.decryptErrors);
      setEvents(decryptResult.events);
      setEventsLoading(false);

      // Persist to IndexedDB for offline access on next load
      void cacheCalendarData(pubkey, decryptResult.events, decryptResult.calendars.length > 0 ? decryptResult.calendars : calendarsRef.current);

      // ── Phase 7: Migration cleanup ────────────────────────────────
      // One-time migration: delete old unencrypted events from relays (fire-and-forget).
      // Publishes kind-5 deletions for any plaintext NIP-52 events that now
      // exist in encrypted form, preventing schedule leaks on public relays.
      // localStorage is only marked done AFTER the loop completes so that
      // an interrupted cleanup (tab close, network failure) will be retried.
      const cleanupKey = `planner-cleaned-unencrypted-${pubkey}`;
      if (!localStorage.getItem(cleanupKey)) {
        const staleEvents = rawEvents.filter((e) => {
          if (e.pubkey !== pubkey) return false;
          if (isEncryptedEvent(e.tags) || isSharedEncryptedEvent(e.tags)) return false;
          return e.kind === KIND_DATE_EVENT || e.kind === KIND_TIME_EVENT || e.kind === KIND_CALENDAR;
        });
        (async () => {
          // Filter to events that need deletion
          const toDelete = staleEvents.filter((e) => {
            const eTag = e.tags.find((t) => t[0] === "d")?.[1];
            if (!eTag) return false;
            if (e.kind === KIND_CALENDAR && decryptResult.calendars.some((c) => c.dTag === eTag)) return false;
            if (e.kind !== KIND_CALENDAR) {
              const hasEncryptedVersion = decryptResult.events.some((de) => de.dTag === eTag);
              if (!hasEncryptedVersion) return false;
            }
            return true;
          });

          // Sign sequentially (NIP-07 needs one popup at a time), then publish in batches
          const signed: SignedNostrEvent[] = [];
          for (const e of toDelete) {
            if (!mountedRef.current) return;
            const eTag = e.tags.find((t) => t[0] === "d")![1];
            try {
              signed.push(await signEvent({
                kind: 5,
                created_at: Math.floor(Date.now() / 1000),
                tags: [["a", `${e.kind}:${pubkey}:${eTag}`]],
                content: "cleanup: remove old unencrypted event",
              }));
            } catch (err) {
              log.warn("migration cleanup: failed to sign deletion for", eTag, err);
            }
          }
          if (!mountedRef.current) return;

          // Publish in parallel batches of 10
          let cleaned = 0;
          const BATCH = 10;
          for (let i = 0; i < signed.length; i += BATCH) {
            if (!mountedRef.current) return;
            const batch = signed.slice(i, i + BATCH);
            const results = await Promise.allSettled(batch.map((s) => publishEvent(s)));
            cleaned += results.filter((r) => r.status === "fulfilled").length;
          }

          if (!mountedRef.current) return;
          lsSet(cleanupKey, "1");
          if (cleaned > 0) log.debug("migration cleanup: deleted", cleaned, "stale plaintext events");
        })();
      }
      log.timeEnd("refresh");
    } catch (err) {
      log.error("refresh failed", err);
      setSyncError(`Relay sync failed: ${err instanceof Error ? err.message : String(err)}`);
      setEventsLoading(false);
      log.timeEnd("refresh");
    } finally {
      refreshingRef.current = false;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- refs/setters from useSharing are stable
  }, [pubkey, relays, signer, signEvent, publishEvent, loadSharedKeysFromNostr]);

  // Keep the ref in sync so the login effect always calls the latest doRefresh
  useEffect(() => { doRefreshRef.current = doRefresh; }, [doRefresh]);

  // Pending resolve/reject from the most recent debounced caller, so clearing the
  // timer can resolve it immediately instead of leaving a hanging Promise.
  const pendingResolveRef = useRef<{ resolve: () => void; reject: (e: unknown) => void } | null>(null);

  const refreshEvents = useCallback(async () => {
    // If a debounce timer is pending, resolve the previous caller immediately
    // (the new caller supersedes it) to avoid hanging Promises.
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current);
      pendingResolveRef.current?.resolve();
      pendingResolveRef.current = null;
    }
    return new Promise<void>((resolve, reject) => {
      pendingResolveRef.current = { resolve, reject };
      refreshTimerRef.current = setTimeout(async () => {
        pendingResolveRef.current = null;
        if (refreshPromiseRef.current) {
          try { await refreshPromiseRef.current; resolve(); } catch (err) { reject(err); }
          return;
        }
        const p = doRefresh();
        refreshPromiseRef.current = p;
        try { await p; resolve(); } catch (err) { reject(err); } finally { refreshPromiseRef.current = null; }
      }, 500);
    });
  }, [doRefresh]);

  // ── Delete event ───────────────────────────────────────────────────

  const MAX_DELETED_TAGS = 5000;

  const persistDeletion = useCallback(
    (dTag: string) => {
      setDeletedDTags((prev) => {
        const next = new Set(prev);
        next.add(dTag);
        // Cap the set to prevent unbounded sessionStorage growth
        if (next.size > MAX_DELETED_TAGS) {
          const arr = [...next];
          const trimmed = arr.slice(arr.length - MAX_DELETED_TAGS);
          const capped = new Set(trimmed);
          if (pubkey) {
            try { sessionStorage.setItem(`nostr-planner-deleted-${pubkey}`, JSON.stringify([...capped])); } catch {}
          }
          return capped;
        }
        if (pubkey) {
          try { sessionStorage.setItem(`nostr-planner-deleted-${pubkey}`, JSON.stringify([...next])); } catch {}
        }
        return next;
      });
    },
    [pubkey]
  );

  const deleteEvent = useCallback(
    async (event: CalendarEvent) => {
      persistDeletion(event.dTag);
      setEvents((prev) => prev.filter((e) => e.dTag !== event.dTag));

      const sharedKey = getSharedKeyForCalendars(event.calendarRefs);
      const isPrivate = !sharedKey && shouldEncrypt(event.calendarRefs);
      // Private events only ever lived in the Blossom blob; removing them from
      // in-memory state + letting auto-backup snapshot the new state is all
      // that's needed. No kind-5 deletion event to publish to relays.
      if (isPrivate) return;

      // Encrypted (shared) events are published as kind 30078 (KIND_APP_DATA)
      // regardless of their original NIP-52 kind. The deletion a-tag must
      // reference the *published* kind so relays can match and delete it.
      const publishedKind = sharedKey ? KIND_APP_DATA : event.kind;
      const tags: string[][] = [
        ["a", `${publishedKind}:${event.pubkey}:${event.dTag}`],
        ["reason", "user-deleted"],
      ];
      if (publishedKind !== event.kind) {
        tags.push(["a", `${event.kind}:${event.pubkey}:${event.dTag}`]);
      }
      const signed = await signEvent({
        kind: 5,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: "deleted",
      });
      await publishEvent(signed);
    },
    [signEvent, publishEvent, persistDeletion, shouldEncrypt, getSharedKeyForCalendars]
  );

  // ── Move event ─────────────────────────────────────────────────────

  const moveEvent = useCallback(
    async (event: CalendarEvent, newStart: Date) => {
      const duration = event.end
        ? event.end.getTime() - event.start.getTime()
        : 0;
      const newEnd = duration ? new Date(newStart.getTime() + duration) : undefined;

      setEvents((prev) =>
        prev.map((e) =>
          e.dTag === event.dTag ? { ...e, start: newStart, end: newEnd } : e
        )
      );

      const sharedKeyInfo = getSharedKeyForCalendars(event.calendarRefs);
      const isPrivate = !sharedKeyInfo && shouldEncrypt(event.calendarRefs);
      // Private events live only in the Blossom blob. The setEvents call
      // above flips the in-memory state; auto-backup snapshots the new
      // coordinates on its debounce. No relay publish needed.
      if (isPrivate) return;

      const content = event.content;
      const movedEvent = { ...event, start: newStart, end: newEnd };
      const tags = buildEventTags(movedEvent);

      await signAndPublish(
        pubkey!,
        event.kind,
        tags,
        content,
        false,
        signEvent,
        publishEvent,
        signer,
        sharedKeyInfo?.key,
        sharedKeyInfo?.calDTag
      );
    },
    [pubkey, signEvent, publishEvent, shouldEncrypt, getSharedKeyForCalendars, signer]
  );

  // ── Series events ──────────────────────────────────────────────────

  const getSeriesEvents = useCallback(
    (seriesId: string) => {
      return events
        .filter((e) => e.seriesId === seriesId)
        .sort((a, b) => a.start.getTime() - b.start.getTime());
    },
    [events]
  );

  const addEventOptimistic = useCallback((ev: CalendarEvent) => {
    setEvents((prev) => {
      const key = `${ev.kind}:${ev.pubkey}:${ev.dTag}`;
      const filtered = prev.filter((e) => `${e.kind}:${e.pubkey}:${e.dTag}` !== key);
      return [...filtered, ev];
    });
  }, []);

  const applySnapshot = useCallback((evs: CalendarEvent[], cals: CalendarCollection[]) => {
    setEvents(evs);
    setCalendars(cals);
    setActiveCalendarIds(new Set(cals.map((c) => c.dTag)));
    setEventsLoading(false);
  }, []);

  // ── Calendar toggle ────────────────────────────────────────────────

  const toggleCalendar = useCallback((dTag: string) => {
    setActiveCalendarIds((prev) => {
      const next = new Set(prev);
      if (next.has(dTag)) next.delete(dTag);
      else next.add(dTag);
      return next;
    });
  }, []);

  // ── Create calendar (personal, private) ───────────────────────────

  const createCalendar = useCallback(
    async (title: string, color?: string) => {
      if (!canPublish()) throw new Error("Publishing not available");

      const dTag = generateDTag();
      const calColor = color || CALENDAR_COLORS[calendars.length % CALENDAR_COLORS.length];

      setCalendars((prev) => [...prev, { dTag, title, eventRefs: [], color: calColor }]);
      setActiveCalendarIds((prev) => new Set([...prev, dTag]));

      const tags = [["d", dTag], ["title", title], ["color", calColor]];
      await signAndPublish(
        pubkey!,
        KIND_CALENDAR,
        tags,
        "",
        shouldEncrypt([]),
        signEvent,
        publishEvent,
        signer
      );
    },
    [pubkey, signEvent, publishEvent, calendars.length, shouldEncrypt, canPublish, signer]
  );

  // ── Complete first-login calendar setup ─────────────────────────────

  const completeCalendarSetup = useCallback(
    async (name: string) => {
      if (!canPublish()) throw new Error("Publishing not available");

      const dTag = generateDTag();
      const color = CALENDAR_COLORS[0];
      const title = name.trim() || "My Calendar";

      setCalendars([{ dTag, title, eventRefs: [], color }]);
      setActiveCalendarIds(new Set([dTag]));
      setNeedsCalendarSetup(false);

      const tags = [["d", dTag], ["title", title], ["color", color]];
      const nip44Ok = isNip44Available(signer);
      try {
        await signAndPublish(pubkey!, KIND_CALENDAR, tags, "", nip44Ok, signEvent, publishEvent, signer);
      } catch (err) {
        log.warn("setup calendar publish failed", err);
      }
    },
    [pubkey, signEvent, publishEvent, canPublish, signer]
  );

  // ── Create shared calendar ─────────────────────────────────────────

  const createSharedCalendar = useCallback(
    async (title: string, color?: string) => {
      if (!canPublish()) throw new Error("Publishing not available");
      if (!isNip44Available(signer)) throw new Error("NIP-44 required for shared calendars");

      const dTag = generateDTag();
      const calColor = color || CALENDAR_COLORS[calendars.length % CALENDAR_COLORS.length];

      // Generate AES-256-GCM key for this calendar
      const sharedKey = await generateSharedKey();
      const keyBase64 = await exportKeyToBase64(sharedKey);

      // Store key in memory
      setSharedKeys((prev) => new Map(prev).set(dTag, sharedKey));

      // Optimistic UI update
      setCalendars((prev) => [...prev, { dTag, title, eventRefs: [], color: calColor }]);
      setActiveCalendarIds((prev) => new Set([...prev, dTag]));

      // Publish own key backup (NIP-44 to self)
      await publishOwnKeyBackup({
        ownerPubkey: pubkey!,
        calDTag: dTag,
        keyBase64,
        nip44: signer!.nip44,
        signEvent,
        publishEvent,
      });

      // Publish the calendar collection event (AES-GCM encrypted)
      const tags = [["d", dTag], ["title", title], ["color", calColor]];
      await signAndPublish(
        pubkey!,
        KIND_CALENDAR,
        tags,
        "",
        false, // don't NIP-44 encrypt — we use AES-GCM via sharedKey below
        signEvent,
        publishEvent,
        signer,
        sharedKey,
        dTag
      );

      // Initialize empty member list
      await publishMemberList({
        ownerPubkey: pubkey!,
        calDTag: dTag,
        members: [],
        nip44: signer!.nip44,
        signEvent,
        publishEvent,
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setSharedKeys is a stable setter from useSharing
    [pubkey, signEvent, publishEvent, calendars.length, canPublish, signer]
  );

  // ── Convert existing private calendar to shared ──────────────────

  const convertToShared = useCallback(
    async (calDTag: string) => {
      if (!pubkey) throw new Error("Not logged in");
      if (!canPublish()) throw new Error("Publishing not available");
      if (!isNip44Available(signer)) throw new Error("NIP-44 required for shared calendars");
      if (sharedKeysRef.current.has(calDTag)) throw new Error("Calendar is already shared");

      const cal = calendarsRef.current.find((c) => c.dTag === calDTag);
      if (!cal) throw new Error("Calendar not found");

      // 1. Generate AES-256-GCM key
      const sharedKey = await generateSharedKey();
      const keyBase64 = await exportKeyToBase64(sharedKey);

      // 2. Store key in memory
      setSharedKeys((prev) => new Map(prev).set(calDTag, sharedKey));

      // 3. Publish own key backup (NIP-44 to self)
      await publishOwnKeyBackup({
        ownerPubkey: pubkey,
        calDTag,
        keyBase64,
        nip44: signer!.nip44,
        signEvent,
        publishEvent,
      });

      // 4. Re-encrypt the calendar collection with the shared key
      const calTags: string[][] = [["d", calDTag], ["title", cal.title]];
      if (cal.color) calTags.push(["color", cal.color]);
      for (const ref of cal.eventRefs) calTags.push(["a", ref]);
      await signAndPublish(
        pubkey, KIND_CALENDAR, calTags, "",
        false, signEvent, publishEvent,
        signer, sharedKey, calDTag
      );

      // 5. Re-encrypt all events on this calendar with the shared key.
      // Sign sequentially (NIP-07 requires one popup at a time), then
      // publish all in parallel and throw if any fail.
      const calEvents = eventsRef.current.filter((e) => e.calendarRefs.includes(calDTag));
      const signedCalEvents: SignedNostrEvent[] = [];
      for (const e of calEvents) {
        const tags = buildEventTags(e);
        signedCalEvents.push(await prepareSignedEvent(pubkey, e.kind, tags, e.content, false, signEvent, signer, sharedKey, calDTag));
      }
      const publishResults = await Promise.allSettled(signedCalEvents.map(s => publishEvent(s)));
      const publishFailed = publishResults.filter(r => r.status === "rejected").length;
      if (publishFailed > 0) throw new Error(`Failed to publish ${publishFailed}/${signedCalEvents.length} events. Please try again.`);

      // 6. Initialize empty member list
      await publishMemberList({
        ownerPubkey: pubkey,
        calDTag,
        members: [],
        nip44: signer!.nip44,
        signEvent,
        publishEvent,
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setSharedKeys/sharedKeysRef are stable from useSharing
    [pubkey, signEvent, publishEvent, canPublish, signer]
  );

  // ── Remove member from shared calendar ────────────────────────────

  const removeMember = useCallback(
    async (calDTag: string, memberPubkey: string) => {
      const oldKey = sharedKeysRef.current.get(calDTag);
      if (!oldKey) throw new Error("No shared key for this calendar");
      if (!pubkey) throw new Error("Not logged in");

      // 1. Revoke the member's key envelope
      await revokeKeyEnvelope({
        ownerPubkey: pubkey,
        calDTag,
        memberPubkey,
        signEvent,
        publishEvent,
      });

      // 2–5. Rotate the AES key and re-encrypt everything.
      // Block doRefresh for the duration so it can't attempt to decrypt old
      // ciphertext with the new in-memory key before relay updates propagate.
      keyRotatingRef.current = true;
      try {
        const newKey = await generateSharedKey();
        const newKeyBase64 = await exportKeyToBase64(newKey);

        // 3. Update own key backup with new key
        await publishOwnKeyBackup({
          ownerPubkey: pubkey,
          calDTag,
          keyBase64: newKeyBase64,
          nip44: signer!.nip44,
          signEvent,
          publishEvent,
        });

        // 4. Re-distribute new key to remaining members
        const currentMembers = (calendarMembers.get(calDTag) || []).filter(
          (m) => m !== memberPubkey
        );
        setCalendarMembers((prev) => new Map(prev).set(calDTag, currentMembers));

        for (const m of currentMembers) {
          await publishKeyEnvelope({
            calDTag,
            memberPubkey: m,
            keyBase64: newKeyBase64,
            nip44: signer!.nip44,
            signEvent,
            publishEvent,
          });
        }

        // 5. Re-encrypt all events on this calendar with the new key.
        // Sign sequentially (NIP-07 UX), then publish in parallel.
        const calEvents = eventsRef.current.filter((e) => e.calendarRefs.includes(calDTag));
        const signedReEncrypted: SignedNostrEvent[] = [];
        for (const e of calEvents) {
          const tags = buildEventTags(e);
          signedReEncrypted.push(await prepareSignedEvent(pubkey, e.kind, tags, e.content, false, signEvent, signer, newKey, calDTag));
        }

        // Re-encrypt the calendar collection itself
        const cal = calendarsRef.current.find((c) => c.dTag === calDTag);
        if (cal) {
          const calTags: string[][] = [["d", calDTag], ["title", cal.title]];
          if (cal.color) calTags.push(["color", cal.color]);
          signedReEncrypted.push(await prepareSignedEvent(pubkey, KIND_CALENDAR, calTags, "", false, signEvent, signer, newKey, calDTag));
        }

        // Publish all re-encrypted events in parallel
        const publishResults = await Promise.allSettled(signedReEncrypted.map(s => publishEvent(s)));
        const publishFailed = publishResults.filter(r => r.status === "rejected").length;
        if (publishFailed > 0) throw new Error(`Failed to publish ${publishFailed}/${signedReEncrypted.length} re-encrypted events. Please try again.`);

        // Update member list
        await publishMemberList({
          ownerPubkey: pubkey,
          calDTag,
          members: currentMembers,
          nip44: signer!.nip44,
          signEvent,
          publishEvent,
        });

        // Store new key in memory
        setSharedKeys((prev) => new Map(prev).set(calDTag, newKey));
      } finally {
        // Always unblock doRefresh, even if an error occurred
        keyRotatingRef.current = false;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs/setters from useSharing are stable
    [pubkey, signEvent, publishEvent, signer, calendarMembers]
  );

  // ── Update calendar events ─────────────────────────────────────────

  const updateCalendarEvents = useCallback(
    async (calDTag: string, eventCoords: string[]) => {
      const cal = calendars.find((c) => c.dTag === calDTag);
      if (!cal) return;

      const tags: string[][] = [["d", calDTag], ["title", cal.title]];
      if (cal.color) tags.push(["color", cal.color]);
      for (const coord of eventCoords) tags.push(["a", coord]);

      const sharedKey = sharedKeys.get(calDTag);
      await signAndPublish(
        pubkey!,
        KIND_CALENDAR,
        tags,
        "",
        !sharedKey && shouldEncrypt([calDTag]),
        signEvent,
        publishEvent,
        signer,
        sharedKey,
        sharedKey ? calDTag : undefined
      );

      setCalendars((prev) =>
        prev.map((c) => (c.dTag === calDTag ? { ...c, eventRefs: eventCoords } : c))
      );
    },
    [pubkey, signEvent, publishEvent, calendars, shouldEncrypt, sharedKeys, signer]
  );

  // ── Rename calendar ────────────────────────────────────────────────

  const renameCalendar = useCallback(
    async (dTag: string, newTitle: string) => {
      const cal = calendars.find((c) => c.dTag === dTag);
      if (!cal) return;

      setCalendars((prev) =>
        prev.map((c) => (c.dTag === dTag ? { ...c, title: newTitle } : c))
      );

      const tags: string[][] = [["d", dTag], ["title", newTitle]];
      if (cal.color) tags.push(["color", cal.color]);
      for (const ref of cal.eventRefs) tags.push(["a", ref]);

      const sharedKey = sharedKeys.get(dTag);
      await signAndPublish(
        pubkey!,
        KIND_CALENDAR,
        tags,
        "",
        !sharedKey && shouldEncrypt([dTag]),
        signEvent,
        publishEvent,
        signer,
        sharedKey,
        sharedKey ? dTag : undefined
      );
    },
    [pubkey, signEvent, publishEvent, calendars, shouldEncrypt, sharedKeys, signer]
  );

  // ── Recolor calendar ───────────────────────────────────────────────

  const recolorCalendar = useCallback(
    async (dTag: string, newColor: string) => {
      const cal = calendars.find((c) => c.dTag === dTag);
      if (!cal) return;

      setCalendars((prev) =>
        prev.map((c) => (c.dTag === dTag ? { ...c, color: newColor } : c))
      );

      const tags: string[][] = [["d", dTag], ["title", cal.title], ["color", newColor]];
      for (const ref of cal.eventRefs) tags.push(["a", ref]);

      const sharedKey = sharedKeys.get(dTag);
      await signAndPublish(
        pubkey!,
        KIND_CALENDAR,
        tags,
        "",
        !sharedKey && shouldEncrypt([dTag]),
        signEvent,
        publishEvent,
        signer,
        sharedKey,
        sharedKey ? dTag : undefined
      );
    },
    [pubkey, signEvent, publishEvent, calendars, shouldEncrypt, sharedKeys, signer]
  );

  // ── Delete calendar ────────────────────────────────────────────────

  const deleteCalendar = useCallback(
    async (dTag: string) => {
      persistDeletion(dTag);
      setCalendars((prev) => prev.filter((c) => c.dTag !== dTag));
      setActiveCalendarIds((prev) => {
        const next = new Set(prev);
        next.delete(dTag);
        return next;
      });

      // Also clean up sharing state if this was a shared calendar
      if (sharedKeys.has(dTag)) {
        setSharedKeys((prev) => {
          const next = new Map(prev);
          next.delete(dTag);
          return next;
        });
        if (pubkey) removeSharedCalOwner(pubkey, dTag);
      }

      if (!pubkey) return;
      // Encrypted/shared calendars are published as kind 30078 — delete both
      // the published kind and the original kind to cover all relay states.
      const isEncrypted = shouldEncrypt([dTag]) || sharedKeys.has(dTag);
      const publishedKind = isEncrypted ? KIND_APP_DATA : KIND_CALENDAR;
      const tags: string[][] = [["a", `${publishedKind}:${pubkey}:${dTag}`]];
      if (publishedKind !== KIND_CALENDAR) {
        tags.push(["a", `${KIND_CALENDAR}:${pubkey}:${dTag}`]);
      }
      const signed = await signEvent({
        kind: 5,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: "deleted",
      });
      await publishEvent(signed);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setSharedKeys is a stable setter from useSharing
    [pubkey, signEvent, publishEvent, persistDeletion, sharedKeys, shouldEncrypt]
  );

  // ── Leave shared calendar (wraps SharingContext + UI cleanup) ───────

  const leaveSharedCalendarAndCleanup = useCallback(
    async (calDTag: string) => {
      // Key cleanup + Nostr deletion handled by SharingContext
      await leaveSharedCalendar(calDTag);

      // UI cleanup: remove calendar from list and active set
      setCalendars((prev) => prev.filter((c) => c.dTag !== calDTag));
      setActiveCalendarIds((prev) => {
        const next = new Set(prev);
        next.delete(calDTag);
        return next;
      });
    },
    [leaveSharedCalendar]
  );

  const reorderCalendars = useCallback((orderedDTags: string[]) => {
    setCalendars((prev) => {
      const byDTag = new Map(prev.map((c) => [c.dTag, c]));
      const reordered: CalendarCollection[] = [];
      for (const dTag of orderedDTags) {
        const cal = byDTag.get(dTag);
        if (cal) reordered.push(cal);
      }
      const orderedSet = new Set(orderedDTags);
      for (const cal of prev) {
        if (!orderedSet.has(cal.dTag)) reordered.push(cal);
      }
      return reordered;
    });
  }, []);

  const forceFullRefresh = useCallback(async () => {
    lastFetchRef.current = 0;
    await doRefresh();
  }, [doRefresh]);

  // On login, reset the relay refresh cursor. CalendarApp drives the
  // actual Blossom snapshot restore so it can apply state to every context
  // (calendar + tasks + settings) in one pass.
  useEffect(() => {
    if (!pubkey) return;
    lastFetchRef.current = 0;

    // Safety net: clear the loading indicator after 60s even if relay sync
    // hasn't finished. Prevents "Loading events…" from staying forever when
    // relays are slow or unreachable. Longer timeout because NIP-46 remote
    // signers need RPC calls for each NIP-44 decrypt operation.
    const safetyTimer = setTimeout(() => {
      setEventsLoading((prev) => {
        if (prev) log.warn("clearing eventsLoading after safety timeout");
        return false;
      });
    }, 60_000);

    doRefreshRef.current().finally(() => clearTimeout(safetyTimer));
  }, [pubkey]); // eslint-disable-line react-hooks/exhaustive-deps

  const contextValue = useMemo(() => ({
    events,
    filteredEvents,
    calendars,
    activeCalendarIds,
    allTags,
    tagsByUsage,
    eventsLoading,
    currentDate,
    viewMode,
    setCurrentDate,
    setViewMode,
    toggleCalendar,
    createCalendar,
    createSharedCalendar,
    updateCalendarEvents,
    getSeriesEvents,
    renameCalendar,
    recolorCalendar,
    deleteCalendar,
    reorderCalendars,
    refreshEvents,
    forceFullRefresh,
    deleteEvent,
    moveEvent,
    removeMember,
    convertToShared,
    leaveSharedCalendarAndCleanup,
    addEventOptimistic,
    applySnapshot,
    lastRemoteSha,
    setLastRemoteSha,
    needsCalendarSetup,
    completeCalendarSetup,
    decryptionErrors,
    syncError,
  }), [events, filteredEvents, calendars, activeCalendarIds, allTags, tagsByUsage, eventsLoading, currentDate, viewMode, toggleCalendar, createCalendar, createSharedCalendar, updateCalendarEvents, getSeriesEvents, renameCalendar, recolorCalendar, deleteCalendar, reorderCalendars, refreshEvents, forceFullRefresh, deleteEvent, moveEvent, removeMember, convertToShared, leaveSharedCalendarAndCleanup, addEventOptimistic, applySnapshot, lastRemoteSha, needsCalendarSetup, completeCalendarSetup, decryptionErrors, syncError]);

  return (
    <CalendarContext.Provider
      value={contextValue}
    >
      {children}
    </CalendarContext.Provider>
  );
}
