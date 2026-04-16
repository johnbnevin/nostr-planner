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
// requests from these and publish its responses back. relay.nsec.app is the
// de-facto NIP-46 relay supported by virtually every bunker (Amber, nsec.app,
// nsecbunker, etc.). The other two are widely reachable general-purpose
// relays that don't require NIP-42 AUTH for kind-24133 traffic.
const NIP46_RELAYS = [
  "wss://relay.nsec.app",
  "wss://relay.damus.io",
  "wss://nos.lol",
];

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

  const uri = createNostrConnectURI({
    clientPubkey,
    relays: NIP46_RELAYS,
    secret,
    name: 'Nostr Planner',
  });
  onUri(uri);
  log.info("waiting for signer to scan QR...");

  const pool = new SimplePool();

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
  const pool = new SimplePool();
  log.info("connecting via bunker URI...");

  const bunker = BunkerSigner.fromBunker(sk, bp, { pool });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await bunker.connect();
  } finally {
    clearTimeout(timer);
  }

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

