/**
 * @module nip46Signer
 *
 * NIP-46 remote signing — implements the nostrconnect:// QR code flow
 * and bunker:// URI flow per the NIP-46 spec, using nostr-tools SimplePool
 * for relay communication and NIP-44 for encryption.
 *
 * Uses a persistent subscription model (like nostr-tools BunkerSigner)
 * so that the relay connection stays alive across handshake and RPC calls.
 */

import { SimplePool } from "nostr-tools/pool";
import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools/pure";
import * as nip44 from "nostr-tools/nip44";
import type { NostrEvent } from "@nostrify/nostrify";
import type { NostrSigner, UnsignedEvent } from "./signer";
import { logger } from "./logger";

const log = logger("nip46");

const NIP46_RELAYS = [
  "wss://nos.lol",
  "wss://relay.damus.io",
  "wss://relay.ditto.pub",
];

/** NIP-46 uses kind 24133 for all RPC messages. */
const KIND_NIP46 = 24133;

// ── Internal RPC engine ────────────────────────────────────────────

interface RpcEngine {
  sendRequest(method: string, params: string[]): Promise<string>;
  close(): void;
}

/**
 * Create an RPC engine that communicates with a remote signer via NIP-46.
 *
 * Opens a persistent subscription on the given relays for responses from
 * the bunker. Requests are published as kind-24133 events encrypted with
 * NIP-44. The subscription stays alive for the lifetime of the engine.
 */
function createRpcEngine(
  pool: SimplePool,
  relays: string[],
  clientSecretKey: Uint8Array,
  bunkerPubkey: string,
): RpcEngine {
  const clientPubkey = getPublicKey(clientSecretKey);
  const conversationKey = nip44.v2.utils.getConversationKey(clientSecretKey, bunkerPubkey);

  // Pending RPC responses keyed by request ID
  const pending = new Map<string, {
    resolve: (result: string) => void;
    reject: (err: Error) => void;
  }>();

  let serial = 0;
  const idPrefix = Math.random().toString(36).slice(2, 8);

  // Persistent subscription for all RPC responses from the bunker.
  // Uses pool.subscribe (same pattern as nostr-tools BunkerSigner).
  const sub = pool.subscribe(
    relays,
    { kinds: [KIND_NIP46], authors: [bunkerPubkey], "#p": [clientPubkey], limit: 0 },
    {
      onevent: (event: { pubkey: string; content: string }) => {
        try {
          const decrypted = nip44.v2.decrypt(event.content, conversationKey);
          const response = JSON.parse(decrypted);
          const handler = pending.get(response.id);
          if (handler) {
            pending.delete(response.id);
            if (response.error) {
              handler.reject(new Error(response.error));
            } else {
              handler.resolve(response.result);
            }
          }
        } catch {
          // Not our response or decryption failed — ignore
        }
      },
    },
  );

  return {
    async sendRequest(method: string, params: string[]): Promise<string> {
      serial++;
      const id = `${idPrefix}-${serial}`;

      const request = JSON.stringify({ id, method, params });
      const encrypted = nip44.v2.encrypt(request, conversationKey);

      const event = finalizeEvent(
        {
          kind: KIND_NIP46,
          tags: [["p", bunkerPubkey]],
          content: encrypted,
          created_at: Math.floor(Date.now() / 1000),
        },
        clientSecretKey,
      );

      const result = new Promise<string>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        // Timeout after 3 minutes — remote signers like Amber may require
        // user approval for each operation, which takes time.
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`NIP-46 request "${method}" timed out after 180s`));
          }
        }, 180_000);
      });

      // Publish to all relays — pool.publish returns an array of promises,
      // one per relay. We succeed if at least one relay accepts.
      const publishPromises = pool.publish(relays, event);
      try {
        await Promise.race(publishPromises);
      } catch {
        pending.delete(id);
        throw new Error(`Failed to publish NIP-46 request "${method}" to any relay`);
      }

      return result;
    },

    close() {
      sub.close();
      for (const [id, handler] of pending) {
        handler.reject(new Error("RPC engine closed"));
        pending.delete(id);
      }
    },
  };
}

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
): Promise<{ signer: NostrSigner; pubkey: string }> {
  const sk = generateSecretKey();
  const clientPubkey = getPublicKey(sk);
  const secretBytes = crypto.getRandomValues(new Uint8Array(16));
  const secret = Array.from(secretBytes).map(b => b.toString(16).padStart(2, '0')).join('');

  const params = new URLSearchParams();
  for (const r of NIP46_RELAYS) params.append('relay', r);
  params.append('secret', secret);
  params.append('name', 'Nostr Planner');

  const uri = `nostrconnect://${clientPubkey}?${params.toString()}`;
  onUri(uri);

  log.info("waiting for signer to scan QR...");

  // Use SimplePool for the handshake — it manages WebSocket lifecycle
  // properly and doesn't suffer from NRelay1's abort controller issues.
  const pool = new SimplePool();

  // Wait for the signer's connect response
  const bunkerPubkey = await new Promise<string>((resolve, reject) => {
    const onAbort = () => { sub.close(); reject(new Error("aborted")); };
    signal.addEventListener("abort", onAbort, { once: true });

    const sub = pool.subscribe(
      NIP46_RELAYS,
      { kinds: [KIND_NIP46], "#p": [clientPubkey], limit: 0 },
      {
        onevent: (event: { pubkey: string; content: string }) => {
          try {
            const convKey = nip44.v2.utils.getConversationKey(sk, event.pubkey);
            const decrypted = nip44.v2.decrypt(event.content, convKey);
            const response = JSON.parse(decrypted);
            if (typeof response === "object" && response !== null && response.result === secret) {
              signal.removeEventListener("abort", onAbort);
              sub.close();
              resolve(event.pubkey);
            }
          } catch {
            // Not our response or decryption failed
          }
        },
      },
    );
  });

  log.info("handshake complete, bunker:", bunkerPubkey.slice(0, 12));

  // Set up persistent RPC engine for ongoing communication
  const rpc = createRpcEngine(pool, NIP46_RELAYS, sk, bunkerPubkey);

  log.info("calling get_public_key...");
  const userPubkey = await rpc.sendRequest("get_public_key", []);
  log.info("got pubkey:", userPubkey.slice(0, 12));

  return {
    signer: wrapRpcEngine(rpc, userPubkey),
    pubkey: userPubkey,
  };
}

