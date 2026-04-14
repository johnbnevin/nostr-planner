/**
 * @module signer
 *
 * Core signer abstraction for the Nostr Planner application.
 *
 * This module defines the {@link NostrSigner} interface — the single contract
 * that every signing backend must implement. The rest of the application
 * programs exclusively against this interface so that the key-management
 * strategy can be swapped transparently:
 *
 * | Environment          | Implementation          | Key location                  |
 * |----------------------|-------------------------|-------------------------------|
 * | Browser (web build)  | {@link Nip07Signer}     | NIP-07 extension (nos2x, Alby)|
 * | Tauri (desktop/mobile)| `LocalSigner`          | In-memory, persisted via NIP-49|
 * | Any platform         | `Nip46Signer`           | Remote bunker app (Amber, etc.)|
 *
 * **Security model:** The private key never leaves the signer. All
 * cryptographic operations (event signing, NIP-44 encrypt/decrypt) are
 * performed inside the signer and only the results are returned.
 *
 * **NIP-44 requirement:** NIP-44 is mandatory for this application because
 * private calendar events are encrypted before publishing. A signer that
 * does not support NIP-44 cannot be used with private calendars.
 */

import type { NostrEvent } from "@nostrify/nostrify";

/**
 * A Nostr event that has not yet been signed.
 *
 * This is the minimal template the caller constructs before handing it to
 * a signer. The signer adds `pubkey`, `id`, and `sig` to produce a full
 * {@link NostrEvent}.
 */
export type UnsignedEvent = {
  /** NIP-01 event kind (e.g. 31922 for date-based calendar events). */
  kind: number;
  /** Unix timestamp in seconds when the event was created. */
  created_at: number;
  /** Array of NIP-01 tag arrays (e.g. `[["d", "..."], ["title", "..."]]`). */
  tags: string[][];
  /** Event content — may be plaintext or NIP-44 ciphertext depending on privacy setting. */
  content: string;
};

/**
 * Unified signer interface used across all platforms.
 *
 * Every implementation **must** provide:
 * - {@link getPublicKey} — return the user's hex-encoded public key.
 * - {@link signEvent} — sign an unsigned event template and return a fully
 *   formed Nostr event (with `id`, `pubkey`, and `sig` populated).
 * - {@link nip44} — NIP-44 versioned encryption used for private calendar
 *   events, shared-calendar key envelopes, and other encrypted payloads.
 *
 * Implementations **may** provide:
 * - {@link destroy} — release resources (zero key bytes, close WebSocket
 *   subscriptions). Callers should invoke this on logout.
 *
 * The interface is intentionally minimal so it can wrap very different
 * backends (browser extension, local key, remote bunker) without leaking
 * implementation details.
 */
export interface NostrSigner {
  /**
   * Return the user's public key as a 64-character hex string.
   *
   * This is safe to call repeatedly — implementations should cache
   * the result rather than re-deriving it each time.
   */
  getPublicKey(): Promise<string>;

  /**
   * Sign an unsigned event and return the complete signed {@link NostrEvent}.
   *
   * The signer fills in `pubkey`, computes the event `id` (SHA-256 of the
   * serialized event), and produces a Schnorr `sig` over the id.
   *
   * **Security:** The private key is used internally and never exposed.
   * For remote signers (NIP-46) the event template is sent to the bunker
   * over an encrypted channel for signing.
   *
   * @param event - The unsigned event template to sign.
   * @returns A fully signed Nostr event ready for relay publication.
   */
  signEvent(event: UnsignedEvent): Promise<NostrEvent>;

