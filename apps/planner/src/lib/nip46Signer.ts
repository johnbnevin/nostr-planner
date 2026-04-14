/**
 * @module nip46Signer
 *
 * NIP-46 remote signer — delegates all signing and encryption to an
 * external "bunker" signer application (e.g. Amber on Android, Nsec.app,
 * or any other NIP-46-compatible remote signer).
 *
 * ## Why remote signing?
 *
 * Remote signing keeps the user's private key on a device they trust
 * (typically their phone) while allowing this web/desktop app to request
 * signatures over an encrypted relay channel. The private key **never**
 * enters the planner's JavaScript context.
 *
 * ## NIP-46 protocol overview
 *
 * NIP-46 defines a JSON-RPC-like protocol tunneled through Nostr relay
 * messages (kind 24133). The flow works as follows:
 *
 * 1. **Client (this app) generates an ephemeral key pair** — used solely
 *    for the encrypted communication channel with the bunker. This key is
 *    not the user's identity key.
 *
 * 2. **Client builds a `nostrconnect://` URI** containing:
 *    - The client's ephemeral public key.
 *    - One or more relay URLs where the client is listening.
 *    - A random `secret` (shared out-of-band via QR code) to authenticate
 *      the bunker's first response and prevent impersonation.
 *    - The application name ("Nostr Planner").
 *
 * 3. **User scans the QR code** with their bunker app. The bunker:
 *    - Connects to the specified relays.
 *    - Sends a NIP-44-encrypted `connect` response containing the secret
 *      and the user's public key.
 *
 * 4. **Handshake completes** — `BunkerSigner.fromURI()` resolves once it
 *    receives the bunker's `connect` response with a matching secret.
 *
 * 5. **Ongoing RPC** — Each `signEvent`, `nip44Encrypt`, or `nip44Decrypt`
 *    call sends a NIP-44-encrypted JSON-RPC request (kind 24133) to the
 *    bunker via the relay, and awaits the encrypted response.
 *
 * ## Security considerations
 *
 * - The user's private key never leaves the bunker device.
 * - All RPC messages are NIP-44 encrypted end-to-end between the
 *   client's ephemeral key and the bunker's key.
 * - The shared `secret` in the URI prevents a relay operator from
 *   injecting a rogue bunker response during the initial handshake.
 * - The ephemeral key is generated fresh on every `connect()` call,
 *   so there is no long-lived client key to compromise.
 * - The relay sees only opaque encrypted blobs — it cannot read the
 *   event content or the signing requests.
 *
 * ## Usage
 *
 * ```ts
 * const signer = await Nip46Signer.connect((uri) => showQrCode(uri));
 * // User scans QR with Amber / Nsec.app — connect() resolves when
 * // the bunker completes the handshake.
 * const pubkey = await signer.getPublicKey();
 * const signed = await signer.signEvent(unsignedEvent);
 * ```
 */

import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { BunkerSigner, createNostrConnectURI } from "nostr-tools/nip46";
import { bytesToHex } from "@noble/hashes/utils";
import type { NostrEvent } from "@nostrify/nostrify";
import type { NostrSigner, UnsignedEvent } from "./signer";
import { DEFAULT_RELAYS } from "./nostr";

/**
 * Relays used for the NIP-46 handshake and ongoing RPC channel.
 *
 * Uses all default relays so the handshake succeeds even if some relays
 * are temporarily unavailable. Both the client and the bunker must be
 * able to reach at least one of these relays.
 */
const NIP46_RELAYS = DEFAULT_RELAYS;

/**
 * A {@link NostrSigner} implementation that delegates all cryptographic
 * operations to an external NIP-46 bunker signer.
 *
 * Instances are created exclusively via the async {@link connect} factory,
 * which performs the full bunker handshake before returning.
 *
 * **No private key is held by this class.** All signing and encryption
 * happens on the remote bunker device.
 */
export class Nip46Signer implements NostrSigner {
  /** The underlying nostr-tools BunkerSigner that manages the relay RPC channel. */
  private readonly bunker: BunkerSigner;

  /**
   * The `nostrconnect://` URI generated during {@link connect}.
   *
   * Retained so the UI can re-display the QR code if needed (e.g. if the
   * user navigates away and comes back before the bunker connects).
   */
  readonly connectionUri: string;

  /**
   * Private constructor — use {@link connect} to create instances.
   *
   * @param bunker - A fully connected BunkerSigner instance.
   * @param connectionUri - The nostrconnect:// URI used for this session.
   */
  private constructor(bunker: BunkerSigner, connectionUri: string) {
    this.bunker = bunker;
    this.connectionUri = connectionUri;
  }

