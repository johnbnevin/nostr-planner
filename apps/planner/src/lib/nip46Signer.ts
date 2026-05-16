/**
 * @module nip46Signer
 *
 * NIP-46 remote signing — implements the nostrconnect:// QR code flow
 * and bunker:// URI flow by delegating to nostr-tools' canonical
 * {@link BunkerSigner}. That implementation handles the persistent
 * subscription across handshake and RPC, `auth_url` per-action approval,
 * and relay switching — all of which we got wrong in earlier hand-rolled
 * versions, manifesting as get_public_key timeouts after the handshake.
 */

import { SimplePool } from "nostr-tools/pool";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { BunkerSigner, createNostrConnectURI, parseBunkerInput } from "nostr-tools/nip46";
import type { NostrEvent } from "@nostrify/nostrify";
import type { NostrSigner, UnsignedEvent } from "./signer";
import { logger } from "./logger";
import { emitAuthUrl } from "./authUrl";

const log = logger("nip46");

// NIP-46 relay choice matters: the bunker must be able to both read our
// requests from these and publish responses. Three relays give redundancy
// against one being slow/down — SimplePool's default 3-second connection
// timeout is aggressive, and if every listed relay fails to connect within
// that budget the whole handshake subscription collapses with "subscription
// closed before connection was established".
// NIP-46-friendly relays. relay.nsec.app is the de-facto default for most
// bunker apps (Amber, nsec.app). The others are widely reachable public
// relays that don't require NIP-42 AUTH for kind-24133 traffic, so a
// bunker scanning our nostrconnect:// URI can publish ack/response events
// to at least one of them even if its preferred relay is down.
const NIP46_RELAYS = [
  "wss://relay.nsec.app",
  "wss://relay.damus.io",
  "wss://nos.lol",
];

/** Longer relay-connect budget than SimplePool's 3-second default.
 *  Amber et al. commonly need several seconds on the first WebSocket
 *  connection (DNS + TLS + handshake), especially on mobile networks.
 *  30s gives enough headroom for 2G/lossy connections without feeling
 *  broken to users on fast connections. */
const NIP46_CONNECT_TIMEOUT_MS = 30_000;

// ── Public API ─────────────────────────────────────────────────────

/**
 * Connect via nostrconnect:// QR code flow (NIP-46).
 *
 * 1. Generates an ephemeral client key pair
 * 2. Builds a nostrconnect:// URI and passes it to onUri for QR display
 * 3. Subscribes on relays for the signer's connect response
 * 4. After handshake, sets up persistent RPC subscription
 * 5. Calls get_public_key to learn the user's actual pubkey
 */
