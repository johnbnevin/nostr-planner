/**
 * @module backup
 *
 * Blossom-based backup and restore for the Nostr planner.
 *
 * ## Strategy
 *
 * User data (calendar events, collections, tasks, daily notes, settings)
 * already lives on Nostr relays, but relays can purge data or go offline.
 * Blossom backup adds a second layer of resilience:
 *
 * 1. **Build** — Fetch all of the user's events from relays and serialize
 *    them (plus app settings) into a versioned JSON blob.
 * 2. **Upload** — PUT the blob to multiple Blossom CDN servers. Each server
 *    stores it content-addressed by its SHA-256 hash.
 * 3. **Publish reference** — Sign and publish a replaceable Nostr event
 *    (kind 30078, d-tag `nostr-planner-backup`) containing the SHA-256 hash
 *    and the list of servers. This acts as a pointer to the latest backup.
 * 4. **Restore** — Find the reference event on any relay, download the blob
 *    from any listed (or fallback) Blossom server, verify its SHA-256 hash,
 *    then re-sign and re-publish each event to the user's relays.
 *
 * Blossom auth uses kind-24242 authorization events (signed by the user's
 * key) to prove upload permission without accounts or API keys.
 */

import { BlossomClient } from "blossom-client-sdk";
import { KIND_DATE_EVENT, KIND_TIME_EVENT, KIND_CALENDAR, KIND_APP_DATA, DTAG_BACKUP } from "./nostr";
import type { CalendarEvent, CalendarCollection } from "./nostr";
import { queryEvents } from "./relay";
import { logger } from "./logger";
import type { PersistedSettings } from "../contexts/SettingsContext";

/**
 * Pre-decrypted, parsed app state shipped inside the backup blob so a cold
 * login can render the full UI with **one** NIP-44 signer call and **one**
 * Blossom GET — bypassing the per-event NIP-44 decrypt loop that otherwise
 * scales linearly with event count.
 *
 * This is a CACHE of derived state; the authoritative events live in the
 * blob's `events` array. If materialized is present it should be used for
 * immediate render, then the relay sync reconciles any newer data.
 *
 * `CalendarEvent.start` / `.end` round-trip through JSON as ISO strings;
 * callers must re-hydrate Date objects — see {@link rehydrateMaterialized}.
 */
export interface MaterializedState {
  events: CalendarEvent[];
  calendars: CalendarCollection[];
}

/** Restore Date objects on materialized calendar events coming back from JSON. */
export function rehydrateMaterialized(m: MaterializedState): MaterializedState {
  return {
    calendars: m.calendars,
    events: m.events.map((e) => ({
      ...e,
      start: new Date(e.start as unknown as string),
      end: e.end ? new Date(e.end as unknown as string) : undefined,
    })),
  };
}

const log = logger("backup");

/** Well-known Blossom CDN servers used for backup blob storage.
 *  Uploads are attempted on all of them for redundancy; downloads try
 *  the event-listed servers first, then fall back to this list. */
const BLOSSOM_SERVERS = [
  "https://cdn.sovbit.host",
  "https://blossom.yakihonne.com",
  "https://blossom.primal.net",
  "https://nostrcheck.me",
  "https://blossom.nostr.build",
  "https://nostr.download",
];

/** A single backup snapshot with its hash, location, and statistics. */
export interface BackupEntry {
  sha256: string;
  servers: string[];
  timestamp: string;
  totalEvents: number;
  calendarEvents: number;
  calendarCollections: number;
  taskLists: number;
}

/** A complete signed Nostr event as received from a relay. */
export type RawEvent = {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
};


/**
 * Encrypted envelope wrapping the full backup JSON.
 *
 * Format v3 (current): hybrid AES-256-GCM + NIP-44.
 *   - A 32-byte random AES key encrypts the entire backup JSON in one pass
 *     using WebCrypto AES-GCM (fast, local, no signer round-trips, no size
 *     limit beyond Blossom's 50 MB cap).
 *   - That 32-byte key is NIP-44 encrypted to the user's own pubkey — a
 *     single short signer call (~80 hex chars) regardless of backup size.
 *
 * Formats v1 and v2 are legacy (single- and multi-chunk direct NIP-44
 * encryption of the whole JSON). {@link decryptBackupEnvelope} still reads
 * them for restores; new backups only write v3.
 */