  /**
   * Initiate a NIP-46 remote signer connection.
   *
   * This method orchestrates the full bunker handshake:
   *
   * 1. **Generate an ephemeral key pair** — this is the client-side key
   *    used only for the NIP-44 encrypted communication channel. It is
   *    not the user's Nostr identity.
   *
   * 2. **Generate a random shared secret** — 16 random bytes (hex-encoded,
   *    32 characters). This secret is embedded in the QR code URI and
   *    must be echoed back by the bunker in its `connect` response,
   *    proving the bunker scanned the correct QR code.
   *
   * 3. **Build the `nostrconnect://` URI** containing the ephemeral
   *    public key, relay URLs, secret, and app name.
   *
   * 4. **Call `onUri` immediately** so the UI can display the QR code
   *    while we wait for the bunker to connect.
   *
   * 5. **Wait for the bunker's `connect` response** via
   *    `BunkerSigner.fromURI()`. This blocks until the remote signer
   *    app (Amber, Nsec.app, etc.) scans the QR code and responds,
   *    or until `timeoutMs` elapses.
   *
   * @param onUri - Callback invoked with the `nostrconnect://` URI string
   *   as soon as it is generated. Typically used to render a QR code.
   * @param timeoutMs - Maximum milliseconds to wait for the bunker to
   *   respond (default: 5 minutes / 300,000 ms). If the timeout expires,
   *   the returned promise rejects.
   * @returns A fully connected Nip46Signer ready for signing operations.
   * @throws {Error} If the bunker does not respond within the timeout.
   */
  static async connect(
    onUri: (uri: string) => void,
    timeoutMs = 300_000,
    bunkerUri?: string
  ): Promise<Nip46Signer> {
    // If a bunker:// or nostrconnect:// URI was provided, connect directly
    if (bunkerUri) {
      const secretKey = generateSecretKey();
      const bunker = await BunkerSigner.fromURI(secretKey, bunkerUri, {}, timeoutMs);
      return new Nip46Signer(bunker, bunkerUri);
    }

    // Step 1: Ephemeral key pair for the encrypted NIP-46 channel
    const secretKey = generateSecretKey();
    const clientPubkey = getPublicKey(secretKey);

    // Step 2: Random shared secret to authenticate the bunker's response
    const secret = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));

    // Step 3: Build the nostrconnect:// URI
    const uri = createNostrConnectURI({
      clientPubkey,
      relays: NIP46_RELAYS,
      secret,
      name: "Nostr Planner",
    });

    // Step 4: Hand the URI to the caller for QR code display
    onUri(uri);

    // Step 5: Wait for the bunker to connect and complete the handshake
    const bunker = await BunkerSigner.fromURI(secretKey, uri, {}, timeoutMs);
    return new Nip46Signer(bunker, uri);
  }

  /**
   * Retrieve the user's public key from the remote bunker.
   *
   * On the first call this sends a `get_public_key` RPC to the bunker.
   * The BunkerSigner implementation in nostr-tools caches the result
   * for subsequent calls.
   */
  async getPublicKey(): Promise<string> {
    return this.bunker.getPublicKey();
  }

  /**
   * Send an unsigned event to the remote bunker for signing.
   *
   * The event template is NIP-44 encrypted, sent as a kind 24133 message
   * to the bunker via the relay, and the bunker responds with the fully
   * signed event (also encrypted). The bunker app may prompt the user
   * for approval depending on its configuration.
   *
   * @param event - Unsigned event template.
   * @returns The fully signed Nostr event from the bunker.
   */
  async signEvent(event: UnsignedEvent): Promise<NostrEvent> {
    return this.bunker.signEvent(event) as Promise<NostrEvent>;
  }

  /**
   * NIP-44 encrypt/decrypt delegated to the remote bunker.
   *
   * These operations are performed on the bunker device using the user's
   * actual private key. The plaintext/ciphertext is transmitted over the
   * NIP-44-encrypted NIP-46 channel, so the relay never sees it in the clear.
   */
  nip44 = {
    /**
     * Request the bunker to NIP-44-encrypt plaintext for a recipient.
     *
     * @param recipientPubkey - Hex public key of the intended reader.
     * @param plaintext - Cleartext to encrypt.
     * @returns NIP-44 ciphertext produced by the bunker.
     */
    encrypt: async (recipientPubkey: string, plaintext: string): Promise<string> => {
      return this.bunker.nip44Encrypt(recipientPubkey, plaintext);
    },
    /**
     * Request the bunker to NIP-44-decrypt ciphertext from a sender.
     *
     * @param senderPubkey - Hex public key of the message author.
     * @param ciphertext - NIP-44 ciphertext to decrypt.
     * @returns The original plaintext string.
     */
    decrypt: async (senderPubkey: string, ciphertext: string): Promise<string> => {
      return this.bunker.nip44Decrypt(senderPubkey, ciphertext);
    },
  };

  /**
   * Close the WebSocket relay subscription used for the NIP-46 RPC channel.
   *
   * After calling this, no further signing or encryption requests can be
   * made. Call this on logout to free network resources.
   */
  async close(): Promise<void> {
    await this.bunker.close();
  }

  /**
   * Implements the {@link NostrSigner.destroy} contract by closing the
   * relay connection.
   *
   * Unlike {@link LocalSigner.destroy}, there is no key material to zero
   * here — the ephemeral channel key was only held by the BunkerSigner
   * internals and is released when the bunker is closed.
   */
  async destroy(): Promise<void> {
    await this.close();
  }
}