/**
 * Connect via a bunker:// or nostrconnect:// URI directly.
 */
export async function connectBunkerUri(
  bunkerUri: string,
  timeoutMs = 120_000,
): Promise<{ signer: NostrSigner; pubkey: string }> {
  const sk = generateSecretKey();

  const url = new URL(bunkerUri);
  const bunkerPubkey = url.hostname || url.pathname.replace("//", "");
  const relayUrls = url.searchParams.getAll("relay");
  const urlSecret = url.searchParams.get("secret") || undefined;

  if (!bunkerPubkey || relayUrls.length === 0) {
    throw new Error("Invalid bunker URI — must contain a pubkey and at least one relay");
  }

  log.info("connecting via bunker URI...");

  const pool = new SimplePool();
  const rpc = createRpcEngine(pool, relayUrls, sk, bunkerPubkey);

  // Send connect command (required for bunker:// flow)
  const connectParams = [bunkerPubkey];
  if (urlSecret) connectParams.push(urlSecret);

  const connectResult = await Promise.race([
    rpc.sendRequest("connect", connectParams),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Bunker connection timed out")), timeoutMs)
    ),
  ]);

  if (connectResult !== "ack" && connectResult !== urlSecret) {
    log.warn("unexpected connect result:", connectResult);
  }

  log.info("bunker connected");
  const userPubkey = await rpc.sendRequest("get_public_key", []);
  log.info("got pubkey:", userPubkey.slice(0, 12));

  return {
    signer: wrapRpcEngine(rpc, userPubkey),
    pubkey: userPubkey,
  };
}

/** Wrap an RPC engine into our NostrSigner interface. */
function wrapRpcEngine(rpc: RpcEngine, pubkey: string): NostrSigner {
  return {
    getPublicKey: () => Promise.resolve(pubkey),

    signEvent: async (event: UnsignedEvent): Promise<NostrEvent> => {
      const result = await rpc.sendRequest("sign_event", [JSON.stringify(event)]);
      return JSON.parse(result) as NostrEvent;
    },

    nip44: {
      encrypt: (recipientPubkey: string, plaintext: string) =>
        rpc.sendRequest("nip44_encrypt", [recipientPubkey, plaintext]),
      decrypt: (senderPubkey: string, ciphertext: string) =>
        rpc.sendRequest("nip44_decrypt", [senderPubkey, ciphertext]),
    },

    destroy: async () => { rpc.close(); },
  };
}