export interface BackupEnvelopeV3 {
  encrypted: true;
  v: 3;
  /** NIP-44-encrypted AES-256 key (32 bytes, serialized as 64 hex chars). */
  key: string;
  /** Base64 AES-GCM nonce (12 bytes). */
  iv: string;
  /** Base64 AES-GCM ciphertext of the backup JSON (includes auth tag). */
  data: string;
}

const b64Encode = (bytes: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
};

const b64Decode = (s: string): Uint8Array => {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
};

const hexEncode = (bytes: Uint8Array): string =>
  Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");

const hexDecode = (hex: string): Uint8Array => {
  if (hex.length % 2 !== 0) throw new Error("invalid hex length");
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
};

/**
 * Encrypt a backup JSON string into an opaque envelope suitable for uploading
 * to Blossom or saving to a file. Exactly ONE NIP-44 signer call is made, so
 * this works efficiently even for multi-megabyte backups and slow remote
 * signers (NIP-46 bunkers).
 */
export async function encryptBackupEnvelope(
  backupJson: string,
  nip44: { encrypt: (pubkey: string, plaintext: string) => Promise<string> },
  pubkey: string
): Promise<BackupEnvelopeV3> {
  const aesKeyBytes = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const aesKey = await crypto.subtle.importKey(
    "raw",
    aesKeyBytes,
    { name: "AES-GCM" },
    false,
    ["encrypt"]
  );
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    aesKey,
    new TextEncoder().encode(backupJson)
  );

  const encryptedKey = await nip44.encrypt(pubkey, hexEncode(aesKeyBytes));

  return {
    encrypted: true,
    v: 3,
    key: encryptedKey,
    iv: b64Encode(iv),
    data: b64Encode(new Uint8Array(ciphertext)),
  };
}

/**
 * Decrypt a backup envelope written by any supported version (v1 legacy
 * single-pass, v2 legacy chunked, or v3 current AES+NIP-44 hybrid).
 * Returns the inner backup JSON string.
 */
export async function decryptBackupEnvelope(
  envelope: Record<string, unknown>,
  nip44: { decrypt: (pubkey: string, ciphertext: string) => Promise<string> },
  pubkey: string
): Promise<string> {
  if (envelope.v === 3 && typeof envelope.key === "string" &&
      typeof envelope.iv === "string" && typeof envelope.data === "string") {
    const aesKeyHex = await nip44.decrypt(pubkey, envelope.key);
    const aesKeyBytes = hexDecode(aesKeyHex);
    if (aesKeyBytes.length !== 32) throw new Error("invalid AES key length");
    const aesKey = await crypto.subtle.importKey(
      "raw",
      aesKeyBytes,
      { name: "AES-GCM" },
      false,
      ["decrypt"]
    );
    const plainBuf = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64Decode(envelope.iv) },
      aesKey,
      b64Decode(envelope.data)
    );
    return new TextDecoder().decode(plainBuf);
  }

  if (envelope.v === 2 && Array.isArray(envelope.chunks)) {
    const parts: string[] = [];
    for (const chunk of envelope.chunks) {
      if (typeof chunk !== "string") throw new Error("invalid chunk type");
      parts.push(await nip44.decrypt(pubkey, chunk));
    }
    return parts.join("");
  }

  if (envelope.v === 1 && typeof envelope.data === "string") {
    return await nip44.decrypt(pubkey, envelope.data);
  }

  throw new Error("unknown encrypted backup envelope format");
}

