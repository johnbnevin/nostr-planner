/**
 * Event encryption for private calendar events.
 *
 * @module crypto
 *
 * ## Why encryption is needed
 *
 * Nostr events are publicly readable by default. Calendar events (kinds
 * 31922, 31923, 31924 per NIP-52) would expose the user's full schedule
 * to anyone querying their relays. This module encrypts event content so
 * that only authorised parties (the owner, or shared-calendar members)
 * can read it.
 *
 * ## Two encryption modes
 *
 * 1. **Self-encryption (NIP-44):** The owner encrypts the event payload to
 *    their own pubkey using NIP-44 (XChaCha20-Poly1305 via the signer).
 *    Only the owner can decrypt. Marker tag: `["encrypted", "nip44"]`.
 *
 * 2. **Shared-key (AES-256-GCM):** All members of a shared calendar hold
 *    the same symmetric AES key (distributed via NIP-44 key envelopes —
 *    see {@link module:sharing}). Events are encrypted with that key so
 *    any member can decrypt. Marker tags: `["encrypted", "aes-gcm"]` and
 *    `["shared-calendar", calDTag]`.
 *
 * ## Kind-masking strategy
 *
 * In both modes, encrypted events are published as **kind 30078** (generic
 * addressable app-data) instead of their real NIP-52 calendar kind. This
 * is critical because:
 *
 * - Other Nostr calendar clients index kinds 31922/31923/31924 and would
 *   display garbled ciphertext as event titles/descriptions.
 * - Publishing as 30078 makes the events invisible to calendar clients
 *   that do not understand this app's encryption scheme.
 * - The **original kind** (e.g. 31923) is stored inside the encrypted
 *   payload (`EncryptedPayload.originalKind`) and restored on decryption.
 *
 * ## Encrypted payload structure
 *
 * All event metadata (title, start/end times, location, hashtags, etc.)
 * is packed into a single JSON blob ({@link EncryptedPayload}), encrypted,
 * and stored in the event's `content` field. Only the `d`-tag and
 * encryption marker tags remain in the clear — everything else is opaque
 * ciphertext.
 *
 * On decryption, the payload is unpacked back into the full tag array and
 * content string that the UI expects, as if the event had never been
 * encrypted.
 */

import { encryptAES, decryptAES } from "./sharing";
import { KIND_APP_DATA } from "./nostr";
import type { NostrSigner } from "./signer";

/** Re-export of the NIP-44 encrypt/decrypt interface from the signer. */
export type Nip44Interface = NostrSigner["nip44"];

/**
 * Check whether a NIP-44 capable signer is available.
 *
 * NIP-44 is required for all private-event encryption. If this returns
 * `false`, private events cannot be created or decrypted — the user must
 * either use a NIP-07 extension with NIP-44 support or provide an nsec
 * (Tauri build).
 *
 * @param signer - The current `NostrSigner` instance, or `null` if not logged in.
 * @returns `true` if NIP-44 encrypt/decrypt operations are available.
 */
export function isNip44Available(signer: NostrSigner | null): boolean {
  return signer !== null &&
    typeof signer.nip44?.encrypt === "function" &&
    typeof signer.nip44?.decrypt === "function";
}

/**
 * Check whether an event is NIP-44 self-encrypted (personal private event).
 *
 * Looks for the `["encrypted", "nip44"]` marker tag. Events with this tag
 * were encrypted to the owner's own pubkey and can only be decrypted by
 * the owner's signer.
 *
 * @param tags - The event's tag array.
 * @returns `true` if the event carries a NIP-44 encryption marker.
 */
export function isEncryptedEvent(tags: string[][]): boolean {
  return tags.some((t) => t[0] === "encrypted" && t[1] === "nip44");
}

/**
 * Check whether an event is AES-256-GCM encrypted (shared calendar event).
 *
 * Looks for the `["encrypted", "aes-gcm"]` marker tag. Events with this
 * tag were encrypted with a shared symmetric key and can be decrypted by
 * any member who holds that key.
 *
 * @param tags - The event's tag array.
 * @returns `true` if the event carries an AES-GCM encryption marker.
 */
export function isSharedEncryptedEvent(tags: string[][]): boolean {
  return tags.some((t) => t[0] === "encrypted" && t[1] === "aes-gcm");
}

/**
 * Extract the shared calendar `d`-tag from an event's tags.
 *
 * Shared-encrypted events carry a `["shared-calendar", calDTag]` tag in
 * the clear so the decryption layer knows which AES key to use. This
 * function reads that tag.
 *
 * @param tags - The event's tag array.
 * @returns The calendar `d`-tag string, or `null` if the tag is absent.
 */