  /**
   * NIP-44 versioned encryption/decryption.
   *
   * Used for:
   * - Encrypting private calendar event content before publishing.
   * - Encrypting/decrypting shared-calendar AES-256-GCM key envelopes
   *   (kind 30078) so that calendar keys can be distributed securely.
   * - Any future end-to-end encrypted payloads.
   *
   * NIP-44 derives a conversation key from the sender's private key and
   * the recipient's public key using X25519 (ECDH on Curve25519), then
   * uses ChaCha20-Poly1305 for authenticated encryption.
   */
  nip44: {
    /**
     * Encrypt plaintext for a specific recipient.
     *
     * @param recipientPubkey - Hex-encoded public key of the intended reader.
     * @param plaintext - The cleartext string to encrypt.
     * @returns NIP-44 ciphertext (base64-encoded).
     */
    encrypt(recipientPubkey: string, plaintext: string): Promise<string>;

    /**
     * Decrypt ciphertext received from a specific sender.
     *
     * @param senderPubkey - Hex-encoded public key of the message author.
     * @param ciphertext - NIP-44 ciphertext (base64-encoded).
     * @returns The original plaintext string.
     */
    decrypt(senderPubkey: string, ciphertext: string): Promise<string>;
  };

  /**
   * Optional cleanup hook — implementations should release all sensitive
   * resources when called:
   *
   * - **LocalSigner:** Zeros the in-memory secret key bytes.
   * - **Nip46Signer:** Closes the WebSocket relay subscription used for
   *   the bunker communication channel.
   * - **Nip07Signer:** No-op (the extension manages its own lifecycle).
   *
   * Callers should invoke `destroy()` on logout to minimize the window
   * during which key material is resident in memory.
   */
  destroy?(): Promise<void>;
}

/**
 * Thin wrapper around `window.nostr` (NIP-07 browser extension).
 *
 * Used when running in a browser with a Nostr signing extension installed
 * (e.g. nos2x, Alby, Flamingo). The extension manages keys in its own
 * secure context — this class simply delegates every call to it.
 *
 * **Security considerations:**
 * - The private key never enters the application's JavaScript context.
 * - The extension may prompt the user for confirmation on each sign/encrypt
 *   call, depending on its configuration.
 * - If the extension is unloaded mid-session, methods will throw.
 *
 * **No `destroy()` method** is needed because no key material is held
 * by this class — the extension owns the key lifecycle.
 */
export class Nip07Signer implements NostrSigner {
  /**
   * Retrieve the public key from the browser extension.
   * @throws {Error} If no NIP-07 extension is detected on `window.nostr`.
   */
  async getPublicKey(): Promise<string> {
    if (!window.nostr) throw new Error("NIP-07 extension not found");
    return window.nostr.getPublicKey();
  }

  /**
   * Delegate event signing to the browser extension.
   *
   * The extension computes the event id and Schnorr signature internally.
   * Depending on user settings, the extension may show a confirmation dialog.
   *
   * @param event - Unsigned event template.
   * @returns Fully signed Nostr event.
   * @throws {Error} If no NIP-07 extension is detected.
   */
  async signEvent(event: UnsignedEvent): Promise<NostrEvent> {
    if (!window.nostr) throw new Error("NIP-07 extension not found");
    return window.nostr.signEvent(event) as Promise<NostrEvent>;
  }

  /** NIP-44 encrypt/decrypt delegated to the browser extension. */
  nip44 = {
    /**
     * Encrypt plaintext via the extension's NIP-44 implementation.
     * @throws {Error} If the extension does not support NIP-44.
     */
    encrypt: async (recipientPubkey: string, plaintext: string): Promise<string> => {
      if (!window.nostr?.nip44) throw new Error("NIP-44 not available in extension");
      return window.nostr.nip44.encrypt(recipientPubkey, plaintext);
    },
    /**
     * Decrypt ciphertext via the extension's NIP-44 implementation.
     * @throws {Error} If the extension does not support NIP-44.
     */
    decrypt: async (senderPubkey: string, ciphertext: string): Promise<string> => {
      if (!window.nostr?.nip44) throw new Error("NIP-44 not available in extension");
      return window.nostr.nip44.decrypt(senderPubkey, ciphertext);
    },
  };
}