/**
 * Find the latest backup reference event across the user's relays.
 *
 * The backup reference is a kind 30078 replaceable event (d-tag
 * `nostr-planner-backup`) that contains:
 *  - An `x` tag with the SHA-256 hash of the backup blob.
 *  - One or more `server` tags listing the Blossom CDN URLs where the
 *    blob was uploaded.
 *
 * **Race-all-relays pattern:** Rather than querying relays sequentially
 * (where one slow/offline relay blocks the whole operation), each relay
 * is queried in parallel with an individual timeout. All results are
 * collected via `Promise.all` and the first non-null result is returned.
 * This ensures fast recovery even if most relays are unresponsive.
 *
 * @param pubkey - The user's hex public key.
 * @param relays - The user's preferred relay URLs (max 5 are queried).
 * @returns The SHA-256 hash and server list, or `null` if no backup exists.
 */
export async function findBackupRef(
  pubkey: string,
  relays: string[]
): Promise<{ sha256: string; servers: string[] } | null> {
  const filter = {
    kinds: [KIND_APP_DATA],
    authors: [pubkey],
    "#d": [DTAG_BACKUP],
    limit: 1,
  };

  // Race individual relay queries — return first non-empty result.
  // Cap at 5 relays to avoid excessive parallel connections.
  const urls = relays.length > 0 ? relays.slice(0, 5) : ["wss://relay.damus.io", "wss://nos.lol"];
  const perRelayTimeout = 8000;

  const attempts = urls.map(async (url) => {
    try {
      const events = await queryEvents([url], filter, perRelayTimeout);
      if (events.length === 0) return null;
      const evt = events[0];
      const sha256 = evt.tags.find((t: string[]) => t[0] === "x")?.[1];
      const servers = evt.tags
        .filter((t: string[]) => t[0] === "server")
        .map((t: string[]) => t[1]);
      if (!sha256) return null;
      return { sha256, servers };
    } catch {
      return null;
    }
  });

  // Return first successful result, or null if all fail
  const results = await Promise.all(attempts);
  return results.find((r) => r !== null) ?? null;
}

/**
 * Find up to 3 recent backup references from the history stored in
 * the backup reference event's content JSON.
 *
 * Falls back to a single entry built from tags if no history array exists
 * (backwards compat with pre-history reference events).
 */
export async function findBackupRefs(
  pubkey: string,
  relays: string[]
): Promise<BackupEntry[]> {
  const filter = {
    kinds: [KIND_APP_DATA],
    authors: [pubkey],
    "#d": [DTAG_BACKUP],
    limit: 1,
  };

  const urls = relays.length > 0 ? relays.slice(0, 5) : ["wss://relay.damus.io", "wss://nos.lol"];
  const perRelayTimeout = 8000;

  const attempts = urls.map(async (url) => {
    try {
      const events = await queryEvents([url], filter, perRelayTimeout);
      if (events.length === 0) return null;
      return events[0];
    } catch {
      return null;
    }
  });

  const results = await Promise.all(attempts);
  const evt = results.find((r) => r !== null);
  if (!evt) return [];

  try {
    const content = JSON.parse(evt.content);
    if (Array.isArray(content.history) && content.history.length > 0) {
      return content.history.slice(0, 3);
    }
  } catch { /* fall through */ }

  // Backwards compat: build single entry from tags
  const sha256 = evt.tags.find((t: string[]) => t[0] === "x")?.[1];
  if (!sha256) return [];

  const servers = evt.tags
    .filter((t: string[]) => t[0] === "server")
    .map((t: string[]) => t[1]);

  let content: Record<string, unknown> = {};
  try { content = JSON.parse(evt.content) as Record<string, unknown>; } catch { /* ignore */ }

  return [{
    sha256,
    servers,
    timestamp: typeof content.timestamp === "string" ? content.timestamp : new Date(evt.created_at * 1000).toISOString(),
    totalEvents: typeof content.totalEvents === "number" ? content.totalEvents : 0,
    calendarEvents: typeof content.calendarEvents === "number" ? content.calendarEvents : 0,
    calendarCollections: typeof content.calendarCollections === "number" ? content.calendarCollections : 0,
    taskLists: typeof content.taskLists === "number" ? content.taskLists : 0,
  }];
}

