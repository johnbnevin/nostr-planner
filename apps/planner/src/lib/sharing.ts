/**
 * Shared calendar key management — symmetric AES-256-GCM key distribution.
 *
 * @module sharing
 *
 * ## Architecture overview
 *
 * Shared calendars use a **single symmetric AES-256-GCM key** per calendar.
 * Every event on the calendar is encrypted with this key, so any member who
 * holds the key can decrypt every event. This gives O(events + members)
 * complexity instead of O(events x members) that per-event NIP-44 would
 * require.
 *
 * ## Key distribution flow
 *
 * 1. **Owner generates** a 256-bit AES-GCM key ({@link generateSharedKey}).
 * 2. **Owner backs up** the key to themselves via NIP-44 self-encryption
 *    ({@link publishOwnKeyBackup}) — this allows cross-device access.
 * 3. **Owner distributes** the key to each member by NIP-44-encrypting it
 *    to the member's pubkey and publishing a kind 30078 "key envelope"
 *    event ({@link publishKeyEnvelope}).
 * 4. **Members discover** their envelopes via {@link fetchMyInvitations},
 *    decrypt with NIP-44, and cache the AES key locally.
 *
 * ## Key storage events (kind 30078, addressable/replaceable app-data)
 *
 * | d-tag pattern                                 | Purpose                            | Encrypted to      |
 * |-----------------------------------------------|------------------------------------|--------------------|
 * | `planner-cal-key-{calDTag}`                   | Owner's own key backup             | Self (NIP-44)      |
 * | `planner-share-{calDTag}-{memberPubkey}`      | Key envelope for a specific member | Member (NIP-44)    |
 * | `planner-cal-members-{calDTag}`               | Member list (JSON array of pubkeys)| Self (NIP-44)      |
 *
 * ## Member lifecycle
 *
 * - **Adding a member** = 1 NIP-44 encrypt (key to them) + update member list.
 * - **Removing a member** = delete their key envelope (kind 5), rotate the
 *   AES key, re-encrypt all calendar events with the new key, and
 *   re-distribute the new key to remaining members.
 *
 * ## Metadata privacy
 *
 * Key envelopes intentionally omit `p`-tags. Earlier versions tagged the
 * member's pubkey, but this leaked the social graph to relays. Now the
 * member's pubkey is embedded only in the `d`-tag (opaque to relay
 * operators) and the envelope content (NIP-44 encrypted).
 */

import { queryEvents } from "./relay";
import type { NostrSigner } from "./signer";
import { KIND_APP_DATA, DTAG_CAL_KEY_PREFIX, DTAG_SHARE_PREFIX, DTAG_MEMBERS_PREFIX } from "./nostr";
import { logger } from "./logger";

const log = logger("sharing");

const MAX_MEMBERS = 500;

type Nip44 = NostrSigner["nip44"];

/**
 * Hash a member pubkey for use in d-tag suffixes.
 * Uses first 32 hex chars (128 bits) of SHA-256(pubkey) — short enough for d-tags,
 * long enough to avoid collisions in realistic member counts (< 500).
 * The client knows the member's pubkey so it can reconstruct the hash for querying.
 */