export function getSharedCalendarRef(tags: string[][]): string | null {
  return tags.find((t) => t[0] === "shared-calendar")?.[1] ?? null;
}

/**
 * All event metadata packed into one JSON blob for encryption.
 *
 * This interface defines the structure of the plaintext that gets encrypted
 * and stored in the event's `content` field. On encryption, the full tag
 * array and content string are collapsed into this flat object. On
 * decryption, it is expanded back into tags + content via
 * {@link rebuildFromPayload}.
 *
 * The `originalKind` field is especially important: it stores the real
 * NIP-52 kind (31922/31923/31924) so the event can be published as kind
 * 30078 (hiding it from other calendar clients) and restored to its
 * original kind after decryption.
 */
export interface EncryptedPayload {
  title: string;
  start?: string;       // YYYY-MM-DD for date events, unix string for time events
  end?: string;
  startTzid?: string;
  endTzid?: string;
  dayFloors?: string[];  // D tags for time events
  location?: string;
  link?: string;
  hashtags?: string[];
  calendarRefs?: string[];
  seriesId?: string;
  notify?: boolean;      // per-event notification preference
  rrule?: string;        // iCal RRULE string (e.g. "FREQ=WEEKLY;COUNT=12")
  description?: string;
  recurrence?: { freq: string; count: number };
  // Calendar collection fields (kind 31924)
  color?: string;
  eventRefs?: string[];
  // Arbitrary content for app data (kind 30078) that doesn't fit above fields
  rawContent?: string;
  // Original event kind — stored inside payload so encrypted events can be
  // published as kind 30078 (hiding the real kind from other clients)
  originalKind?: number;
}

// ── Shared payload helpers ──────────────────────────────────────────────
//
// These two functions handle the bidirectional conversion between the
// Nostr event representation (tag array + content string) and the flat
// EncryptedPayload JSON object that gets encrypted.

/**
 * Collapse a Nostr tag array and content string into an {@link EncryptedPayload}.
 *
 * Iterates over all tags and maps known tag names to payload fields. The
 * `d`-tag is intentionally skipped — it stays in the clear on the published
 * event so relays can address it. Content is parsed as JSON (for events
 * that store description + recurrence), falling back to plain string.
 *
 * @param allTags - The full tag array of the event being encrypted.
 * @param content - The event's content string.
 * @returns An {@link EncryptedPayload} ready for JSON serialisation and encryption.
 */
function buildPayloadFromTags(allTags: string[][], content: string): EncryptedPayload {
  const payload: EncryptedPayload = { title: "" };

  for (const tag of allTags) {
    switch (tag[0]) {
      case "title": payload.title = tag[1]; break;
      case "start": payload.start = tag[1]; break;
      case "end": payload.end = tag[1]; break;
      case "start_tzid": payload.startTzid = tag[1]; break;
      case "end_tzid": payload.endTzid = tag[1]; break;
      case "D":
        if (!payload.dayFloors) payload.dayFloors = [];
        payload.dayFloors.push(tag[1]);
        break;
      case "location": payload.location = tag[1]; break;
      case "r": payload.link = tag[1]; break;
      case "t":
        if (!payload.hashtags) payload.hashtags = [];
        payload.hashtags.push(tag[1]);
        break;
      case "calendar":
        if (!payload.calendarRefs) payload.calendarRefs = [];
        payload.calendarRefs.push(tag[1]);
        break;
      case "series": payload.seriesId = tag[1]; break;
      case "notify": payload.notify = tag[1] === "true" ? true : tag[1] === "false" ? false : undefined; break;
      case "rrule": payload.rrule = tag[1]; break;
      case "color": payload.color = tag[1]; break;
      case "a":
        if (!payload.eventRefs) payload.eventRefs = [];
        payload.eventRefs.push(tag[1]);
        break;
      // "d" tag stays in the clear — skip
    }
  }

  try {
    const parsed = JSON.parse(content);
    if (parsed?.description || parsed?.recurrence) {
      if (parsed.description) payload.description = parsed.description;
      if (parsed.recurrence) payload.recurrence = parsed.recurrence;
    } else if (content) {
      payload.rawContent = content;
    }
  } catch {
    if (content) payload.description = content;
  }

  return payload;
}