export async function connectNostrSigner(
  signal: AbortSignal,
  onUri: (uri: string) => void,
  onAuth?: (authUrl: string) => void,
): Promise<{ signer: NostrSigner; pubkey: string }> {
  const sk = generateSecretKey();
  const clientPubkey = getPublicKey(sk);
  const secretBytes = crypto.getRandomValues(new Uint8Array(16));
  const secret = Array.from(secretBytes).map(b => b.toString(16).padStart(2, '0')).join('');

  // Request all permissions the app will ever need up front, so Amber-style
  // bunkers can prompt the user ONCE at connect time instead of on every
  // subsequent action. Scope:
  //   - sign_event: blossom upload auth (24242), backup reference (30078),
  //     public NIP-52 events (31922/31923), calendar collections (31924),
  //     shared events (30078), deletion events (5), RSVPs (31925).
  //   - nip44_encrypt: wrap the per-backup AES key.
  //   - nip44_decrypt: unwrap the AES key on restore/cold-load.
  const uri = createNostrConnectURI({
    clientPubkey,
    relays: NIP46_RELAYS,
    secret,
    name: 'Nostr Planner',
    perms: ['sign_event', 'nip44_encrypt', 'nip44_decrypt'],
  });

  // Pool with generous relay-connect timeout (default 3s is too tight —
  // a single slow relay can otherwise tank the whole handshake).
  // enablePing: keeps WebSockets alive across the (potentially long) window
  //   between showing the QR/URI and the user actually approving in Amber —
  //   without it, strfry closes idle sockets and the whole sub collapses.
  // enableReconnect: if a relay drops anyway, transparently re-dial.
  // maxWaitForConnection: raised from the 3s default because first-connect
  //   latency (DNS + TLS + WS handshake) can exceed that on mobile networks.
  const pool = new SimplePool({ enablePing: true, enableReconnect: true });
  pool.maxWaitForConnection = NIP46_CONNECT_TIMEOUT_MS;

  // Hand the URI to the UI only after the pool exists — the sub itself
  // isn't open until fromURI below, but pool creation is synchronous and
  // puts us one step closer to subscription-live before the user scans.
  onUri(uri);
  log.info("waiting for signer to scan QR...");

  // `onauth` is invoked by BunkerSigner when the remote signer replies with
  // `result: "auth_url"` — some bunkers (nsec.app, Amber with per-action
  // approval, etc.) require the user to visit a URL in the browser to
  // approve. Without an onauth callback, BunkerSigner silently keeps
  // waiting and the request appears to hang forever.
  const handleAuthUrl = (authUrl: string) => {
    log.info("signer requested auth at:", authUrl);
    // Always broadcast — the modal can render a user-gesture button which
    // is reliable on iOS/PWA where window.open silently fails.
    emitAuthUrl(authUrl);
    if (onAuth) onAuth(authUrl);
  };

  // Delegate the nostrconnect handshake AND all subsequent RPC to
  // nostr-tools' canonical BunkerSigner. It handles:
  //   - single persistent subscription reused across handshake + RPC,
  //     with a built-in stabilization delay after handshake,
  //   - `auth_url` responses routed through onauth,
  //   - relay switching when the bunker asks for different relays.
  const bunker = await BunkerSigner.fromURI(sk, uri, { pool, onauth: handleAuthUrl }, signal);

  log.info("handshake complete, bunker:", bunker.bp.pubkey.slice(0, 12));

  log.info("calling get_public_key...");
  const userPubkey = await bunker.getPublicKey();
  log.info("got pubkey:", userPubkey.slice(0, 12));

  return {
    signer: wrapBunkerSigner(bunker, userPubkey, pool),
    pubkey: userPubkey,
  };
}

/**
 * Connect via a bunker:// URI directly using nostr-tools' BunkerSigner.
 */
export async function connectBunkerUri(
  bunkerUri: string,
  timeoutMs = 120_000,
): Promise<{ signer: NostrSigner; pubkey: string }> {
  // Scheme guard — parseBunkerInput accepts bare hex/npub formats; we
  // only want canonical bunker:// URIs to avoid being tricked into
  // dialing arbitrary content from a malformed localStorage value.
  if (!/^bunker:\/\//i.test(bunkerUri)) throw new Error("Invalid bunker URI scheme");
  const bp = await parseBunkerInput(bunkerUri);
  if (!bp) throw new Error("Invalid bunker URI");
  if (bp.relays.length === 0) throw new Error("Bunker URI has no relays");
  // Every relay must be wss:// or ws:// — guard against javascript:, http:,
  // file:, or any other scheme sneaking through a permissive parser.
  for (const r of bp.relays) {
    if (!/^wss?:\/\//i.test(r)) throw new Error(`Invalid bunker relay scheme: ${r}`);
  }

  const sk = generateSecretKey();
  // enablePing: keeps WebSockets alive across the (potentially long) window
  //   between showing the QR/URI and the user actually approving in Amber —
  //   without it, strfry closes idle sockets and the whole sub collapses.
  // enableReconnect: if a relay drops anyway, transparently re-dial.
  // maxWaitForConnection: raised from the 3s default because first-connect
  //   latency (DNS + TLS + WS handshake) can exceed that on mobile networks.
  const pool = new SimplePool({ enablePing: true, enableReconnect: true });
  pool.maxWaitForConnection = NIP46_CONNECT_TIMEOUT_MS;
  log.info("connecting via bunker URI...");

  // Wire onauth through the global broadcaster so a modal can show the
  // approval prompt with a real user-gesture click. Without this, mobile
  // PWAs silently hang when the bunker requests auth on reconnect.
  const bunker = BunkerSigner.fromBunker(sk, bp, {
    pool,
    onauth: (authUrl: string) => emitAuthUrl(authUrl),
  });

  // Bunker's connect RPC can hang if the bunker rejects a reused secret
  // silently (per NIP-46: "remote-signer SHOULD ignore new attempts to
  // establish connection with old secret"). Race against a wall-clock
  // timeout so the user gets an actionable error instead of an infinite
  // spinner when they paste a stale bunker:// URL. On any error path we
  // must close the pool to avoid leaking 2-3 WebSocket connections per
  // failed attempt — the reconnect ladder calls this up to 8 times in a
  // row, so leaks accumulate fast.
  try {
    await Promise.race([
      bunker.connect(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(
          "Bunker connect timed out. If you've logged in with this URL " +
          "before, generate a fresh bunker URL from your signer and try again."
        )), timeoutMs)
      ),
    ]);

    log.info("bunker connected");
    const userPubkey = await bunker.getPublicKey();
    log.info("got pubkey:", userPubkey.slice(0, 12));

    return {
      signer: wrapBunkerSigner(bunker, userPubkey, pool),
      pubkey: userPubkey,
    };
  } catch (err) {
    // Tear down the pool's WebSocket connections so the next ladder
    // attempt starts from a clean slate. close() returns a promise but
    // we don't await it on the error path — it's best-effort cleanup.
    try { await pool.close([...bp.relays]); } catch { /* best effort */ }
    throw err;
  }
}