/**
 * Download and verify a backup blob from Blossom servers.
 *
 * Tries each server sequentially (event-listed servers first, then the
 * hardcoded fallback list). Blossom stores blobs content-addressed by
 * SHA-256, so the URL is simply `<server>/<sha256hex>`.
 *
 * **SHA-256 verification:** After downloading, the blob's hash is
 * recomputed via `crypto.subtle.digest` and compared to the expected
 * hash from the reference event. If they do not match, that server's
 * response is discarded and the next server is tried. This protects
 * against corrupted or tampered blobs.
 *
 * Supports two blob formats:
 *  - **v1 (current):** `{ version: 1, events: [...], preferences: {...} }`
 *  - **Legacy:** A bare JSON array of events (no preferences).
 *
 * @param ref - The SHA-256 hash and server list from {@link findBackupRef}.
 * @returns Parsed events and preferences, or `null` if all servers fail.
 */
export async function downloadBackup(
  ref: { sha256: string; servers: string[] },
  nip44?: { decrypt: (pubkey: string, ciphertext: string) => Promise<string> },
  pubkey?: string
): Promise<{ events: RawEvent[]; preferences: PersistedSettings | null; materialized: MaterializedState | null } | null> {
  // De-duplicate and merge event-listed servers with hardcoded fallbacks
  const servers = [...new Set([...ref.servers, ...BLOSSOM_SERVERS])];

  for (const server of servers) {
    try {
      const res = await fetch(`${server}/${ref.sha256}`);
      if (res.ok) {
        const MAX_BACKUP_BYTES = 50 * 1024 * 1024;
        // Reject responses larger than 50 MB to prevent memory exhaustion
        const contentLength = res.headers.get("content-length");
        if (contentLength && parseInt(contentLength) > MAX_BACKUP_BYTES) {
          log.warn("backup blob too large from", server, contentLength, "bytes");
          continue;
        }
        // Stream the response body with byte counting to abort early if
        // the server omitted Content-Length but sends a huge payload.
        let blob: ArrayBuffer;
        if (res.body) {
          const reader = res.body.getReader();
          const chunks: Uint8Array[] = [];
          let totalBytes = 0;
          let aborted = false;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            totalBytes += value.byteLength;
            if (totalBytes > MAX_BACKUP_BYTES) {
              reader.cancel();
              aborted = true;
              break;
            }
            chunks.push(value);
          }
          if (aborted) {
            log.warn("backup blob exceeded 50 MB (streaming) from", server);
            continue;
          }
          const combined = new Uint8Array(totalBytes);
          let offset = 0;
          for (const chunk of chunks) {
            combined.set(chunk, offset);
            offset += chunk.byteLength;
          }
          blob = combined.buffer;
        } else {
          // Fallback for environments without ReadableStream
          blob = await res.arrayBuffer();
          if (blob.byteLength > MAX_BACKUP_BYTES) {
            log.warn("backup blob exceeded 50 MB from", server);
            continue;
          }
        }
        // Verify SHA-256: recompute the hash of the downloaded bytes and
        // compare to the expected hash. This catches corruption or tampering.
        const hashBuf = await crypto.subtle.digest("SHA-256", blob);
        const actualHash = Array.from(new Uint8Array(hashBuf))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        if (actualHash !== ref.sha256) {
          log.warn("SHA-256 mismatch from", server);
          continue;
        }
        let data = JSON.parse(new TextDecoder().decode(blob));
        // Encrypted envelope — route to the shared decrypt helper which
        // handles v1 (single NIP-44), v2 (chunked NIP-44), and v3 (AES+NIP-44 hybrid).
        if (data.encrypted && nip44 && pubkey) {
          try {
            const decryptedJson = await decryptBackupEnvelope(data, nip44, pubkey);
            const parsed = JSON.parse(decryptedJson);
            if (Array.isArray(parsed)) {
              data = parsed; // legacy bare array format
            } else if (parsed && typeof parsed === "object" && parsed.version && Array.isArray(parsed.events)) {
              data = parsed;
            } else {
              log.warn("Decrypted backup has invalid structure from", server);
              continue;
            }
          } catch (err) {
            log.warn("Failed to decrypt encrypted backup from", server, err);
            continue;
          }
        }
        // Support both new format (with version/preferences) and old format (raw array)
        if (Array.isArray(data)) {
          return { events: data, preferences: null, materialized: null };
        } else if (data.version && data.events) {
          // Validate backup version — reject unknown future versions that
          // may have an incompatible schema.
          if (data.version !== 1 && data.version !== 2) {
            log.warn("unsupported backup version", data.version, "from", server);
            continue;
          }
          const materialized: MaterializedState | null =
            data.materialized && Array.isArray(data.materialized.events) && Array.isArray(data.materialized.calendars)
              ? rehydrateMaterialized(data.materialized as MaterializedState)
              : null;
          return { events: data.events, preferences: data.preferences || null, materialized };
        }
      }
    } catch {
      // Try next server
    }
  }
  return null;
}