/**
 * Expand an {@link EncryptedPayload} back into a Nostr tag array and content string.
 *
 * Inverse of {@link buildPayloadFromTags}. Reconstructs the `d`-tag (from
 * the provided `dTag` param), all metadata tags, and the content string.
 * The caller is responsible for restoring `originalKind` separately.
 *
 * @param payload - The decrypted payload object.
 * @param dTag    - The event's `d`-tag value (kept in the clear, not inside the payload).
 * @returns An object with `tags` (full tag array) and `content` (string).
 */
function rebuildFromPayload(
  payload: EncryptedPayload,
  dTag: string
): { tags: string[][]; content: string } {
  const tags: string[][] = [["d", dTag]];

  if (payload.title) tags.push(["title", payload.title]);
  if (payload.start) tags.push(["start", payload.start]);
  if (payload.end) tags.push(["end", payload.end]);
  if (payload.startTzid) tags.push(["start_tzid", payload.startTzid]);
  if (payload.endTzid) tags.push(["end_tzid", payload.endTzid]);
  if (payload.dayFloors) {
    for (const d of payload.dayFloors) tags.push(["D", d]);
  }
  if (payload.location) tags.push(["location", payload.location]);
  if (payload.link) tags.push(["r", payload.link]);
  if (payload.hashtags) {
    for (const t of payload.hashtags) tags.push(["t", t]);
  }
  if (payload.calendarRefs) {
    for (const c of payload.calendarRefs) tags.push(["calendar", c]);
  }
  if (payload.seriesId) tags.push(["series", payload.seriesId]);
  if (payload.notify !== undefined) tags.push(["notify", String(payload.notify)]);
  if (payload.rrule) tags.push(["rrule", payload.rrule]);
  if (payload.color) tags.push(["color", payload.color]);
  if (payload.eventRefs) {
    for (const a of payload.eventRefs) tags.push(["a", a]);
  }

  let content = "";
  if (payload.rawContent) {
    content = payload.rawContent;
  } else if (payload.recurrence) {
    content = JSON.stringify({
      description: payload.description,
      recurrence: payload.recurrence,
    });
  } else {
    content = payload.description || "";
  }

  return { tags, content };
}

// ── NIP-44 self-encryption ──────────────────────────────────────────────
//
// NIP-44 provides authenticated public-key encryption (XChaCha20-Poly1305
// with HKDF key derivation). When used for "self-encryption", the sender
// and recipient are the same pubkey — the signer derives a shared secret
// with itself, producing ciphertext only the owner's private key can
// decrypt. This is how personal private events are stored.

/**
 * Encrypt an event for personal (non-shared) private storage.
 *
 * 1. Packs all metadata tags and content into an {@link EncryptedPayload}.
 * 2. Stores the original NIP-52 kind inside the payload.
 * 3. NIP-44-encrypts the JSON payload to the owner's own pubkey.
 * 4. Returns kind `30078` (app-data) with only `d` and `encrypted` tags
 *    in the clear.
 *
 * The kind-masking (publishing as 30078 instead of 31922/31923/31924)
 * ensures other Nostr calendar clients never index or display the
 * encrypted event.
 *
 * @param pubkey  - The owner's hex pubkey (encryption target = self).
 * @param kind    - The real NIP-52 kind (31922, 31923, or 31924).
 * @param dTag    - The event's `d`-tag (stays in the clear for addressability).
 * @param allTags - Full tag array of the plaintext event.
 * @param content - The plaintext content string.
 * @param signer  - The `NostrSigner` providing NIP-44 encrypt.
 * @returns Object with `tags`, `content` (ciphertext), and `kind` (30078).
 */
export async function encryptEvent(
  pubkey: string,
  kind: number,
  dTag: string,
  allTags: string[][],
  content: string,
  signer: NostrSigner
): Promise<{ tags: string[][]; content: string; kind: number }> {
  const payload = buildPayloadFromTags(allTags, content);
  payload.originalKind = kind;
  const encrypted = await signer.nip44.encrypt(pubkey, JSON.stringify(payload));

  return {
    tags: [["d", dTag], ["encrypted", "nip44"]],
    content: encrypted,
    kind: KIND_APP_DATA,
  };
}