export async function hashMemberPubkey(pubkey: string): Promise<string> {
  const data = new TextEncoder().encode(pubkey);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

// ── Type helpers ────────────────────────────────────────────────────────

type SignFn = (e: {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}) => Promise<{
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}>;

type PublishFn = (e: {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}) => Promise<void>;

// ── AES-256-GCM ─────────────────────────────────────────────────────────

/**
 * Generate a new 256-bit AES-GCM symmetric key.
 *
 * The key is created as **extractable** so it can be exported to base64
 * for storage in NIP-44 key envelopes. Both `encrypt` and `decrypt`
 * usages are enabled.
 *
 * @returns A `CryptoKey` suitable for use with {@link encryptAES} and {@link decryptAES}.
 */
export async function generateSharedKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * Export an AES `CryptoKey` to a base64 string for serialisation.
 *
 * The raw 32-byte key material is exported and base64-encoded so it can
 * be embedded in NIP-44 encrypted envelopes or invite links.
 *
 * @param key - The AES-GCM `CryptoKey` to export.
 * @returns Base64 representation of the raw 256-bit key.
 */
export async function exportKeyToBase64(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey("raw", key);
  return btoa(String.fromCharCode(...new Uint8Array(raw)));
}

/**
 * Import an AES-GCM key from its base64 representation.
 *
 * Reverse of {@link exportKeyToBase64}. The imported key is extractable
 * and supports both `encrypt` and `decrypt`.
 *
 * @param b64 - Base64-encoded 32-byte AES key.
 * @returns A `CryptoKey` ready for AES-GCM operations.
 */
export async function importKeyFromBase64(b64: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  if (raw.length !== 32) {
    throw new Error(`Invalid AES-256 key length: expected 32 bytes, got ${raw.length}`);
  }
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, true, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * Encrypt plaintext with AES-256-GCM.
 *
 * Output format: `"base64(iv):base64(ciphertext+tag)"`.
 *
 * **Security properties:**
 * - A fresh **12-byte IV** (96 bits) is generated via `crypto.getRandomValues`
 *   on every call. This is the NIST-recommended IV size for AES-GCM and ensures
 *   negligible collision probability for up to 2^32 encryptions under the same key.
 * - AES-GCM produces a **128-bit authentication tag** appended to the ciphertext
 *   by the WebCrypto API. The tag is verified automatically during decryption;
 *   any tampering with the IV, ciphertext, or tag causes `decrypt` to reject.
 * - The IV is stored in the clear (prepended before the colon) because AES-GCM
 *   IVs do not need to be secret — only unique per key.
 *
 * @param key       - AES-256-GCM `CryptoKey` (from {@link generateSharedKey} or {@link importKeyFromBase64}).
 * @param plaintext - UTF-8 string to encrypt (typically JSON-serialised event payload).
 * @returns Concatenation of `base64(iv):base64(ciphertext || tag)`.
 */
export async function encryptAES(key: CryptoKey, plaintext: string): Promise<string> {
  // 12-byte (96-bit) random IV — NIST SP 800-38D recommended size for AES-GCM.
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  // WebCrypto's AES-GCM encrypt returns ciphertext with the 128-bit auth tag appended.
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  const ivB64 = btoa(String.fromCharCode(...iv));
  const ctB64 = btoa(String.fromCharCode(...new Uint8Array(ciphertext)));
  return `${ivB64}:${ctB64}`;
}

/**
 * Decrypt an AES-256-GCM ciphertext produced by {@link encryptAES}.
 *
 * Expects the `"base64(iv):base64(ciphertext+tag)"` format. The WebCrypto
 * API automatically verifies the 128-bit GCM authentication tag during
 * decryption. If the ciphertext or tag has been tampered with, this
 * function throws (the `decrypt` call rejects).
 *
 * @param key       - The same AES-256-GCM `CryptoKey` used for encryption.
 * @param encrypted - String in `"base64(iv):base64(ciphertext||tag)"` format.
 * @returns The original plaintext string.
 * @throws {Error} If the format is invalid (missing colon separator).
 * @throws {DOMException} If the authentication tag verification fails (tampered data).
 */
export async function decryptAES(key: CryptoKey, encrypted: string): Promise<string> {
  const colonIdx = encrypted.indexOf(":");
  if (colonIdx === -1) throw new Error("Invalid AES encrypted format");
  const ivB64 = encrypted.slice(0, colonIdx);
  const ctB64 = encrypted.slice(colonIdx + 1);
  // Reconstruct the IV and ciphertext+tag from base64.
  const iv = Uint8Array.from(atob(ivB64), (c) => c.charCodeAt(0));
  if (iv.length !== 12) throw new Error(`Invalid AES-GCM IV length: expected 12 bytes, got ${iv.length}`);
  const ciphertext = Uint8Array.from(atob(ctB64), (c) => c.charCodeAt(0));
  // WebCrypto verifies the GCM auth tag; throws DOMException on mismatch.
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new TextDecoder().decode(plain);
}

// ── Key envelope publishing ─────────────────────────────────────────────
//
// Each function below publishes a kind 30078 (addressable app-data) event
// to Nostr relays. The content is always NIP-44 encrypted so relays and
// third-party clients see only opaque ciphertext. The `d`-tag acts as a
// deterministic address — publishing again with the same `d`-tag replaces
// the previous version (Nostr addressable event semantics).
//
// Crucially, none of these events carry a `p`-tag pointing at the member.
// Earlier iterations used `p`-tags for discoverability, but that leaked
// which pubkeys are members of a shared calendar (social graph metadata).
// Instead, the member's pubkey is encoded only in the `d`-tag suffix,
// which relay operators treat as an opaque string.

/**
 * Back up the calendar's AES key encrypted to the owner's own pubkey.
 *
 * This allows the owner to recover the shared key on a different device
 * by fetching this event and decrypting with NIP-44 (self-decryption).
 *
 * **What is encrypted:** The raw base64 AES key string.
 * **Encrypted to:** The owner's own pubkey (NIP-44 self-encryption).
 * **d-tag:** `planner-cal-key-{calDTag}` (addressable, so only the latest
 * version is retained).
 *
 * @param opts.ownerPubkey - Hex pubkey of the calendar owner.
 * @param opts.calDTag     - The calendar's unique `d`-tag identifier.
 * @param opts.keyBase64   - The AES-256-GCM key as a base64 string.
 * @param opts.nip44       - NIP-44 encrypt/decrypt interface.
 * @param opts.signEvent   - Signs a Nostr event template.
 * @param opts.publishEvent - Publishes a signed event to relays.
 */
export async function publishOwnKeyBackup(opts: {
  ownerPubkey: string;
  calDTag: string;
  keyBase64: string;
  nip44: Nip44;
  signEvent: SignFn;
  publishEvent: PublishFn;
}): Promise<void> {
  // NIP-44 encrypt the AES key to the owner's own pubkey (self-encryption).
  const encrypted = await opts.nip44.encrypt(opts.ownerPubkey, opts.keyBase64);
  const signed = await opts.signEvent({
    kind: KIND_APP_DATA,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["d", `${DTAG_CAL_KEY_PREFIX}${opts.calDTag}`]],
    content: encrypted,
  });
  await opts.publishEvent(signed);
}

/**
 * Publish a key envelope — distribute the AES key to one member.
 *
 * The AES key is NIP-44-encrypted to the member's pubkey so only they can
 * decrypt it. The event is published as kind 30078 with a deterministic
 * `d`-tag so that re-sharing (e.g. after key rotation) replaces the old
 * envelope.
 *
 * **What is encrypted:** The raw base64 AES key string.
 * **Encrypted to:** The member's pubkey (NIP-44).
 * **d-tag:** `planner-share-{calDTag}-{memberPubkey}`.
 * **No p-tag:** Intentionally omitted to prevent social-graph leakage.
 *
 * @param opts.calDTag      - The calendar's unique `d`-tag identifier.
 * @param opts.memberPubkey - Hex pubkey of the member receiving the key.
 * @param opts.keyBase64    - The AES-256-GCM key as a base64 string.
 * @param opts.nip44        - NIP-44 encrypt/decrypt interface.
 * @param opts.signEvent    - Signs a Nostr event template.
 * @param opts.publishEvent - Publishes a signed event to relays.
 */
export async function publishKeyEnvelope(opts: {
  calDTag: string;
  memberPubkey: string;
  keyBase64: string;
  nip44: Nip44;
  signEvent: SignFn;
  publishEvent: PublishFn;
}): Promise<void> {
  // NIP-44 encrypt the AES key to the member's pubkey — only they can decrypt.
  const encrypted = await opts.nip44.encrypt(opts.memberPubkey, opts.keyBase64);
  // Hash the member pubkey in the d-tag to prevent relay operators from
  // extracting member identities by pattern-matching the d-tag suffix.
  const memberHash = await hashMemberPubkey(opts.memberPubkey);
  const signed = await opts.signEvent({
    kind: KIND_APP_DATA,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["d", `${DTAG_SHARE_PREFIX}${opts.calDTag}-${memberHash}`],
      // No p-tag: omitted to avoid leaking the member's identity to relays.
    ],
    content: encrypted,
  });
  await opts.publishEvent(signed);
}

