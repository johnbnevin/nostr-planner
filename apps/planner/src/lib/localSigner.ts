/**
 * @module localSigner
 *
 * Local key signer — signs Nostr events using a private key held in memory.
 *
 * This is the signer used in Tauri (desktop/mobile) builds when the user
 * chooses to log in with an `nsec` or hex private key. It is **never**
 * instantiated in the web build — browser users rely on a NIP-07 extension
 * or a NIP-46 remote signer instead.
 *
 * ## Key lifecycle
 *
 * 1. **Import:** The user provides an `nsec1...` or raw hex key. The class
 *    decodes it into a 32-byte `Uint8Array` held in {@link LocalSigner.secretKey}.
 * 2. **Persist (optional):** {@link saveToStore} encrypts the key using
 *    NIP-49 (`nip49.encrypt`) and writes the resulting `ncryptsec1...`
 *    string to the Tauri plugin-store file (`planner.json`).
 * 3. **Restore:** On next launch, {@link loadFromStore} reads the
 *    `ncryptsec1...` string and decrypts it with the user's password
 *    via `nip49.decrypt`, reconstructing the signer.
 * 4. **Destroy:** On logout, {@link destroy} fills the key bytes with
 *    zeros to reduce the window of exposure in memory.
 *
 * ## NIP-49 storage format
 *
 * NIP-49 defines a password-based encryption scheme for Nostr private keys:
 *
 * - **Encryption:** `scrypt(password, salt)` derives a 32-byte key, which
 *   is used with XChaCha20-Poly1305 to encrypt the 32-byte secret key.
 *   The result is bech32-encoded with the `ncryptsec` prefix.
 * - **Decryption:** The bech32 payload is decoded, scrypt re-derives the
 *   key from the password + embedded salt, and XChaCha20-Poly1305 decrypts
 *   the secret key bytes.
 * - **Why NIP-49?** It is the Nostr-native standard for encrypted key
 *   storage, supported by most key-management tools. Using it means
 *   the stored blob is portable — the user could import it into another
 *   NIP-49-aware client.
 *
 * ## Security considerations
 *
 * - The raw 32-byte secret key lives in JavaScript heap memory for the
 *   lifetime of the signer. JavaScript does not guarantee secure erasure,
 *   so `destroy()` is best-effort.
 * - The Tauri plugin-store file lives on the local filesystem. The
 *   NIP-49 encryption protects it at rest, but the password strength is
 *   the user's responsibility.
 * - In the web build, `isTauri()` returns false and all store operations
 *   silently no-op, preventing accidental key exposure in the browser.
 */

import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools/pure";
import { decode } from "nostr-tools/nip19";
import * as nip44 from "nostr-tools/nip44";
import * as nip49 from "nostr-tools/nip49";
import { hexToBytes } from "@noble/hashes/utils";
import type { NostrEvent } from "@nostrify/nostrify";
import type { NostrSigner, UnsignedEvent } from "./signer";
import { isTauri } from "./platform";

/** Filename for the Tauri plugin-store JSON file on disk. */
const STORE_FILE = "planner.json";

/** Key under which the NIP-49 ncryptsec string is stored in the JSON file. */
const STORE_KEY = "ncryptsec";

/**
 * A {@link NostrSigner} implementation that holds the private key directly
 * in memory and performs all cryptographic operations locally.
 *
 * Construct via one of the static factories:
 * - {@link fromKey} — from an `nsec1...` or hex string.
 * - {@link generate} — create a brand-new random identity.
 * - {@link loadFromStore} — restore a previously persisted key.
 */
export class LocalSigner implements NostrSigner {
  /**
   * Raw 32-byte secp256k1 secret key.
   *
   * This is the most sensitive field in the entire application. It is
   * zeroed on {@link destroy} and should never be logged or serialized
   * in plaintext.
   */
  private secretKey: Uint8Array;

  /** Cached hex-encoded public key derived from {@link secretKey}. */
  private _pubkey: string;

  /**
   * Create a signer from raw key bytes.
   *
   * Prefer the static factories ({@link fromKey}, {@link generate},
   * {@link loadFromStore}) over calling this constructor directly.
   *
   * @param secretKey - 32-byte secp256k1 private key.
   */
  constructor(secretKey: Uint8Array) {
    this.secretKey = secretKey;
    this._pubkey = getPublicKey(secretKey);
  }