/**
 * Per-sign timeout. Amber occasionally drops the first sign after a long
 * idle window (relay subscription went stale, Amber app was paused). One
 * retry typically recovers; longer hangs surface to the user instead of
 * spinning forever.
 */
const SIGN_TIMEOUT_MS = 30_000;

/** Race a promise against an AbortController-backed timeout. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/** Wrap nostr-tools' BunkerSigner in our NostrSigner interface.
 *  The `pool` is the SimplePool the bunker is talking through — owned by
 *  this signer so destroy() can close its sockets cleanly on logout. */
function wrapBunkerSigner(bunker: BunkerSigner, pubkey: string, pool?: SimplePool): NostrSigner {
  return {
    getPublicKey: () => Promise.resolve(pubkey),
    signEvent: async (event: UnsignedEvent): Promise<NostrEvent> => {
      // First attempt with a hard timeout. A hang here is the most common
      // Amber-on-mobile symptom — the relay sub appears alive but the
      // bunker never answers. One retry covers the transient case;
      // anything beyond that should propagate so the outbox / UI can
      // react instead of spinning indefinitely.
      try {
        return await withTimeout(bunker.signEvent(event), SIGN_TIMEOUT_MS, "signEvent") as unknown as NostrEvent;
      } catch (err) {
        log.warn("signEvent first attempt failed, retrying once:", err instanceof Error ? err.message : err);
        return await withTimeout(bunker.signEvent(event), SIGN_TIMEOUT_MS, "signEvent (retry)") as unknown as NostrEvent;
      }
    },
    nip44: {
      encrypt: (recipientPubkey: string, plaintext: string) =>
        bunker.nip44Encrypt(recipientPubkey, plaintext),
      decrypt: (senderPubkey: string, ciphertext: string) =>
        bunker.nip44Decrypt(senderPubkey, ciphertext),
    },
    destroy: async () => {
      try { await bunker.close(); } catch { /* ignore */ }
      // Close the pool's WebSocket connections too. Without this, the
      // sockets linger until GC even after the signer is "destroyed".
      if (pool) {
        try {
          // SimplePool exposes its relay list internally; we don't have
          // the URL list here but close() with an empty array still
          // drops the active relays it knows about in current nostr-tools.
          await pool.close(Array.from((pool as unknown as { relays?: Map<string, unknown> }).relays?.keys?.() ?? []));
        } catch { /* ignore */ }
      }
    },
  };
}

// ── Persistent reconnect ladder ─────────────────────────────────────

/** Backoff schedule for reconnect attempts. ±20% jitter applied at use. */
const RECONNECT_DELAYS_MS = [2_000, 4_000, 8_000, 16_000, 30_000, 60_000, 120_000, 300_000];

/** Per-attempt connect budget — shorter than the default 120s so a dead
 *  relay set fails fast and we get to the next ladder rung. */
const RECONNECT_ATTEMPT_TIMEOUT_MS = 20_000;