/**
 * Publish the current member list for a shared calendar.
 *
 * The list is stored as a JSON array of hex pubkeys, NIP-44-encrypted to
 * the owner's own pubkey. Only the owner can read it — members do not need
 * to know the full member list.
 *
 * **What is encrypted:** `JSON.stringify(members)` — an array of hex pubkeys.
 * **Encrypted to:** The owner's own pubkey (NIP-44 self-encryption).
 * **d-tag:** `planner-cal-members-{calDTag}`.
 *
 * @param opts.ownerPubkey - Hex pubkey of the calendar owner.
 * @param opts.calDTag     - The calendar's unique `d`-tag identifier.
 * @param opts.members     - Array of hex pubkeys of current members.
 * @param opts.nip44       - NIP-44 encrypt/decrypt interface.
 * @param opts.signEvent   - Signs a Nostr event template.
 * @param opts.publishEvent - Publishes a signed event to relays.
 */
export async function publishMemberList(opts: {
  ownerPubkey: string;
  calDTag: string;
  members: string[];
  nip44: Nip44;
  signEvent: SignFn;
  publishEvent: PublishFn;
}): Promise<void> {
  const encrypted = await opts.nip44.encrypt(
    opts.ownerPubkey,
    JSON.stringify(opts.members)
  );
  const signed = await opts.signEvent({
    kind: KIND_APP_DATA,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["d", `${DTAG_MEMBERS_PREFIX}${opts.calDTag}`]],
    content: encrypted,
  });
  await opts.publishEvent(signed);
}

