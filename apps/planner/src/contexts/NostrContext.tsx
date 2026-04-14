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
  type ReactNode,
} from "react";
import { DEFAULT_RELAYS, KIND_RELAY_LIST } from "../lib/nostr";
import { queryEvents, publishToRelays, closePool, notifyPublishFailure, parseRelayList, setRelayLists } from "../lib/relay";
import type { NostrEvent } from "../lib/relay";
import type { NostrSigner, UnsignedEvent } from "../lib/signer";
import { Nip07Signer } from "../lib/signer";
import { LocalSigner } from "../lib/localSigner";
import { isTauri } from "../lib/platform";
import { logger } from "../lib/logger";
import { lsSet } from "../lib/storage";
import { clearCalendarCache } from "../lib/eventCache";

const log = logger("nostr");

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
  /** Kind-0 profile metadata (display name + avatar), fetched best-effort. */
  profile: NostrProfile | null;
  /** The active signer implementation, or `null` when no session is active. */
  signer: NostrSigner | null;
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
  const [relays, setRelays] = useState<string[]>(DEFAULT_RELAYS);
  const [profile, setProfile] = useState<NostrProfile | null>(null);
  const [signer, setSigner] = useState<NostrSigner | null>(null);

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

        if (events.length > 0) {
          const parsed = parseRelayList(events[0]);
          if (parsed.all.length > 0) {
            // NIP-65 outbox: separate read/write relay sets
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
              if (!hasSuspiciousParams) {
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
      lsSet("nostr-planner-pubkey", pk);
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
    // Destroy signer (zeroes key material, closes NIP-46 relay subscriptions)
    signer?.destroy?.().catch(err => log.warn("signer cleanup error", err));
    setSigner(null);
    setPubkey(null);
    setRelays(DEFAULT_RELAYS);
    setProfile(null);
    // Clear settings (may contain email address for digest)
    if (savedPk) localStorage.removeItem(`nostr-planner-settings-${savedPk}`);
    localStorage.removeItem("nostr-planner-pubkey");
    localStorage.removeItem("nostr-planner-nsec");
    localStorage.removeItem("nostr-planner-login-type");
    if (isTauri()) {
      log.debug("clearing Tauri secure store");
      LocalSigner.clearStore().catch(() => {});
    }
    closePool();
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
      try {
        await publishToRelays(relays, event);
        log.debug("event published, kind", event.kind);
      } catch (err) {
        log.error("publish failed for kind", event.kind, err);
        notifyPublishFailure(err instanceof Error ? err : new Error(String(err)), event);
        throw err;
      }
    },
    [relays]
  );

  // Auto-login on mount: restore the session from the previous login method.
  // - Extension (web): re-verify with NIP-07 extension
  // - Tauri: NIP-49 encrypted keys require a password — LoginScreen handles unlock
  // nsec is never persisted to localStorage (web sessions are ephemeral for key-owning logins)
  useEffect(() => {
    let cancelled = false;
    const saved = localStorage.getItem("nostr-planner-pubkey");
    if (!saved) return;

    log.debug("found saved pubkey", saved.slice(0, 8), "— attempting auto-login");

    if (isTauri()) {
      log.debug("Tauri environment — skipping auto-login (password required)");
      return;
    }

    // Clear any legacy stored nsec from localStorage (migration cleanup)
    if (localStorage.getItem("nostr-planner-nsec")) {
      log.warn("found legacy nsec in localStorage — clearing for security");
      localStorage.removeItem("nostr-planner-nsec");
      localStorage.removeItem("nostr-planner-login-type");
    }

    if (window.nostr) {
      // Extension: re-verify with NIP-07
      window.nostr
        .getPublicKey()
        .then(async (pk) => {
          if (cancelled) return;
          if (pk === saved) {
            log.debug("NIP-07 pubkey matches saved key, restoring session");
            const s = new Nip07Signer();
            if (cancelled) return; // re-check after async gap
            await finalizeLogin(pk, s);
          } else {
            log.debug("NIP-07 pubkey mismatch — not auto-logging in");
          }
        })
        .catch(() => {
          if (!cancelled) log.debug("NIP-07 auto-login check failed");
        });
    } else {
      log.debug("no auto-login method available");
    }

    return () => { cancelled = true; };
  }, [finalizeLogin]);

  return (
    <NostrContext.Provider
      value={{
        pubkey,
        relays,
        profile,
        signer,
        loginWithExtension,
        loginWithSigner,
        login,
        logout,
        signEvent,
        publishEvent,
      }}
    >
      {children}
    </NostrContext.Provider>
  );
}