/**
 * Decrypt a NIP-44 self-encrypted event and rebuild its full tags and content.
 *
 * NIP-44-decrypts the ciphertext using the owner's pubkey, parses the
 * {@link EncryptedPayload}, and expands it back into the original tag
 * array and content string.
 *
 * The original kind is read from `payload.originalKind`. For backwards
 * compatibility with events encrypted before the kind-masking feature was
 * added, falls back to the `kind` parameter if `originalKind` is absent.
 *
 * @param pubkey           - The owner's hex pubkey (decryption source = self).
 * @param encryptedContent - The NIP-44 ciphertext from the event's content field.
 * @param kind             - Fallback kind if the payload lacks `originalKind`.
 * @param dTag             - The event's `d`-tag (for tag reconstruction).
 * @param signer           - The `NostrSigner` providing NIP-44 decrypt.
 * @returns Object with `tags`, `content`, and `kind` (restored original).
 */
export async function decryptEvent(
  pubkey: string,
  encryptedContent: string,
  kind: number,
  dTag: string,
  signer: NostrSigner
): Promise<{ tags: string[][]; content: string; kind: number }> {
  const json = await signer.nip44.decrypt(pubkey, encryptedContent);
  let payload: EncryptedPayload;
  try {
    payload = JSON.parse(json);
  } catch {
    throw new Error("Decrypted NIP-44 payload is not valid JSON");
  }
  const restoredKind = payload.originalKind ?? kind;
  return { ...rebuildFromPayload(payload, dTag), kind: restoredKind };
}

// ── AES-GCM shared-key encryption ──────────────────────────────────────
//
// For shared calendars, events are encrypted with a symmetric AES-256-GCM
// key rather than NIP-44. This allows any member holding the key to
// decrypt without needing a per-recipient encryption pass.

/**
 * Encrypt an event with a shared AES-256-GCM key for a shared calendar.
 *
 * Works like {@link encryptEvent} but uses symmetric AES-GCM instead of
 * NIP-44. The event is published as kind 30078 (kind-masking) with two
 * marker tags:
 * - `["encrypted", "aes-gcm"]` — identifies the encryption scheme.
 * - `["shared-calendar", sharedCalDTag]` — tells the decryption layer
 *   which calendar's AES key to use. This tag is in the clear by design.
 *
 * @param sharedKey     - The AES-256-GCM `CryptoKey` shared among members.
 * @param sharedCalDTag - The shared calendar's `d`-tag (kept in clear).
 * @param kind          - The real NIP-52 kind (stored inside the encrypted payload).
 * @param dTag          - The event's `d`-tag (stays in the clear).
 * @param allTags       - Full tag array of the plaintext event.
 * @param content       - The plaintext content string.
 * @returns Object with `tags`, `content` (ciphertext), and `kind` (30078).
 */
export async function encryptEventWithSharedKey(
  sharedKey: CryptoKey,
  sharedCalDTag: string,
  kind: number,
  dTag: string,
  allTags: string[][],
  content: string
): Promise<{ tags: string[][]; content: string; kind: number }> {
  const payload = buildPayloadFromTags(allTags, content);
  payload.originalKind = kind;
  const encrypted = await encryptAES(sharedKey, JSON.stringify(payload));
  return {
    tags: [
      ["d", dTag],
      ["encrypted", "aes-gcm"],
      ["shared-calendar", sharedCalDTag],
    ],
    content: encrypted,
    kind: KIND_APP_DATA,
  };
}

/**
 * Decrypt an AES-256-GCM shared-key encrypted event and rebuild its tags/content.
 *
 * Decrypts the ciphertext with the shared AES key (see {@link decryptAES}
 * in `sharing.ts`), parses the {@link EncryptedPayload}, and reconstructs
 * the full tag array and content string.
 *
 * Falls back to the `kind` parameter if `originalKind` is missing from the
 * payload (backwards compatibility).
 *
 * @param sharedKey        - The AES-256-GCM `CryptoKey` for this calendar.
 * @param encryptedContent - The `"base64(iv):base64(ciphertext||tag)"` string.
 * @param kind             - Fallback kind if the payload lacks `originalKind`.
 * @param dTag             - The event's `d`-tag (for tag reconstruction).
 * @returns Object with `tags`, `content`, and `kind` (restored original).
 * @throws {Error} If the AES-GCM authentication tag verification fails.
 */
export async function decryptEventWithSharedKey(
  sharedKey: CryptoKey,
  encryptedContent: string,
  kind: number,
  dTag: string
): Promise<{ tags: string[][]; content: string; kind: number }> {
  const json = await decryptAES(sharedKey, encryptedContent);
  let payload: EncryptedPayload;
  try {
    payload = JSON.parse(json);
  } catch {
    throw new Error("Decrypted AES-GCM payload is not valid JSON");
  }
  const restoredKind = payload.originalKind ?? kind;
  return { ...rebuildFromPayload(payload, dTag), kind: restoredKind };
}