/**
 * Re-sign and re-publish restored backup events to the user's relays.
 *
 * **Why timestamps are bumped:** All planner events are addressable
 * replaceable events (kinds 30000+). Nostr relays only accept a
 * replaceable event if its `created_at` is strictly newer than the
 * version they already have. Backup events may have old timestamps,
 * so each event is re-signed with `created_at = now` to guarantee
 * the relay accepts the restored version and overwrites any stale data.
 *
 * Events that fail to sign (e.g. the signer rejects the kind) are
 * silently skipped — the caller receives a count of successes.
 *
 * @returns The number of events successfully re-published.
 */
export async function republishEvents(
  events: RawEvent[],
  signAndPublish: {
    signEvent: (e: { kind: number; created_at: number; tags: string[][]; content: string }) => Promise<RawEvent>;
    publishEvent: (e: RawEvent) => Promise<void>;
  }
): Promise<number> {
  const now = Math.floor(Date.now() / 1000);

  // Sign sequentially (NIP-07 extensions require one popup at a time),
  // then publish in parallel batches for much faster restore.
  const signed: RawEvent[] = [];
  for (const event of events) {
    try {
      const resigned = await signAndPublish.signEvent({
        kind: event.kind,
        created_at: now,
        tags: event.tags,
        content: event.content,
      });
      signed.push(resigned);
    } catch {
      // Some may fail (e.g. signer rejects kind)
    }
  }

  // Publish in parallel batches of 10
  const BATCH_SIZE = 10;
  let published = 0;
  for (let i = 0; i < signed.length; i += BATCH_SIZE) {
    const batch = signed.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map((e) => signAndPublish.publishEvent(e))
    );
    published += results.filter((r) => r.status === "fulfilled").length;
  }

  return published;
}

/** Summarize event counts by kind for user-facing status messages. */
export function summarizeCounts(events: RawEvent[]) {
  const appData = events.filter((e) => e.kind === KIND_APP_DATA);
  return {
    calCount: events.filter(
      (e) => e.kind === KIND_DATE_EVENT || e.kind === KIND_TIME_EVENT
    ).length,
    colCount: events.filter((e) => e.kind === KIND_CALENDAR).length,
    taskCount: appData.length,
    total: events.length,
  };
}

/**
 * Build the full backup JSON blob.
 *
 * If `prefetchedEvents` is provided (e.g. from auto-backup which already has
 * in-memory state), uses those directly instead of re-querying relays. This
 * avoids hammering relays on every data change during auto-backup.
 *
 * When fetching from relays, queries calendar events (kinds 31922, 31923, 31924)
 * and ALL app-data events (kind 30078). The only app-data event excluded is
 * the backup reference itself (d-tag `nostr-planner-backup`).
 *
 * @returns The serialized JSON string and event counts, or `null` if
 *          no events were found (nothing to back up).
 */