/**
 * Revoke a member's access by publishing a NIP-09 deletion (kind 5) targeting
 * their key envelope event.
 *
 * The deletion uses an `a`-tag coordinate (`30078:{ownerPubkey}:{d-tag}`) to
 * address the envelope event. Compliant relays will stop serving the deleted
 * event after processing the kind 5.
 *
 * **Important:** Deletion alone is not sufficient for security — the member
 * already possesses the AES key. A full key rotation (generate new key,
 * re-encrypt all events, re-distribute to remaining members) must follow
 * immediately. See `removeMember` in `CalendarContext.tsx`.
 *
 * @param opts.ownerPubkey  - Hex pubkey of the calendar owner (needed for the `a`-tag coordinate).
 * @param opts.calDTag      - The calendar's unique `d`-tag identifier.
 * @param opts.memberPubkey - Hex pubkey of the member being revoked.
 * @param opts.signEvent    - Signs a Nostr event template.
 * @param opts.publishEvent - Publishes a signed event to relays.
 */
export async function revokeKeyEnvelope(opts: {
  ownerPubkey: string;
  calDTag: string;
  memberPubkey: string;
  signEvent: SignFn;
  publishEvent: PublishFn;
}): Promise<void> {
  const memberHash = await hashMemberPubkey(opts.memberPubkey);
  // Delete both old (raw pubkey) and new (hashed) d-tag formats for migration
  const newCoord = `${KIND_APP_DATA}:${opts.ownerPubkey}:${DTAG_SHARE_PREFIX}${opts.calDTag}-${memberHash}`;
  const oldCoord = `${KIND_APP_DATA}:${opts.ownerPubkey}:${DTAG_SHARE_PREFIX}${opts.calDTag}-${opts.memberPubkey}`;
  const signed = await opts.signEvent({
    kind: 5,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["a", newCoord], ["a", oldCoord]],
    content: "revoked",
  });
  await opts.publishEvent(signed);
}

// ── Key discovery (fetch + decrypt) ────────────────────────────────────

/**
 * Fetch all of the owner's kind 30078 events in a single relay query, then
 * partition and decrypt both key backups and member lists in one pass.
 *
 * This replaces the previous pattern where {@link fetchOwnKeyBackups} and
 * {@link fetchMemberLists} each independently queried ALL kind 30078 events
 * from the user's pubkey, doubling relay traffic for identical data.
 *
 * @param opts.pubkey - The owner's hex pubkey.
 * @param opts.relays - Relay URLs to query.
 * @param opts.nip44  - NIP-44 encrypt/decrypt interface.
 * @returns An object with `keyBackups` (Map<calDTag, base64Key>) and
 *          `memberLists` (Map<calDTag, string[]>).
 */
export async function fetchOwnKeyData(opts: {
  pubkey: string;
  relays: string[];
  nip44: Nip44;
}): Promise<{
  keyBackups: Map<string, string>;
  memberLists: Map<string, string[]>;
}> {
  const events = await queryEvents(opts.relays, {
    kinds: [KIND_APP_DATA],
    authors: [opts.pubkey],
  });
  const keyBackups = new Map<string, string>();
  const memberLists = new Map<string, string[]>();
  for (const event of events) {
    const dTag = event.tags.find((t: string[]) => t[0] === "d")?.[1];
    if (!dTag) continue;

    // ── Key backups (d-tag: planner-cal-key-{calDTag}) ──
    if (dTag.startsWith(DTAG_CAL_KEY_PREFIX)) {
      const calDTag = dTag.slice(DTAG_CAL_KEY_PREFIX.length);
      try {
        const keyBase64 = await opts.nip44.decrypt(opts.pubkey, event.content);
        keyBackups.set(calDTag, keyBase64);
      } catch (err) {
        log.warn("fetchOwnKeyData: skipping undecryptable key backup for", calDTag, err);
      }
      continue;
    }

    // ── Member lists (d-tag: planner-cal-members-{calDTag}) ──
    if (dTag.startsWith(DTAG_MEMBERS_PREFIX)) {
      // Only trust member lists authored by the current user.
      if (event.pubkey !== opts.pubkey) continue;
      const calDTag = dTag.slice(DTAG_MEMBERS_PREFIX.length);
      try {
        const json = await opts.nip44.decrypt(opts.pubkey, event.content);
        const members: unknown = JSON.parse(json);
        if (!Array.isArray(members)) {
          log.warn("fetchOwnKeyData: member list is not an array for", calDTag);
          continue;
        }
        if (members.length > MAX_MEMBERS) {
          log.warn("fetchOwnKeyData: member list exceeds MAX_MEMBERS for", calDTag, members.length);
          continue;
        }
        // Validate each entry is a 64-char hex pubkey
        const HEX_PK = /^[0-9a-f]{64}$/;
        const validMembers = members.filter((m): m is string =>
          typeof m === "string" && HEX_PK.test(m)
        );
        if (validMembers.length !== members.length) {
          log.warn("fetchOwnKeyData: filtered", members.length - validMembers.length, "invalid pubkeys from member list for", calDTag);
        }
        memberLists.set(calDTag, validMembers);
      } catch (err) {
        log.warn("fetchOwnKeyData: failed to decrypt member list for", calDTag, err);
      }
    }
  }
  return { keyBackups, memberLists };
}