/** Status updates emitted to the caller during the reconnect process. */
export type ReconnectStatus =
  | { phase: "attempting"; attempt: number; maxAttempts: number }
  | { phase: "waiting"; nextDelayMs: number; nextAttempt: number; maxAttempts: number; lastError?: string }
  | { phase: "paused"; reason: "offline" | "hidden" }
  | { phase: "success" }
  | { phase: "exhausted"; lastError: string };

export interface ReconnectOptions {
  /** Required: the bunker URI saved at login. */
  bunkerUrl: string;
  /** Required: the user's pubkey at login — abort if a fresh connect returns a different one. */
  expectedPubkey: string;
  /** Optional: caller can abort the ladder (logout, switch account). */
  signal?: AbortSignal;
  /** Status updates for UI. */
  onStatus?: (status: ReconnectStatus) => void;
}

/**
 * Persistently attempt to restore a bunker session, using exponential
 * backoff with jitter. Pauses while the page is hidden or the device is
 * offline (no point burning battery dialing a dead network) and resumes
 * the moment either condition clears.
 *
 * The ladder stops on:
 *   - Success → returns the new signer + pubkey.
 *   - Pubkey mismatch (security) → throws.
 *   - The caller-supplied signal aborts → throws AbortError.
 *   - All attempts exhausted → throws.
 */
export async function reconnectBunkerWithBackoff(
  opts: ReconnectOptions
): Promise<{ signer: NostrSigner; pubkey: string }> {
  const { bunkerUrl, expectedPubkey, signal, onStatus } = opts;
  const maxAttempts = RECONNECT_DELAYS_MS.length;
  let lastError: string = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    await waitForOnlineAndVisible(signal, onStatus);

    onStatus?.({ phase: "attempting", attempt, maxAttempts });
    try {
      const result = await connectBunkerUri(bunkerUrl, RECONNECT_ATTEMPT_TIMEOUT_MS);
      if (signal?.aborted) {
        await result.signer.destroy?.();
        throw new DOMException("aborted", "AbortError");
      }
      if (result.pubkey !== expectedPubkey) {
        await result.signer.destroy?.();
        throw new Error("bunker returned different pubkey than expected");
      }
      onStatus?.({ phase: "success" });
      return result;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      lastError = err instanceof Error ? err.message : String(err);
      log.warn(`reconnect attempt ${attempt}/${maxAttempts} failed: ${lastError}`);
    }

    if (attempt < maxAttempts) {
      const base = RECONNECT_DELAYS_MS[attempt - 1];
      const jitter = base * (0.8 + Math.random() * 0.4);
      const delay = Math.round(jitter);
      onStatus?.({ phase: "waiting", nextDelayMs: delay, nextAttempt: attempt + 1, maxAttempts, lastError });
      await sleep(delay, signal);
    }
  }

  onStatus?.({ phase: "exhausted", lastError });
  throw new Error(`bunker reconnect exhausted after ${maxAttempts} attempts: ${lastError}`);
}

/** Sleep that aborts cleanly if signal fires. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException("aborted", "AbortError")); return; }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Block until both `document.visibilityState === "visible"` and
 * `navigator.onLine !== false`. Emits a paused status so the UI can
 * tell the user we're waiting on them (e.g. "Reconnecting will resume
 * when this tab is in the foreground"). Resolves immediately if both
 * conditions are already true.
 */
async function waitForOnlineAndVisible(
  signal: AbortSignal | undefined,
  onStatus: ((s: ReconnectStatus) => void) | undefined,
): Promise<void> {
  const ok = () =>
    (typeof document === "undefined" || document.visibilityState === "visible") &&
    (typeof navigator === "undefined" || navigator.onLine !== false);
  if (ok()) return;

  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    onStatus?.({ phase: "paused", reason: "offline" });
  } else {
    onStatus?.({ phase: "paused", reason: "hidden" });
  }

  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException("aborted", "AbortError")); return; }
    const cleanup = () => {
      window.removeEventListener("online", check);
      document.removeEventListener("visibilitychange", check);
      signal?.removeEventListener("abort", onAbort);
    };
    const check = () => {
      if (ok()) { cleanup(); resolve(); }
    };
    const onAbort = () => { cleanup(); reject(new DOMException("aborted", "AbortError")); };
    window.addEventListener("online", check);
    document.addEventListener("visibilitychange", check);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