export async function buildBackupBlob(
  pubkey: string,
  relays: string[],
  settings: PersistedSettings,
  prefetchedEvents?: RawEvent[],
  materialized?: MaterializedState
): Promise<{ json: string; counts: ReturnType<typeof summarizeCounts> } | null> {
  let allEvents: RawEvent[];

  if (prefetchedEvents) {
    // Use pre-fetched events (avoids relay round-trip for auto-backup)
    allEvents = prefetchedEvents.filter((e: RawEvent) => {
      const dTag = e.tags.find((t: string[]) => t[0] === "d")?.[1];
      return dTag !== DTAG_BACKUP;
    });
  } else {
    const BACKUP_QUERY_TIMEOUT_MS = 15_000;
    const [calendarEvents, allAppData] = await Promise.all([
      queryEvents(relays, {
        kinds: [KIND_DATE_EVENT, KIND_TIME_EVENT, KIND_CALENDAR],
        authors: [pubkey],
      }, BACKUP_QUERY_TIMEOUT_MS),
      queryEvents(relays, {
        kinds: [KIND_APP_DATA],
        authors: [pubkey],
      }, BACKUP_QUERY_TIMEOUT_MS),
    ]);

    // Exclude the backup reference event itself
    const appDataEvents = allAppData.filter((e: RawEvent) => {
      const dTag = e.tags.find((t: string[]) => t[0] === "d")?.[1];
      return dTag !== DTAG_BACKUP;
    });

    allEvents = [...calendarEvents, ...appDataEvents];
  }

  if (allEvents.length === 0) return null;

  const backupData: Record<string, unknown> = {
    version: 2,
    events: allEvents,
    preferences: settings,
  };
  if (materialized) {
    backupData.materialized = materialized;
  }

  return {
    json: JSON.stringify(backupData),
    counts: summarizeCounts(allEvents),
  };
}

/**
 * Upload a backup blob to Blossom servers and publish a reference event.
 *
 * ## Upload flow
 *
 * 1. Compute the SHA-256 hash of the JSON blob (this becomes the
 *    content-addressed filename on Blossom servers).
 * 2. For each Blossom server, create a **kind 24242 auth event** — a
 *    short-lived (5-minute expiry) Nostr event that proves the user
 *    owns the pubkey without needing an API key or account. The auth
 *    event is base64-encoded and sent in the `Authorization: Nostr`
 *    HTTP header.
 * 3. PUT the blob to `<server>/upload` with the auth header.
 * 4. After at least one successful upload, publish a replaceable Nostr
 *    event (kind 30078, d-tag `nostr-planner-backup`) containing the
 *    SHA-256 hash, server list, and event counts as metadata.
 *
 * @returns The number of servers the blob was uploaded to and the SHA-256 hash.
 */