/**
 * Fetch and decrypt all of the owner's AES key backups from relays.
 *
 * Convenience wrapper around {@link fetchOwnKeyData}. Prefer calling
 * `fetchOwnKeyData` directly when you also need member lists, to avoid
 * a redundant relay query.
 *
 * @param opts.pubkey - The owner's hex pubkey.
 * @param opts.relays - Relay URLs to query.
 * @param opts.nip44  - NIP-44 encrypt/decrypt interface.
 * @returns Map from calendar `d`-tag to base64-encoded AES key.
 */
export async function fetchOwnKeyBackups(opts: {
  pubkey: string;
  relays: string[];
  nip44: Nip44;
}): Promise<Map<string, string>> {
  const { keyBackups } = await fetchOwnKeyData(opts);
  return keyBackups;
}

/**
 * Fetch and decrypt member lists for all shared calendars the user owns.
 *
 * Convenience wrapper around {@link fetchOwnKeyData}. Prefer calling
 * `fetchOwnKeyData` directly when you also need key backups, to avoid
 * a redundant relay query.
 *
 * @param opts.pubkey - The owner's hex pubkey.
 * @param opts.relays - Relay URLs to query.
 * @param opts.nip44  - NIP-44 encrypt/decrypt interface.
 * @returns Map from calendar `d`-tag to an array of member hex pubkeys.
 */
export async function fetchMemberLists(opts: {
  pubkey: string;
  relays: string[];
  nip44: Nip44;
}): Promise<Map<string, string[]>> {
  const { memberLists } = await fetchOwnKeyData(opts);
  return memberLists;
}

/**
 * Fetch all key envelopes (invitations) addressed to this pubkey.
 *
 * Scans kind 30078 events on relays for key envelopes whose `d`-tag ends
 * with this user's pubkey hash. For each match, the content is NIP-44-decrypted
 * to recover the shared AES key.
 *
 * ## Metadata-privacy vs bandwidth trade-off
 *
 * This query intentionally fetches ALL kind 30078 events from ALL authors
 * (within the time window and limit). This is a deliberate privacy design
 * choice with significant bandwidth cost:
 *
 * **Why not use p-tags for efficient filtering?**
 * Adding `p`-tags to key envelopes would let us query `#p: [ourPubkey]`,
 * returning only events addressed to us. However, `p`-tags are visible in
 * the clear on relays, meaning relay operators (and anyone with relay
 * access) could see exactly which pubkeys are members of which shared
 * calendars — a social-graph metadata leak. We intentionally omit p-tags.
 *
 * **Why not filter by authors?**
 * The member does not know in advance which pubkeys might have shared a
 * calendar with them, so we cannot pre-filter by author.
 *
 * **Why not use d-tag prefix filtering?**
 * Relay operators could correlate the `planner-share-` prefix with our
 * pubkey hash suffix to infer membership. While the hash provides some
 * obfuscation, prefix-based queries would still narrow the anonymity set.
 * Fetching all kind 30078 events keeps our interest indistinguishable from
 * any other kind 30078 consumer.
 *
 * **Mitigations for the bandwidth cost:**
 * - Time-bounded to the last 90 days (`since` filter) to cap historical data.
 * - Hard limit of 2000 events to prevent relay-side DoS.
 * - Self-authored events are skipped immediately (no decrypt attempt).
 * - d-tag prefix/suffix checks eliminate most events before any NIP-44 work.
 * - Failed NIP-44 decryptions (events not addressed to us) are silently
 *   skipped in the catch block — this is expected for the vast majority.
 *
 * @param opts.pubkey - The member's hex pubkey (the user looking for invitations).
 * @param opts.relays - Relay URLs to query.
 * @param opts.nip44  - NIP-44 encrypt/decrypt interface.
 * @returns Map from calendar `d`-tag to `{ ownerPubkey, keyBase64 }`.
 */
// ── Invitation result cache ──────────────────────────────────────────
// fetchMyInvitations is bandwidth-heavy (fetches ALL kind 30078 events).
// Cache the result for 10 minutes to avoid hammering relays on every
// refresh cycle. The cache is keyed by pubkey and invalidated on force.
let invitationCache: {
  pubkey: string;
  result: Map<string, { ownerPubkey: string; keyBase64: string }>;
  fetchedAt: number;
} | null = null;
const INVITATION_CACHE_TTL_MS = 10 * 60_000; // 10 minutes