  /**
   * Parse an `nsec1...` (NIP-19 bech32) or 64-character hex private key
   * string and return a new {@link LocalSigner}.
   *
   * @param nsecOrHex - Either an `nsec1`-prefixed bech32 string or a
   *   64-character lowercase hex string representing the secret key.
   * @returns A new LocalSigner instance.
   * @throws {Error} If the bech32 prefix is not `nsec` or the hex is invalid.
   */
  static fromKey(nsecOrHex: string): LocalSigner {
    if (nsecOrHex.startsWith("nsec")) {
      // NIP-19 bech32 decoding — extract the raw 32-byte key
      const decoded = decode(nsecOrHex);
      if (decoded.type !== "nsec") throw new Error("Invalid nsec");
      return new LocalSigner(decoded.data);
    }
    // Assume raw hex — convert to bytes
    return new LocalSigner(hexToBytes(nsecOrHex));
  }

  /**
   * Generate a brand-new random secp256k1 key pair.
   *
   * Useful for first-time users who don't have an existing Nostr identity,
   * or for automated tests.
   *
   * @returns A new LocalSigner backed by a cryptographically random key.
   */
  static generate(): LocalSigner {
    return new LocalSigner(generateSecretKey());
  }

  /**
   * Return the hex-encoded public key.
   *
   * This is a synchronous lookup from the cached value — no crypto
   * is performed on repeated calls.
   */
  async getPublicKey(): Promise<string> {
    return this._pubkey;
  }

  /**
   * Sign an unsigned event locally using the in-memory secret key.
   *
   * Internally calls `finalizeEvent` from nostr-tools, which:
   * 1. Serializes the event per NIP-01.
   * 2. Computes the SHA-256 event `id`.
   * 3. Produces a Schnorr signature (`sig`) over the id.
   *
   * @param event - Unsigned event template (kind, created_at, tags, content).
   * @returns A fully signed {@link NostrEvent} ready for relay publication.
   */
  async signEvent(event: UnsignedEvent): Promise<NostrEvent> {
    const template = { ...event, pubkey: this._pubkey };
    return finalizeEvent(template, this.secretKey) as unknown as NostrEvent;
  }

  /**
   * NIP-44 encrypt/decrypt using the local secret key.
   *
   * Each operation first derives a shared "conversation key" via X25519
   * ECDH between this signer's secret key and the counterparty's public
   * key, then uses ChaCha20-Poly1305 for authenticated encryption.
   */
  nip44 = {
    /**
     * Encrypt plaintext for a specific recipient.
     *
     * @param recipientPubkey - Hex public key of the intended reader.
     * @param plaintext - Cleartext to encrypt.
     * @returns Base64-encoded NIP-44 ciphertext.
     */
    encrypt: async (recipientPubkey: string, plaintext: string): Promise<string> => {
      // Derive the shared secret via ECDH (our secret key + their public key)
      const convKey = nip44.getConversationKey(this.secretKey, recipientPubkey);
      // Encrypt with ChaCha20-Poly1305 using a random nonce
      return nip44.encrypt(plaintext, convKey);
    },
    /**
     * Decrypt ciphertext received from a specific sender.
     *
     * @param senderPubkey - Hex public key of the message author.
     * @param ciphertext - Base64-encoded NIP-44 ciphertext.
     * @returns The original plaintext string.
     */
    decrypt: async (senderPubkey: string, ciphertext: string): Promise<string> => {
      // Derive the same shared secret (ECDH is commutative)
      const convKey = nip44.getConversationKey(this.secretKey, senderPubkey);
      // Decrypt and verify the Poly1305 authentication tag
      return nip44.decrypt(ciphertext, convKey);
    },
  };

  /**
   * Best-effort zeroing of key material in memory.
   *
   * Fills the secret key `Uint8Array` with zeros and clears the cached
   * public key string. This reduces the window during which a heap dump
   * or memory scan could recover the key, but JavaScript's garbage
   * collector may retain copies — there is no way to guarantee secure
   * erasure in a managed runtime.
   *
   * Always call this on logout or when switching signers.
   */
  async destroy(): Promise<void> {
    this.secretKey.fill(0);
    this._pubkey = "";
  }

