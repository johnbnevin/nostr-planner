/**
 * NostrContext — authentication and relay management for the planner.
 *
 * Provides the current user's pubkey, relay list, profile metadata, and a
 * `NostrSigner` abstraction that wraps NIP-07 browser extensions, NIP-49
 * local keys (Tauri), or NIP-46 remote signers.
 *
 * **Login flow:**
 * 1. User triggers `loginWithExtension` (web) or `loginWithSigner` (Tauri / NIP-46).
 * 2. The chosen signer resolves a hex pubkey via `getPublicKey()`.
 * 3. `finalizeLogin` stores the pubkey in localStorage for session persistence,
 *    then kicks off parallel fetches for the user's NIP-65 relay list (kind 10002)
 *    and kind-0 profile metadata.
 * 4. On subsequent page loads the auto-login effect checks localStorage and, if a
 *    saved pubkey exists, re-verifies it against the available signer before
 *    restoring the session.
 *
 * All relay communication flows through `publishEvent` / `signEvent` so that
 * downstream code never needs direct relay access.
 *
 * @module NostrContext
 */
import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import { DEFAULT_RELAYS, KIND_RELAY_LIST } from "../lib/nostr";
import { queryEvents, publishToRelays, closePool, parseRelayList, setRelayLists, setPrimaryRelay as relaySetPrimary, setRelayAuthSigner } from "../lib/relay";
import { clearScores as clearRelayScores } from "../lib/relayScore";
import { clearReplicationState } from "../lib/replication";
import type { NostrEvent } from "../lib/relay";
import type { NostrSigner, UnsignedEvent } from "../lib/signer";
import { Nip07Signer } from "../lib/signer";
import { LocalSigner } from "../lib/localSigner";
import { reconnectBunkerWithBackoff, loadNip46ClientKey, persistNip46Session, clearNip46Session, type ReconnectStatus } from "../lib/nip46Signer";
import { isTauri } from "../lib/platform";
import { logger } from "../lib/logger";
import { lsSet } from "../lib/storage";
import { clearCalendarCache } from "../lib/eventCache";
import { enqueueOutbox, startOutbox, stopOutbox, scheduleOutboxDrain, flushOutbox, clearOutbox, onOutboxChange, countPending } from "../lib/outbox";
import { isProbablyOnline } from "../lib/online";

const log = logger("nostr");

/** Read the saved primaryRelay URL from this user's settings blob.
 *  Returns null if no valid URL is stored. Swallows all errors so a
 *  corrupt or unavailable localStorage never blocks login. */