export async function fetchMyInvitations(opts: {
  pubkey: string;
  relays: string[];
  nip44: Nip44;
  force?: boolean;
}): Promise<Map<string, { ownerPubkey: string; keyBase64: string }>> {
  // Return cached result if still fresh and for the same pubkey
  if (
    !opts.force &&
    invitationCache &&
    invitationCache.pubkey === opts.pubkey &&
    Date.now() - invitationCache.fetchedAt < INVITATION_CACHE_TTL_MS
  ) {
    log.debug("fetchMyInvitations: returning cached result");
    return invitationCache.result;
  }

  // Broad fetch: no #p filter, no authors filter — intentional for metadata privacy.
  // See JSDoc above for the full rationale on this privacy-vs-bandwidth trade-off.
  // Time-bound to last 90 days to limit bandwidth and reduce DoS surface.
  const since = Math.floor(Date.now() / 1000) - 90 * 86400;
  const events = await queryEvents(opts.relays, {
    kinds: [KIND_APP_DATA],
    since,
    limit: 2000,
  });
  const result = new Map<string, { ownerPubkey: string; keyBase64: string }>();
  // Pre-compute the hashed pubkey for matching new-format d-tags
  const myHash = await hashMemberPubkey(opts.pubkey);
  const oldSuffix = `-${opts.pubkey}`;
  const newSuffix = `-${myHash}`;
  for (const event of events) {
    // Skip self-authored events — our own key backups are handled by fetchOwnKeyBackups
    if (event.pubkey === opts.pubkey) continue;
    const dTag = event.tags.find((t: string[]) => t[0] === "d")?.[1];
    if (!dTag?.startsWith(DTAG_SHARE_PREFIX)) continue;
    // Check both old format (raw pubkey) and new format (hashed pubkey)
    let calDTag: string | null = null;
    if (dTag.endsWith(newSuffix)) {
      const withoutPrefix = dTag.slice(DTAG_SHARE_PREFIX.length);
      calDTag = withoutPrefix.slice(0, withoutPrefix.length - newSuffix.length);
    } else if (dTag.endsWith(oldSuffix)) {
      const withoutPrefix = dTag.slice(DTAG_SHARE_PREFIX.length);
      calDTag = withoutPrefix.slice(0, withoutPrefix.length - oldSuffix.length);
    }
    if (!calDTag) continue;
    try {
      const keyBase64 = await opts.nip44.decrypt(opts.pubkey, event.content);
      result.set(calDTag, { ownerPubkey: event.pubkey, keyBase64 });
    } catch {
      // Decryption failure is expected for envelopes addressed to other pubkeys
    }
  }

  // Cache the result for subsequent calls
  invitationCache = { pubkey: opts.pubkey, result, fetchedAt: Date.now() };

  return result;
}

// ── Shared calendar owner mapping (sessionStorage) ──────────────────────
//
// When the current user is a *member* (not owner) of a shared calendar,
// we need to know who the owner is so we can query the correct author for
// events. This mapping is stored in sessionStorage (not localStorage) so
// it does not persist beyond the browser session — the canonical source
// of truth is always the relay data, re-fetched on each login.

/** SessionStorage key scoped to the user's pubkey. */
const OWNERS_KEY = (pubkey: string) => `nostr-planner-shared-owners-${pubkey}`;

/**
 * Save a calDTag-to-ownerPubkey mapping for a foreign shared calendar.
 *
 * Uses `sessionStorage` so the mapping is automatically cleared when the
 * browser tab/window closes. The mapping is needed so that event queries
 * for shared calendars can filter by the owner's pubkey as the author.
 *
 * @param pubkey      - The current user's hex pubkey (used to scope the storage key).
 * @param calDTag     - The shared calendar's `d`-tag identifier.
 * @param ownerPubkey - Hex pubkey of the calendar owner.
 */
export function saveSharedCalOwner(pubkey: string, calDTag: string, ownerPubkey: string): void {
  try {
    const raw = sessionStorage.getItem(OWNERS_KEY(pubkey));
    const map: Record<string, string> = raw ? JSON.parse(raw) : {};
    map[calDTag] = ownerPubkey;
    sessionStorage.setItem(OWNERS_KEY(pubkey), JSON.stringify(map));
  } catch {
    // Ignore storage errors
  }
}

/**
 * Remove a calDTag from the shared calendar owner mapping.
 *
 * Called when the user leaves a shared calendar, so stale mappings do not
 * accumulate in sessionStorage.
 *
 * @param pubkey  - The current user's hex pubkey.
 * @param calDTag - The shared calendar's `d`-tag identifier to remove.
 */
export function removeSharedCalOwner(pubkey: string, calDTag: string): void {
  try {
    const raw = sessionStorage.getItem(OWNERS_KEY(pubkey));
    if (!raw) return;
    const map: Record<string, string> = JSON.parse(raw);
    delete map[calDTag];
    sessionStorage.setItem(OWNERS_KEY(pubkey), JSON.stringify(map));
  } catch {
    // Ignore
  }
}