export async function uploadBackup(
  backupJson: string,
  signEvent: (e: {
    kind: number;
    created_at: number;
    tags: string[][];
    content: string;
  }) => Promise<RawEvent>,
  publishEvent: (e: RawEvent) => Promise<void>,
  counts: ReturnType<typeof summarizeCounts>,
  pubkey?: string,
  relays?: string[],
  nip44?: { encrypt: (pubkey: string, plaintext: string) => Promise<string> }
): Promise<{ uploadedTo: number; sha256: string }> {
  // NIP-44 encrypt the backup blob to the user's own pubkey before uploading.
  // This prevents metadata leakage (event kinds, d-tags, timestamps, pubkeys)
  // even though event content is already NIP-44 encrypted.
  // SECURITY: Never upload plaintext backups — they leak all event metadata
  // (kinds, d-tags, timestamps, pubkeys) to Blossom servers.
  if (!nip44 || !pubkey) {
    throw new Error("NIP-44 encryption is required for backups. Cannot upload plaintext backup.");
  }

  // Hard wall-clock timeouts guard against signers or servers that hang
  // indefinitely. Every async step is capped; if any step blows its budget
  // the whole backup aborts cleanly instead of spinning forever.
  // NIP-46 remote signers (bunkers) round-trip every encrypt over a relay,
  // so the encrypt budget must be generous — but with AES+NIP-44 hybrid
  // encryption there is only ONE signer call regardless of backup size.
  const ENCRYPT_TIMEOUT_MS = 45_000;
  const SIGN_TIMEOUT_MS = 30_000;
  const UPLOAD_TIMEOUT_MS = 20_000;

  const withTimeout = async <T>(p: Promise<T>, ms: number, label: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        p,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const fetchWithTimeout = async (url: string | URL, init: RequestInit, timeoutMs: number) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };

  // Hybrid encryption: one NIP-44 signer call wraps a random AES-256 key,
  // AES-GCM handles the bulk payload locally. No chunking — Blossom has no
  // plaintext-size limit, only the 65535-byte NIP-44 limit drove chunking
  // in the old design, and that limit no longer touches the backup body.
  const envelope = await withTimeout(
    encryptBackupEnvelope(backupJson, nip44, pubkey),
    ENCRYPT_TIMEOUT_MS,
    "encrypt backup envelope"
  );
  const uploadData = JSON.stringify(envelope);
  const blob = new Blob([uploadData], { type: "application/octet-stream" });
  const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
  if (blob.size > MAX_UPLOAD_BYTES) {
    throw new Error(`Backup too large (${(blob.size / 1024 / 1024).toFixed(1)} MB). Maximum is 50 MB.`);
  }

  // SHA-256 of the exact bytes we will upload. Blossom servers content-address
  // the blob under this hash; if the server computes a different hash it will
  // 4xx the upload.
  const sha256 = await BlossomClient.getFileSha256(blob);

  // Sign ONE upload auth event covering this sha256 and reuse it across all
  // Blossom servers. NIP-07 signers serialize popups — signing N times in
  // parallel queues N popups, which looks like a hang. Expires in 1 hour.
  const authEvent = await withTimeout(
    BlossomClient.createUploadAuth(sha256, signEvent, "Planner backup"),
    SIGN_TIMEOUT_MS,
    "sign Blossom upload auth"
  );

  // Fan out to every configured Blossom server in parallel. Success means
  // the server returned a Blob Descriptor whose sha256 matches ours — that's
  // the server's own confirmation it stored the exact bytes. A server that
  // accepts the PUT but reports a different sha256 (or hangs, or 4xxs) is
  // dropped from the verified set.
  const tryServer = async (server: string): Promise<string | null> => {
    try {
      const res = await fetchWithTimeout(new URL("/upload", server), {
        method: "PUT",
        body: blob,
        headers: { authorization: BlossomClient.encodeAuthorizationHeader(authEvent) },
      }, UPLOAD_TIMEOUT_MS);

      if (!res.ok) {
        log.warn("Blossom upload", server, "returned", res.status);
        return null;
      }
      const descriptor = await res.json().catch(() => null) as { sha256?: string } | null;
      if (!descriptor || descriptor.sha256 !== sha256) {
        log.warn("Blossom upload", server, "returned mismatched descriptor", descriptor);
        return null;
      }
      return server;
    } catch (err) {
      log.warn("Blossom upload", server, "failed:", err);
      return null;
    }
  };

  const results = await Promise.all(BLOSSOM_SERVERS.map(tryServer));
  const verifiedServers = results.filter((r): r is string => r !== null);

  if (verifiedServers.length === 0) {
    throw new Error(
      "Backup upload failed: no Blossom server accepted the blob. " +
      "Your data on Nostr relays is unaffected — please try again."
    );
  }

  // Build history: fetch existing entries, prepend new one, keep 3
  const newEntry: BackupEntry = {
    sha256,
    servers: verifiedServers,
    timestamp: new Date().toISOString(),
    totalEvents: counts.total,
    calendarEvents: counts.calCount,
    calendarCollections: counts.colCount,
    taskLists: counts.taskCount,
  };

  let history: BackupEntry[] = [newEntry];
  if (pubkey && relays) {
    try {
      const existing = await withTimeout(findBackupRefs(pubkey, relays), 12_000, "fetch existing backup history");
      const prev = existing.filter((e) => e.sha256 !== sha256);
      history = [newEntry, ...prev].slice(0, 3);
    } catch { /* best-effort — keep just the new entry */ }
  }

  const backupEvent = await withTimeout(signEvent({
    kind: KIND_APP_DATA,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["d", DTAG_BACKUP],
      ["x", sha256],
      ...verifiedServers.map((s) => ["server", s]),
      ["count", String(counts.total)],
    ],
    content: JSON.stringify({
      type: "nostr-planner-backup",
      history,
      totalEvents: counts.total,
      calendarEvents: counts.calCount,
      calendarCollections: counts.colCount,
      taskLists: counts.taskCount,
      timestamp: new Date().toISOString(),
    }),
  }), SIGN_TIMEOUT_MS, "sign backup reference event");
  await withTimeout(publishEvent(backupEvent), 15_000, "publish backup reference event");

  return { uploadedTo: verifiedServers.length, sha256 };
}