  /**
   * Persist the private key to the Tauri plugin-store, encrypted with
   * the user's password using NIP-49.
   *
   * ## NIP-49 encrypt flow
   * 1. `nip49.encrypt(secretKey, password)` generates a random salt,
   *    derives an encryption key via `scrypt(password, salt)`, then
   *    encrypts the 32-byte secret key with XChaCha20-Poly1305.
   * 2. The result is bech32-encoded with the `ncryptsec` human-readable
   *    prefix (e.g. `ncryptsec1...`).
   * 3. The `ncryptsec` string is written to the Tauri plugin-store file
   *    (`planner.json`) under the key `"ncryptsec"`.
   *
   * No-ops silently if not running in a Tauri environment.
   *
   * @param password - User-chosen password used to derive the NIP-49
   *   encryption key. Strength is the user's responsibility.
   */
  async saveToStore(password: string): Promise<void> {
    if (!isTauri()) return;
    // NIP-49 encrypt: scrypt KDF + XChaCha20-Poly1305 -> bech32 "ncryptsec1..."
    const ncryptsec = nip49.encrypt(this.secretKey, password);
    const { Store } = await import("@tauri-apps/plugin-store");
    const store = await Store.load(STORE_FILE);
    await store.set(STORE_KEY, ncryptsec);
    await store.save();
  }

  /**
   * Load a previously saved key from the Tauri plugin-store, decrypting
   * with the given password.
   *
   * ## NIP-49 decrypt flow
   * 1. Read the `ncryptsec1...` string from the store.
   * 2. `nip49.decrypt(ncryptsec, password)` bech32-decodes the payload,
   *    extracts the salt and nonce, re-derives the key via
   *    `scrypt(password, salt)`, and decrypts with XChaCha20-Poly1305.
   * 3. If the password is wrong, scrypt produces the wrong key and
   *    Poly1305 authentication fails — an error is thrown.
   * 4. On success, the raw 32-byte secret key is returned and used to
   *    construct a new {@link LocalSigner}.
   *
   * @param password - The same password used during {@link saveToStore}.
   * @returns A new LocalSigner, or `null` if no stored key exists or
   *   decryption fails (wrong password, corrupt data, or non-Tauri env).
   */
  static async loadFromStore(password: string): Promise<LocalSigner | null> {
    if (!isTauri()) return null;
    try {
      const { Store } = await import("@tauri-apps/plugin-store");
      const store = await Store.load(STORE_FILE);
      // Read the NIP-49 encrypted blob from disk
      const ncryptsec = await store.get<string>(STORE_KEY);
      if (!ncryptsec) return null;
      // NIP-49 decrypt: bech32 decode -> scrypt KDF -> XChaCha20-Poly1305 decrypt
      const secretKey = nip49.decrypt(ncryptsec, password);
      return new LocalSigner(secretKey);
    } catch {
      // Wrong password, corrupt store, or missing Tauri runtime
      return null;
    }
  }

  /**
   * Check whether a NIP-49 encrypted key exists in the Tauri store,
   * without attempting to decrypt it.
   *
   * Used on app startup to decide whether to show the "unlock" password
   * prompt or the "import key" flow.
   *
   * @returns `true` if an `ncryptsec` entry exists in the store.
   */
  static async hasStoredKey(): Promise<boolean> {
    if (!isTauri()) return false;
    try {
      const { Store } = await import("@tauri-apps/plugin-store");
      const store = await Store.load(STORE_FILE);
      const val = await store.get<string>(STORE_KEY);
      return !!val;
    } catch {
      return false;
    }
  }

  /**
   * Remove the stored NIP-49 encrypted key from the Tauri store.
   *
   * This is the "logout" action for locally-stored keys. After calling
   * this, {@link hasStoredKey} will return `false` and the user will
   * need to re-import their key on next launch.
   *
   * **Note:** This only removes the on-disk copy. If a {@link LocalSigner}
   * instance is still alive in memory, its key remains until
   * {@link destroy} is called.
   */
  static async clearStore(): Promise<void> {
    if (!isTauri()) return;
    const { Store } = await import("@tauri-apps/plugin-store");
    const store = await Store.load(STORE_FILE);
    await store.delete(STORE_KEY);
    await store.save();
  }
}