/**
 * Load all saved calDTag-to-ownerPubkey mappings from sessionStorage.
 *
 * Returns an empty Map if nothing is stored or if sessionStorage is
 * unavailable (e.g. in SSR or restricted iframe contexts).
 *
 * @param pubkey - The current user's hex pubkey.
 * @returns Map from calendar `d`-tag to the owner's hex pubkey.
 */
export function loadSharedCalOwners(pubkey: string): Map<string, string> {
  try {
    const raw = sessionStorage.getItem(OWNERS_KEY(pubkey));
    if (!raw) return new Map();
    const obj: Record<string, string> = JSON.parse(raw);
    return new Map(Object.entries(obj));
  } catch {
    return new Map();
  }
}

// ── NIP-05 lookup ───────────────────────────────────────────────────────

/**
 * Resolve a NIP-05 identifier (`name@domain`) to a hex pubkey.
 *
 * Performs an HTTPS GET to `https://{domain}/.well-known/nostr.json?name={name}`
 * as specified by NIP-05. The response is expected to contain a `names` object
 * mapping the local-part to a 64-character hex pubkey.
 *
 * Used in the sharing UI so users can add members by their human-readable
 * NIP-05 address (e.g. `alice@example.com`) instead of raw hex pubkeys.
 *
 * @param identifier - A NIP-05 address in `name@domain` format.
 * @returns The hex pubkey string, or `null` if lookup fails (network error,
 *          invalid format, name not found, or pubkey is not a valid 64-char hex string).
 */
/**
 * Check whether a hostname points to a private/internal address (SSRF prevention).
 *
 * Covers: IPv4 private ranges, localhost, link-local, IPv6 loopback,
 * IPv6-mapped IPv4, zero-prefixed octets, hex IPs, .local/.internal TLDs,
 * and hostnames containing `@` (credential-in-URL trick).
 */
function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();

  // Reject hostnames with embedded credentials (`user@host` tricks)
  if (h.includes("@")) return true;

  // Reserved TLDs / suffixes
  if (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".internal") ||
    h.endsWith(".arpa")
  ) return true;

  // IPv6 in brackets — loopback and IPv4-mapped addresses
  if (h.startsWith("[") && h.endsWith("]")) {
    const inner = h.slice(1, -1);
    // ::1, ::, ::ffff:127.0.0.1, ::ffff:10.x.x.x, etc.
    if (
      inner === "::1" ||
      inner === "::" ||
      /^::ffff:(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|0\.)/.test(inner)
    ) return true;
    return false;
  }

  // Hex IP literal: 0x7f000001 or 0x7F000001
  if (/^0x[0-9a-f]+$/i.test(h)) {
    const num = parseInt(h, 16);
    if (isPrivateIPv4(num)) return true;
    return false;
  }

  // Octal / zero-prefixed octets (e.g. 0177.0.0.1)
  // Detect by checking for leading zeros in any octet
  const parts = h.split(".");
  if (parts.length === 4 && parts.every((p) => /^\d+$/.test(p))) {
    const hasOctalPrefix = parts.some((p) => p.length > 1 && p.startsWith("0"));
    // Parse each octet: if it starts with 0 treat as octal, otherwise decimal
    const octets = parts.map((p) =>
      hasOctalPrefix && p.startsWith("0") && p.length > 1
        ? parseInt(p, 8)
        : parseInt(p, 10)
    );
    if (octets.every((o) => !isNaN(o) && o >= 0 && o <= 255)) {
      const num = (octets[0] << 24 | octets[1] << 16 | octets[2] << 8 | octets[3]) >>> 0;
      if (isPrivateIPv4(num)) return true;
    }
    // Also check standard decimal form
    const decOctets = parts.map((p) => parseInt(p, 10));
    if (decOctets.every((o) => !isNaN(o) && o >= 0 && o <= 255)) {
      const num = (decOctets[0] << 24 | decOctets[1] << 16 | decOctets[2] << 8 | decOctets[3]) >>> 0;
      if (isPrivateIPv4(num)) return true;
    }
  }

  // Decimal IP as a single large integer (e.g. 2130706433 = 127.0.0.1)
  if (/^\d+$/.test(h)) {
    const num = parseInt(h, 10);
    if (num >= 0 && num <= 0xFFFFFFFF && isPrivateIPv4(num)) return true;
  }

  return false;
}

/** Check if a 32-bit IPv4 address (as unsigned int) is in a private/reserved range. */
function isPrivateIPv4(ip: number): boolean {
  return (
    (ip >>> 24) === 127 ||                              // 127.0.0.0/8
    (ip >>> 24) === 10 ||                               // 10.0.0.0/8
    (ip >>> 20) === 0xAC1 ||                            // 172.16.0.0/12
    (ip >>> 16) === 0xC0A8 ||                           // 192.168.0.0/16
    (ip >>> 16) === 0xA9FE ||                           // 169.254.0.0/16
    ip === 0 ||                                         // 0.0.0.0
    (ip >>> 24) === 0                                   // 0.0.0.0/8
  );
}