/**
 * Clear the backup reference event — "start fresh" escape hatch.
 *
 * Publishes a replaceable kind-30078 event with the same d-tag but empty
 * history and no x/server tags. This overwrites any existing reference on
 * relays, so subsequent restore attempts find nothing and auto-backup will
 * create a clean new reference on the next data change.
 *
 * The Blossom blobs themselves are left in place (content-addressed, harmless,
 * and not all servers support DELETE). If they happen to be corrupt, nothing
 * points at them anymore.
 */
export async function clearBackupRef(
  signEvent: (e: {
    kind: number;
    created_at: number;
    tags: string[][];
    content: string;
  }) => Promise<RawEvent>,
  publishEvent: (e: RawEvent) => Promise<void>
): Promise<void> {
  const evt = await signEvent({
    kind: KIND_APP_DATA,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["d", DTAG_BACKUP], ["cleared", "1"]],
    content: JSON.stringify({
      type: "nostr-planner-backup",
      history: [],
      cleared: true,
      timestamp: new Date().toISOString(),
    }),
  });
  await publishEvent(evt);
}

/**
 * Run a full end-to-end backup: build blob, upload to Blossom, publish reference.
 *
 * This is the main entry point for both manual and auto-backup flows.
 *
 * @returns Upload count and total events, or `null` if there was nothing to back up.
 */
export async function performFullBackup(
  pubkey: string,
  relays: string[],
  settings: PersistedSettings,
  signEvent: (e: {
    kind: number;
    created_at: number;
    tags: string[][];
    content: string;
  }) => Promise<RawEvent>,
  publishEvent: (e: RawEvent) => Promise<void>,
  nip44?: { encrypt: (pubkey: string, plaintext: string) => Promise<string> },
  materialized?: MaterializedState
): Promise<{ uploadedTo: number; total: number } | null> {
  const result = await buildBackupBlob(pubkey, relays, settings, undefined, materialized);
  if (!result) return null;

  const { uploadedTo } = await uploadBackup(
    result.json,
    signEvent,
    publishEvent,
    result.counts,
    pubkey,
    relays,
    nip44
  );

  return { uploadedTo, total: result.counts.total };
}

/**
 * Fast cold-start path: download the Blossom blob and extract the
 * pre-decrypted {@link MaterializedState} if present. Returns `null` if
 * there's no backup reference, the blob is missing, or it lacks a
 * materialized snapshot (old-format backups).
 *
 * Single round-trip for the blob + one NIP-44 call for the AES key —
 * independent of event count.
 */
export async function loadMaterializedFromBlossom(
  pubkey: string,
  relays: string[],
  nip44: { decrypt: (pubkey: string, ciphertext: string) => Promise<string> }
): Promise<MaterializedState | null> {
  const ref = await findBackupRef(pubkey, relays);
  if (!ref) return null;
  const blob = await downloadBackup(ref, nip44, pubkey);
  return blob?.materialized ?? null;
}

