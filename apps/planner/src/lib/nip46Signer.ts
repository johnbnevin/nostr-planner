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
 *  connection (DNS + TLS + handshake), especially on mobile networks. */
const NIP46_CONNECT_TIMEOUT_MS = 15_000;

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
    if (onAuth) {
      onAuth(authUrl);
    } else {
      try { window.open(authUrl, "_blank", "noopener,noreferrer"); }
      catch (err) { log.warn("could not open auth URL automatically:", err); }
    }
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
    signer: wrapBunkerSigner(bunker, userPubkey),
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
  const bp = await parseBunkerInput(bunkerUri);
  if (!bp) throw new Error("Invalid bunker URI");
  if (bp.relays.length === 0) throw new Error("Bunker URI has no relays");

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

  const bunker = BunkerSigner.fromBunker(sk, bp, { pool });

  // Bunker's connect RPC can hang if the bunker rejects a reused secret
  // silently (per NIP-46: "remote-signer SHOULD ignore new attempts to
  // establish connection with old secret"). Race against a wall-clock
  // timeout so the user gets an actionable error instead of an infinite
  // spinner when they paste a stale bunker:// URL.
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
    signer: wrapBunkerSigner(bunker, userPubkey),
    pubkey: userPubkey,
  };
}

/** Wrap nostr-tools' BunkerSigner in our NostrSigner interface. */
function wrapBunkerSigner(bunker: BunkerSigner, pubkey: string): NostrSigner {
  return {
    getPublicKey: () => Promise.resolve(pubkey),
    signEvent: async (event: UnsignedEvent): Promise<NostrEvent> => {
      return await bunker.signEvent(event) as unknown as NostrEvent;
    },
    nip44: {
      encrypt: (recipientPubkey: string, plaintext: string) =>
        bunker.nip44Encrypt(recipientPubkey, plaintext),
      decrypt: (senderPubkey: string, ciphertext: string) =>
        bunker.nip44Decrypt(senderPubkey, ciphertext),
    },
    destroy: async () => { await bunker.close(); },
  };
}