export async function lookupNip05(identifier: string): Promise<string | null> {
  const atIdx = identifier.indexOf("@");
  if (atIdx === -1) return null;
  const name = identifier.slice(0, atIdx);
  const domain = identifier.slice(atIdx + 1);
  if (!name || !domain) return null;
  // Extract hostname (strip port if present)
  const hostname = domain.split(":")[0];
  if (isBlockedHostname(hostname)) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(
      `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`,
      { signal: controller.signal }
    );
    if (!res.ok) return null;
    // Guard against malicious NIP-05 servers returning huge responses
    const contentLength = res.headers.get("content-length");
    if (contentLength && parseInt(contentLength) > 100_000) return null;
    const text = await res.text();
    if (text.length > 100_000) return null;
    const data = JSON.parse(text);
    const pubkey = data?.names?.[name];
    // NIP-01 mandates lowercase hex pubkeys
    return typeof pubkey === "string" && /^[0-9a-f]{64}$/.test(pubkey) ? pubkey : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ── Invite links ─────────────────────────────────────────────────────────
//
// Invite links provide an out-of-band way to share calendar access.
// The link identifies the calendar and owner but does NOT contain the
// AES key. The key is distributed securely via NIP-44 envelopes when
// the owner adds the member (see addMember in SharingContext).

/**
 * The JSON structure embedded (base64-encoded) in invite link fragments.
 *
 * @property v - Schema version (currently `1`).
 * @property o - Owner's hex pubkey.
 * @property c - Calendar's `d`-tag identifier.
 * @property t - Human-readable calendar title (for display in the accept banner).
 * @property k - Unused (kept for structural compatibility). Key is distributed
 *              via NIP-44 envelopes when the owner adds the member, never in URLs.
 */
export interface InvitePayload {
  v: 1;
  o: string; // ownerPubkey (hex)
  c: string; // calDTag
  t: string; // calendar title
  k: string; // always "" — key never in URL
}

/**
 * Encode an invite payload to a base64 string for embedding in a URL fragment.
 *
 * The resulting string is intended to be used as `#invite={base64}` in the
 * app URL. Because it lives in the fragment, it is never sent to the server.
 *
 * @param opts.ownerPubkey - Hex pubkey of the calendar owner.
 * @param opts.calDTag     - The calendar's `d`-tag identifier.
 * @param opts.title       - Human-readable calendar title.
 * @param opts.keyBase64   - Base64-encoded AES-256-GCM key.
 * @returns Base64-encoded JSON string of the {@link InvitePayload}.
 */
export function encodeInvitePayload(opts: {
  ownerPubkey: string;
  calDTag: string;
  title: string;
  keyBase64?: string;
}): string {
  // Never embed the AES key in a URL — key distribution happens via NIP-44
  // envelopes when the owner adds the member. The k field is kept for
  // structural compatibility but is always empty.
  const payload: InvitePayload = {
    v: 1,
    o: opts.ownerPubkey,
    c: opts.calDTag,
    t: opts.title,
    k: "",
  };
  // TextEncoder → base64 supports unicode titles (btoa alone only handles Latin-1)
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));
}

/**
 * Decode and validate an invite payload from a base64 string.
 *
 * Performs structural validation: checks for version `1`, and that the
 * required fields (`o`, `c`, `k`) are present and are strings. Returns
 * `null` for any malformed or unrecognised input.
 *
 * @param encoded - Base64-encoded JSON string (from a URL fragment).
 * @returns The parsed {@link InvitePayload}, or `null` if invalid.
 */
const HEX_PUBKEY_RE = /^[0-9a-f]{64}$/;
// dTags are UUID-derived hex strings (16 chars) or arbitrary short identifiers;
// reject anything with path-traversal or control characters.
const SAFE_DTAG_RE = /^[a-zA-Z0-9_\-]{1,128}$/;

export function decodeInvitePayload(encoded: string): InvitePayload | null {
  try {
    // Decode UTF-8 bytes from base64 (backward-compatible: ASCII links still parse correctly)
    const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (
      parsed?.v !== 1 ||
      typeof parsed.o !== "string" ||
      typeof parsed.c !== "string" ||
      typeof parsed.t !== "string" ||
      typeof parsed.k !== "string"
    )
      return null;
    // Validate pubkey and dTag format to prevent injection / path traversal
    if (!HEX_PUBKEY_RE.test(parsed.o)) return null;
    if (!SAFE_DTAG_RE.test(parsed.c)) return null;
    return parsed as InvitePayload;
  } catch {
    return null;
  }
}