function readSavedPrimaryRelay(pubkey: string): string | null {
  try {
    const raw = localStorage.getItem(`nostr-planner-settings-${pubkey}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { primaryRelay?: unknown };
    const url = typeof parsed.primaryRelay === "string" ? parsed.primaryRelay.trim() : "";
    return url && /^wss?:\/\//i.test(url) ? url : null;
  } catch {
    return null;
  }
}

/**
 * Minimal profile metadata extracted from a kind-0 event.
 */
export interface NostrProfile {
  name?: string;
  picture?: string;
}

/**
 * Shape of the value exposed by {@link NostrProvider}.
 *
 * Consumers access this via the {@link useNostr} hook.
 */
interface NostrContextValue {
  /** Hex-encoded public key of the logged-in user, or `null` when logged out. */
  pubkey: string | null;
  /** Active relay URLs — starts with hardcoded defaults, then merges NIP-65 list. */
  relays: string[];
  /** User's parsed NIP-65 read/write relay lists (kind-10002). Empty until the
   *  login-time fetch completes, or if the user has no NIP-65 event. Exposed
   *  so the Settings UI can offer these as choices for the primary relay. */
  nip65Relays: { read: string[]; write: string[] };
  /** Kind-0 profile metadata (display name + avatar), fetched best-effort. */
  profile: NostrProfile | null;
  /** The active signer implementation, or `null` when no session is active. */
  signer: NostrSigner | null;
  /** True while a saved identity is known (pubkey restored from localStorage)
   *  but the signer isn't live yet — i.e. a bunker reconnect is in flight. The
   *  app shell renders the cached calendar read-only during this window so a
   *  tab eviction never blanks out to a reconnect/login screen. Mutations are
   *  blocked because they'd need the (absent) signer. */
  restoring: boolean;
  /** True while localStorage still holds a pubkey from a prior session. Used
   *  to distinguish "never logged in" from "returning user whose auto-login
   *  hasn't finished yet" so we can show a reconnect splash. */
  hasSavedSession: boolean;
  /** Stage of the session-restore pipeline on this tab.
   *  "reconnecting" = ladder is running across multiple attempts; app shell
   *  is rendered in read-only mode from cached data during this window. */
  autoLoginState: "idle" | "attempting" | "reconnecting" | "done" | "failed";
  /** Live status of the bunker reconnect ladder (null when not reconnecting). */
  reconnectStatus: ReconnectStatus | null;
  /** Number of events queued in the outbox awaiting relay sync. */
  outboxDepth: number;
  /** Re-run the auto-login routine manually (e.g. from a retry button). */
  retryAutoLogin: () => void;
  /** Login with NIP-07 browser extension (web only). */
  loginWithExtension: () => Promise<void>;
  /** Login with any pre-constructed signer (LocalSigner, Nip46Signer). */
  loginWithSigner: (signer: NostrSigner) => Promise<void>;
  /** Alias for loginWithExtension — kept for backwards compatibility. */
  login: () => Promise<void>;
  /** Clear the current session, destroy signer key material, and reset state. */
  logout: () => void;
  /** Sign an unsigned event using the active signer. Throws if not logged in. */
  signEvent: (event: UnsignedEvent) => Promise<NostrEvent>;
  /** Publish a signed event to the user's relay set. Throws on total failure. */
  publishEvent: (event: NostrEvent) => Promise<void>;
  /** Tear down a dead NIP-46 signer and restart the reconnect ladder.
   *  Call when an operation fails with a closed/unresponsive-signer error
   *  ("this signer is not open anymore"). No-op for non-bunker sessions
   *  and while a ladder is already running. */
  reviveSigner: () => void;
}

const NostrContext = createContext<NostrContextValue | null>(null);

/**
 * Hook to access the Nostr context. Must be called inside a {@link NostrProvider}.
 *
 * @throws If called outside the provider tree.
 */
export function useNostr() {
  const ctx = useContext(NostrContext);
  if (!ctx) throw new Error("useNostr must be used within NostrProvider");
  return ctx;
}

/**
 * Provider that manages Nostr authentication state, relay discovery, and
 * profile fetching. Should be placed near the root of the React tree so that
 * all child components can call {@link useNostr}.
 */
export function NostrProvider({ children }: { children: ReactNode }) {
  const [pubkey, setPubkey] = useState<string | null>(null);
  // Mirror of `pubkey` for async callbacks to check identity-staleness after
  // an await — so a slow profile/relay fetch that resolves after logout (or an
  // account switch) doesn't repopulate state for the wrong/no identity.
  const pubkeyRef = useRef<string | null>(null);
  const [relays, setRelays] = useState<string[]>(DEFAULT_RELAYS);
  const [nip65Relays, setNip65Relays] = useState<{ read: string[]; write: string[] }>({ read: [], write: [] });
  const [profile, setProfile] = useState<NostrProfile | null>(null);
  const [signer, setSigner] = useState<NostrSigner | null>(null);
  // Stages: "idle" before any attempt, "attempting" during auto-login,
  // "done" after success, "failed" if no viable signer was available.
  // The reconnect-splash screen uses this to decide whether to keep waiting
  // or offer the user a retry / fallback login method.
  const [autoLoginState, setAutoLoginState] = useState<"idle" | "attempting" | "reconnecting" | "done" | "failed">("idle");
  const [autoLoginTrigger, setAutoLoginTrigger] = useState(0);
  const retryAutoLogin = useCallback(() => setAutoLoginTrigger((n) => n + 1), []);
  const [reconnectStatus, setReconnectStatus] = useState<ReconnectStatus | null>(null);
  const [outboxDepth, setOutboxDepth] = useState(0);
  const [hasSavedSession, setHasSavedSession] = useState<boolean>(() => {
    try { return !!localStorage.getItem("nostr-planner-pubkey"); } catch { return false; }
  });

  /** Fetch the user's NIP-65 relay list (kind 10002) and merge with defaults. */
  const fetchRelayList = useCallback(
    async (pk: string, fallbackRelays: string[]) => {
      log.debug("fetching NIP-65 relay list for", pk.slice(0, 8));
      try {
        const events = await queryEvents(fallbackRelays, {
          kinds: [KIND_RELAY_LIST],
          authors: [pk],
          limit: 1,
        });

        if (pubkeyRef.current !== pk) return; // logged out / switched mid-fetch
        if (events.length > 0) {
          const parsed = parseRelayList(events[0]);
          if (parsed.all.length > 0) {
            // Store the raw parsed NIP-65 lists (without fallback merging)
            // so the Settings UI can show exactly what the user published.
            setNip65Relays({ read: [...parsed.read], write: [...parsed.write] });
            // NIP-65 outbox: separate read/write relay sets (merged with
            // fallbacks so redundancy publishes have at least the defaults).
            setRelayLists(
              [...new Set([...parsed.read, ...fallbackRelays])],
              [...new Set([...parsed.write, ...fallbackRelays])]
            );
            const merged = [...new Set([...parsed.all, ...fallbackRelays])];
            log.debug("relay list resolved:", merged.length, "relays");
            setRelays(merged);
          }
        } else {
          log.debug("no NIP-65 relay list found, using defaults");
        }
      } catch {
        // Fall back to defaults
        log.debug("relay list fetch failed, using defaults");
      }
    },
    []
  );

  /** Fetch kind-0 profile metadata (display name, avatar). Best-effort. */
  const fetchProfile = useCallback(
    async (pk: string, rlys: string[]) => {
      log.debug("fetching profile for", pk.slice(0, 8));
      try {
        const events = await queryEvents(rlys, {
          kinds: [0],
          authors: [pk],
          limit: 1,
        });
        if (pubkeyRef.current !== pk) return; // logged out / switched mid-fetch
        if (events.length > 0) {
          const meta = JSON.parse(events[0].content);
          // Validate picture URL: must be HTTPS, must look like an image path,
          // and must not contain query params that could be used for tracking
          // (e.g. ?pubkey=...). Only allow common image extensions + CDN paths.
          let pic: string | undefined;
          if (typeof meta.picture === "string" && /^https:\/\//i.test(meta.picture)) {
            try {
              const picUrl = new URL(meta.picture);
              // Block URLs with suspicious query params (tracking pixels)
              const suspiciousParams = ["pubkey", "npub", "track", "uid", "id"];
              const hasSuspiciousParams = suspiciousParams.some((p) => picUrl.searchParams.has(p));
              // Block SVG (can embed JavaScript via <script> / onload) and
              // anything that isn't an obvious raster image. data: URLs are
              // already excluded by the https:// scheme check above.
              const path = picUrl.pathname.toLowerCase();
              const looksRaster = /\.(png|jpe?g|gif|webp|avif|bmp|ico)(?:$|\?)/.test(path)
                || !/\.[a-z0-9]+$/.test(path); // CDN paths without extensions get a pass
              const looksSvg = /\.(svg|svgz)(?:$|\?)/.test(path);
              if (!hasSuspiciousParams && !looksSvg && looksRaster) {
                pic = meta.picture.slice(0, 2048);
              }
            } catch {
              // Invalid URL, skip
            }
          }
          setProfile({
            name: meta.display_name || meta.name || undefined,
            picture: pic,
          });
          log.debug("profile loaded:", meta.display_name || meta.name || "(unnamed)");
        }
      } catch {
        // Profile fetch is best-effort
        log.debug("profile fetch failed (best-effort, ignoring)");
      }
    },
    []
  );

  /**
   * Shared post-login setup: persist the pubkey for session restoration,
   * set signer + pubkey state, and kick off parallel relay list / profile fetches.
   */
  const finalizeLogin = useCallback(
    async (pk: string, s: NostrSigner) => {
      // Validate pubkey format before trusting it (guards against compromised
      // extensions returning malformed values).
      if (!/^[0-9a-f]{64}$/.test(pk)) {
        throw new Error("Signer returned invalid pubkey format");
      }
      log.info("login finalized for", pk.slice(0, 8));
      setSigner(s);
      setPubkey(pk);
      pubkeyRef.current = pk;
      // Wire signer for NIP-42 AUTH — paid relays and some flagged
      // filters won't return events until the connection is authed.
      setRelayAuthSigner(s);
      setAutoLoginState("done");
      setHasSavedSession(true);
      lsSet("nostr-planner-pubkey", pk);
      // Tell other tabs we're now this identity so they can reconcile.
      if (typeof BroadcastChannel !== "undefined") {
        try {
          const ch = new BroadcastChannel("nostr-planner-auth");
          ch.postMessage({ kind: "login", pubkey: pk });
          ch.close();
        } catch { /* ignore */ }
      }
      // Restore the user's saved primary relay BEFORE we fire any queries
      // below. SettingsContext also restores it on `pubkey` change, but
      // that effect lands after this function returns — the queries here
      // would otherwise hit whatever was in `primaryRelay` at module init
      // (first suggested, i.e. damus) even when the user has set their
      // own primary in Settings. Reading localStorage here is safe (we're
      // inside an async callback, pubkey is known, try/catch around the
      // access); avoids the module-init read that broke the UI in 1.16.0b.
      const saved = readSavedPrimaryRelay(pk);
      if (saved) relaySetPrimary(saved);
      // Boot the outbox drainer for this pubkey — replays any writes that
      // were queued during a previous session/offline window. Also flush
      // immediately because the signer is fresh and may have been the
      // gating factor on prior retries.
      startOutbox(pk);
      void flushOutbox(pk).catch(err => log.warn("initial outbox flush failed", err));
      // Fire-and-forget: failures are non-fatal (defaults work fine).
      void fetchRelayList(pk, DEFAULT_RELAYS).catch(err =>
        log.warn("relay list fetch failed", err)
      );
      void fetchProfile(pk, DEFAULT_RELAYS).catch(err =>
        log.warn("profile fetch failed", err)
      );
    },
    [fetchRelayList, fetchProfile]
  );

  /**
   * Login using a NIP-07 browser extension (nos2x, Alby, etc.).
   * Checks for `window.nostr` and prompts the user if no extension is found.
   */
  const loginWithExtension = useCallback(async () => {
    log.debug("attempting NIP-07 extension login");
    if (!window.nostr) {
      log.warn("no NIP-07 extension detected");
      alert(
        "No Nostr extension found. Please install nos2x, Alby, or another NIP-07 extension."
      );
      return;
    }
    const s = new Nip07Signer();
    const pk = await s.getPublicKey();
    log.debug("NIP-07 extension returned pubkey", pk.slice(0, 8));
    await finalizeLogin(pk, s);
  }, [finalizeLogin]);

  /**
   * Login with an arbitrary {@link NostrSigner} (e.g. LocalSigner for Tauri,
   * or a NIP-46 remote signer). The signer must already be initialized.
   */
  const loginWithSigner = useCallback(
    async (s: NostrSigner) => {
      log.debug("login with custom signer");
      const pk = await s.getPublicKey();
      log.debug("custom signer returned pubkey", pk.slice(0, 8));
      await finalizeLogin(pk, s);
    },
    [finalizeLogin]
  );

  const login = loginWithExtension;

  /**
   * Log out: destroy signer key material, clear persisted pubkey, reset all
   * state to defaults, and close the relay pool.
   */
  const logout = useCallback(() => {
    log.info("logout — clearing session");
    // Clear IndexedDB calendar cache for this user
    const savedPk = localStorage.getItem("nostr-planner-pubkey");
    if (savedPk) void clearCalendarCache(savedPk);
    // Stop outbox drainer and drop any pending writes for this user —
    // re-publishing under a different signer would be wrong.
    stopOutbox();
    if (savedPk) void clearOutbox(savedPk);
    setOutboxDepth(0);
    setReconnectStatus(null);
    // Destroy signer (zeroes key material, closes NIP-46 relay subscriptions)
    signer?.destroy?.().catch(err => log.warn("signer cleanup error", err));
    setRelayAuthSigner(null);
    setSigner(null);
    setPubkey(null);
    pubkeyRef.current = null;
    setRelays(DEFAULT_RELAYS);
    setNip65Relays({ read: [], write: [] });
    setProfile(null);
    setHasSavedSession(false);
    setAutoLoginState("idle");
    // Clear settings (may contain email address for digest)
    if (savedPk) localStorage.removeItem(`nostr-planner-settings-${savedPk}`);
    localStorage.removeItem("nostr-planner-pubkey");
    localStorage.removeItem("nostr-planner-nsec");
    localStorage.removeItem("nostr-planner-login-type");
    localStorage.removeItem("nostr-planner-bunker-url");
    // Drop the persisted NIP-46 client key + bunker URL so a future login
    // starts a clean pairing rather than reusing this identity's channel.
    clearNip46Session();
    if (isTauri()) {
      log.debug("clearing Tauri secure store");
      LocalSigner.clearStore().catch(() => {});
    }
    closePool();
    clearRelayScores();
    clearReplicationState();
    // Tell other tabs to reload so they don't keep operating under the
    // now-gone identity. BroadcastChannel is the only viable transport —
    // storage events fire on OTHER tabs but not the originating one, and
    // we want both behaviors.
    if (typeof BroadcastChannel !== "undefined") {
      try {
        const ch = new BroadcastChannel("nostr-planner-auth");
        ch.postMessage({ kind: "logout" });
        ch.close();
      } catch { /* ignore */ }
    }
  }, [signer]);

  /**
   * The active NIP-46 signer went dead ("this signer is not open anymore",
   * or Amber simply stopped answering). Tear it down and restart the
   * reconnect ladder against the persisted bunker URL + client key — the
   * same silent path a page reload takes, minus the reload. The persisted
   * client key means Amber recognizes the session and does NOT re-prompt.
   *
   * Guarded so repeated failures can't stack ladders or tear down a
   * session that has no reconnect path (extension / local-key logins).
   */
  const reviveSigner = useCallback(() => {
    const loginType = localStorage.getItem("nostr-planner-login-type");
    const bunkerUrl = localStorage.getItem("nostr-planner-bunker-url");
    if (loginType !== "bunker" || !bunkerUrl) {
      log.debug("reviveSigner: not a bunker session — ignoring");
      return;
    }
    if (ladderActiveRef.current) {
      log.debug("reviveSigner: reconnect ladder already running");
      return;
    }
    log.warn("reviveSigner: bunker signer reported dead — tearing down and reconnecting");
    signer?.destroy?.().catch(() => { /* already dead */ });
    setRelayAuthSigner(null);
    setSigner(null);
    // The auto-login effect sees loginType=bunker + saved pubkey and runs
    // the reconnect ladder; on success finalizeLogin installs the fresh
    // signer and flushes the outbox.
    setAutoLoginTrigger((n) => n + 1);
  }, [signer]);

  /**
   * Sign an unsigned Nostr event using the active signer.
   *
   * @throws If no signer is active (user not logged in).
   */
  const signEvent = useCallback(
    async (event: UnsignedEvent): Promise<NostrEvent> => {
      if (!signer) throw new Error("Not logged in");
      return signer.signEvent(event);
    },
    [signer]
  );

  /**
   * Publish a signed event to the user's active relay set.
   * On failure, fires a global publish-failure notification and re-throws.
   */
  const publishEvent = useCallback(
    async (event: NostrEvent) => {
      // Optimistic-by-default semantics: try once, and on failure queue the
      // event in the IndexedDB outbox for later retry. Callers see a
      // successful return — their optimistic local edit is durably tracked,
      // either at the relay or in the outbox. The header pill surfaces
      // the pending count so the user knows sync is behind.
      // Skip the network entirely when we already know we're offline.
      if (isProbablyOnline()) {
        try {
          await publishToRelays(relays, event);
          log.debug("event published, kind", event.kind);
          return;
        } catch (err) {
          log.warn("publish failed for kind", event.kind, "— queuing to outbox:", err instanceof Error ? err.message : err);
          const pk = pubkey ?? localStorage.getItem("nostr-planner-pubkey");
          if (pk) await enqueueOutbox(pk, event, err instanceof Error ? err : new Error(String(err)));
          return;
        }
      } else {
        log.info("offline — queuing publish to outbox, kind", event.kind);
        const pk = pubkey ?? localStorage.getItem("nostr-planner-pubkey");
        if (pk) await enqueueOutbox(pk, event, new Error("offline"));
        return;
      }
    },
    [relays, pubkey]
  );

  // Auto-login on mount: restore the session from the previous login method.
  // - Extension (web): re-verify with NIP-07 extension
  // - Tauri: NIP-49 encrypted keys require a password — LoginScreen handles unlock
  // nsec is never persisted to localStorage (web sessions are ephemeral for key-owning logins)
  // Guards against spawning multiple concurrent reconnect ladders if
  // visibility-change / autoLoginTrigger fire while a ladder is already
  // mid-flight. Cleared in the ladder's .then/.catch and the effect cleanup.
  const ladderActiveRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const saved = localStorage.getItem("nostr-planner-pubkey");
    if (!saved) {
      // Nothing to restore — leave state at idle. No setState here to
      // avoid a redundant render (the initial state is already "idle").
      return;
    }

    log.debug("found saved pubkey", saved.slice(0, 8), "— attempting auto-login");
    // These two setStates drive the splash/reconnect UI and MUST land
    // before the async work below begins — otherwise the user sees a
    // blank login screen flash during the auto-login attempt. Wrapping
    // them in a microtask defers a frame (visible flicker) and changes
    // observable behavior, so the synchronous-setState lint is suppressed
    // here intentionally.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHasSavedSession(true);
    setAutoLoginState("attempting");

    // Clear any legacy stored nsec from localStorage (migration cleanup)
    if (localStorage.getItem("nostr-planner-nsec")) {
      log.warn("found legacy nsec in localStorage — clearing for security");
      localStorage.removeItem("nostr-planner-nsec");
      localStorage.removeItem("nostr-planner-login-type");
    }

    const loginType = localStorage.getItem("nostr-planner-login-type");
    const bunkerUrl = localStorage.getItem("nostr-planner-bunker-url");

    // Bunker session restore: if the user's last login was via NIP-46 and we
    // have a saved bunker URL, run the reconnect ladder. The ladder pauses
    // while offline/hidden and retries with backoff up to 8 attempts, so a
    // backgrounded PWA waking up on a slow connection will eventually
    // reconnect without the user having to do anything. While it runs, the
    // app shell renders read-only from the IndexedDB cache (App.tsx).
    if (loginType === "bunker" && bunkerUrl) {
      // Validate the saved bunker URL before handing it to the SDK.
      // A corrupt or stale localStorage entry shouldn't be able to make
      // us dial arbitrary URLs — `bunker://` is the only valid scheme.
      if (!/^bunker:\/\//i.test(bunkerUrl)) {
        log.warn("ignoring saved bunker URL with invalid scheme; clearing");
        localStorage.removeItem("nostr-planner-bunker-url");
        localStorage.removeItem("nostr-planner-login-type");
        setAutoLoginState("failed");
        return;
      }
      if (ladderActiveRef.current) {
        log.debug("reconnect ladder already running — not spawning another");
        return;
      }
      log.debug("restoring bunker session via reconnect ladder");
      setAutoLoginState("reconnecting");
      // Optimistically surface the saved identity NOW, before the signer is
      // live, so AppContent renders the cached calendar (read-only) instead of
      // a blocking reconnect splash. The signer stays null until the ladder
      // succeeds — `restoring` (pubkey && !signer) gates out mutations, and all
      // signer-dependent effects (Blossom restore, autosave, watchPointer)
      // already wait on `signer?.nip44`, so nothing fires prematurely. On
      // terminal failure we revert this below so the user still reaches the
      // ReconnectScreen / LoginScreen recovery affordances.
      setPubkey(saved);
      pubkeyRef.current = saved;
      const ac = new AbortController();
      ladderActiveRef.current = true;
      reconnectBunkerWithBackoff({
        bunkerUrl,
        expectedPubkey: saved,
        // Reuse the client key saved at login so the remote signer (Amber,
        // nsec.app…) recognizes the same client and honors a prior "always
        // authorize" grant — instead of re-prompting for every permission on
        // every reconnect, which felt like being logged out each launch.
        clientSecretKey: loadNip46ClientKey() ?? undefined,
        signal: ac.signal,
        onStatus: (s) => { if (!cancelled) setReconnectStatus(s); },
      })
        .then(async (result) => {
          ladderActiveRef.current = false;
          if (cancelled) { await result.signer.destroy?.(); return; }
          setReconnectStatus(null);
          // Refresh the persisted session (the key is unchanged; the bunker
          // pointer may have picked up new relays during the handshake).
          persistNip46Session(result.clientSecretKey, result.bunkerPointer);
          await finalizeLogin(result.pubkey, result.signer);
        })
        .catch((err) => {
          ladderActiveRef.current = false;
          if (cancelled) return;
          if (err instanceof DOMException && err.name === "AbortError") return;
          const msg = err instanceof Error ? err.message : String(err);
          log.warn("bunker reconnect ladder exhausted", err);
          // Only a VERIFIED identity change is grounds to wipe the saved
          // bunker session — never trust a bunker that returns a different
          // pubkey. A transient failure (timeout, relay down, a remote signer
          // that was briefly unreachable while the tab was backgrounded) must
          // NOT destroy the saved credentials: doing so turns a temporary
          // reconnect blip into a permanent logout. The previous `/invalid/i`
          // catch-all did exactly that — any error message containing
          // "invalid" wiped the URL. The ReconnectScreen's "exhausted" state
          // already gives the user explicit re-pair / sign-out controls, and a
          // later visibility re-trigger can still succeed against the same URL.
          if (/different pubkey/i.test(msg)) {
            localStorage.removeItem("nostr-planner-bunker-url");
            localStorage.removeItem("nostr-planner-login-type");
          }
          // Revert the optimistic pubkey set when the ladder began: with no
          // signer and the ladder exhausted, drop back so AppContent can show
          // the ReconnectScreen ("Couldn't reconnect" → retry / sign out) or
          // LoginScreen instead of a frozen read-only shell.
          setPubkey(null);
          pubkeyRef.current = null;
          setReconnectStatus(null);
          setAutoLoginState("failed");
        });
      return () => { cancelled = true; ac.abort(); ladderActiveRef.current = false; };
    }

    // NIP-07 auto-login path. Treat the session as extension-restorable when
    // the user logged in via an extension last time (loginType === "extension"),
    // or when no loginType is recorded on a web surface (legacy sessions
    // pre-dating the flag, or an nsec/seed web login whose in-memory key is
    // gone after a reload — an installed extension for the SAME identity can
    // still revive it; a different one just yields a mismatch, handled
    // non-destructively below).
    //
    // Crucially we decide on loginType, NOT on the synchronous presence of
    // window.nostr. Extensions inject window.nostr asynchronously and are
    // frequently absent for the first few hundred milliseconds after a load —
    // e.g. when a backgrounded tab is discarded (Chrome Memory Saver) and
    // reloaded the moment the user switches back to it. Gating on window.nostr
    // here is exactly what logged users out on window switching: we'd conclude
    // "no extension" during the injection gap and fall through to a destructive
    // branch that deleted the saved pubkey. We now wait for injection and never
    // delete the session on a transient miss.
    const mightBeExtension =
      loginType === "extension" || (!loginType && !isTauri());
    if (mightBeExtension) {
      const tryExtensionRestore = async () => {
        // Wait (bounded) for the extension to inject window.nostr instead of
        // giving up on the first synchronous miss. Returns immediately when
        // it's already present (the common warm-load case → no added latency).
        const waitForNostr = async (): Promise<boolean> => {
          for (let i = 0; i < 20; i++) {           // up to ~3s (20 × 150ms)
            if (window.nostr) return true;
            await new Promise((r) => setTimeout(r, 150));
            if (cancelled) return false;
          }
          return !!window.nostr;
        };
        const attempt = async (): Promise<{ ok: boolean; pk?: string; mismatch?: boolean }> => {
          if (!window.nostr) return { ok: false };
          try {
            const pk = await window.nostr.getPublicKey();
            if (pk === saved) return { ok: true, pk };
            return { ok: false, mismatch: true, pk };
          } catch {
            return { ok: false };
          }
        };
        const haveNostr = await waitForNostr();
        if (cancelled) return;
        if (!haveNostr) {
          // No extension on this surface right now (not installed/enabled, or
          // a standalone PWA where extensions don't exist). NEVER delete the
          // saved pubkey — returning to a browser that has the extension, or a
          // later visibility re-trigger once it injects, restores the session.
          log.debug("no NIP-07 extension available yet — keeping saved session for retry");
          setAutoLoginState("failed");
          return;
        }
        let result = await attempt();
        if (cancelled) return;
        // Only retry on a thrown error / not-yet-ready state. A real pubkey
        // mismatch (user switched identities) shouldn't trigger another prompt.
        if (!result.ok && !result.mismatch) {
          await new Promise((r) => setTimeout(r, 1500));
          if (cancelled) return;
          result = await attempt();
          if (cancelled) return;
        }
        if (result.ok && result.pk) {
          log.debug("NIP-07 pubkey matches saved key, restoring session");
          const s = new Nip07Signer();
          if (cancelled) return;
          await finalizeLogin(result.pk, s);
        } else {
          // Either a genuine identity mismatch or the user dismissed the
          // prompt. Surface LoginScreen but KEEP the saved pubkey — only an
          // explicit logout (or a verified bunker identity change) ever clears
          // the session. This invariant is what stops window switching from
          // logging anyone out.
          log.debug(result.mismatch
            ? "NIP-07 pubkey mismatch — keeping saved session, surfacing login"
            : "NIP-07 auto-login check failed — keeping saved session, surfacing login");
          setAutoLoginState("failed");
        }
      };
      void tryExtensionRestore();
    } else if (isTauri()) {
      // Tauri with a saved pubkey but no extension loginType — the LocalSigner
      // unlock screen appears via LoginScreen because it gates on
      // hasStoredKey(). Don't clean up; the user just needs to enter their
      // password.
      log.debug("Tauri with stored key — awaiting password unlock");
      setAutoLoginState("failed");
    } else {
      // No auto-restore path on this surface. Surface LoginScreen, but do NOT
      // delete the saved pubkey — keeping it is harmless (it just remembers the
      // npub) and preserves the "only an explicit logout clears the session"
      // invariant. hasSavedSession reflects that there's nothing to auto-revive.
      log.debug("no auto-login method available — keeping saved pubkey, surfacing login");
      setHasSavedSession(false);
      setAutoLoginState("failed");
    }

    return () => { cancelled = true; };
  }, [finalizeLogin, autoLoginTrigger]);

  // When the user brings the app back to the foreground, try to restore the
  // session if it's sitting in a failed state — PWAs can be suspended for
  // hours and bunker subscriptions drop silently. Re-attempting on visibility
  // is cheap and usually succeeds without user intervention.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      const saved = localStorage.getItem("nostr-planner-pubkey");
      if (!saved) return;
      // If we already have a signer and pubkey, just nudge the outbox so
      // any pending writes get a fresh attempt.
      if (pubkey && signer) {
        scheduleOutboxDrain(pubkey);
        return;
      }
      // A bunker reconnect ladder is already running — it pauses while hidden
      // and resumes itself the moment the tab is visible again (see
      // waitForOnlineAndVisible). Bumping the trigger here would abort it via
      // the effect cleanup and restart from attempt 1, throwing away backoff
      // progress, so leave a live ladder alone.
      if (ladderActiveRef.current) return;
      // Otherwise, bump the auto-login trigger — the effect above will run
      // the reconnect ladder, which itself pauses on offline/hidden.
      setAutoLoginTrigger((n) => n + 1);
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [pubkey, signer]);

  // Cross-tab sync: if the user logs out (or logs in as someone else) in
  // another tab, mirror that state into this one. Without this, two tabs
  // can hold conflicting sessions — second tab keeps signing/publishing
  // under the old identity while localStorage already reflects the new
  // one. BroadcastChannel works in all modern browsers, including the
  // WebView2 / WKWebView surfaces Tauri uses, so this applies to every
  // platform identically. Safe degradation: where it's unavailable (some
  // old Android WebView builds) the user just doesn't get cross-tab
  // sync — single-tab UX is unaffected.
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const ch = new BroadcastChannel("nostr-planner-auth");
    const handler = (e: MessageEvent) => {
      const data = e.data as { kind?: string; pubkey?: string | null } | null;
      if (!data || typeof data.kind !== "string") return;
      if (data.kind === "logout") {
        log.info("cross-tab logout — clearing local session");
        // Don't re-emit (avoid loops) — call the local cleanup directly.
        // We can't call logout() here because it would dispatch another
        // message; trigger the same teardown inline by clearing state.
        // Safer: just reload, which re-runs auto-login against the now-
        // empty localStorage and lands on LoginScreen.
        window.location.reload();
      } else if (data.kind === "login" && data.pubkey && pubkey && data.pubkey !== pubkey) {
        // Only reload on a real identity conflict: THIS tab has a pubkey
        // and the other tab just became a different one. If this tab is
        // empty (pubkey === null), it's either logging in itself (the
        // broadcast might be its own, depending on browser BroadcastChannel
        // semantics) or it'll pick up the new identity on its next
        // auto-login pass. Reloading in either case would cause a loop.
        log.info("cross-tab login as different identity — reloading");
        window.location.reload();
      }
    };
    ch.addEventListener("message", handler);
    return () => {
      ch.removeEventListener("message", handler);
      ch.close();
    };
  }, [pubkey]);

  // Subscribe to outbox depth changes for the header pill.
  useEffect(() => {
    if (!pubkey) {
      // Use microtask so we never call setState synchronously in the effect body.
      void Promise.resolve().then(() => setOutboxDepth(0));
      return;
    }
    void countPending(pubkey).then(setOutboxDepth);
    const off = onOutboxChange(setOutboxDepth);
    return () => off();
  }, [pubkey]);

  return (
    <NostrContext.Provider
      value={{
        pubkey,
        relays,
        nip65Relays,
        profile,
        signer,
        restoring: !!pubkey && !signer,
        hasSavedSession,
        autoLoginState,
        reconnectStatus,
        outboxDepth,
        retryAutoLogin,
        loginWithExtension,
        loginWithSigner,
        login,
        logout,
        signEvent,
        publishEvent,
        reviveSigner,
      }}
    >
      {children}
    </NostrContext.Provider>
  );
}
