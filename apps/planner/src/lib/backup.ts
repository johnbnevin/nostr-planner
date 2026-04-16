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

import { KIND_DATE_EVENT, KIND_TIME_EVENT, KIND_CALENDAR, KIND_APP_DATA, DTAG_BACKUP } from "./nostr";
import { queryEvents } from "./relay";
import { logger } from "./logger";
import type { PersistedSettings } from "../contexts/SettingsContext";

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
): Promise<{ events: RawEvent[]; preferences: PersistedSettings | null } | null> {
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
        // NIP-44 encrypted backup wrapper — decrypt to get the inner JSON
        if (data.encrypted && nip44 && pubkey) {
          try {
            let decryptedJson: string;
            if (data.v === 2 && Array.isArray(data.chunks)) {
              // Chunked format: decrypt each chunk and concatenate
              const parts: string[] = [];
              for (const chunk of data.chunks) {
                if (typeof chunk !== "string") throw new Error("invalid chunk type");
                parts.push(await nip44.decrypt(pubkey, chunk));
              }
              decryptedJson = parts.join("");
            } else if (data.v === 1 && typeof data.data === "string") {
              // Single-blob format
              if (data.data.length > MAX_BACKUP_BYTES) {
                log.warn("encrypted backup data field too large from", server);
                continue;
              }
              decryptedJson = await nip44.decrypt(pubkey, data.data);
            } else {
              log.warn("unknown encrypted backup format from", server);
              continue;
            }
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
          return { events: data, preferences: null };
        } else if (data.version && data.events) {
          // Validate backup version — reject unknown future versions that
          // may have an incompatible schema.
          if (data.version !== 1 && data.version !== 2) {
            log.warn("unsupported backup version", data.version, "from", server);
            continue;
          }
          return { events: data.events, preferences: data.preferences || null };
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
  prefetchedEvents?: RawEvent[]
): Promise<{ json: string; counts: ReturnType<typeof summarizeCounts> } | null> {
  let allEvents: RawEvent[];

  if (prefetchedEvents) {
    // Use pre-fetched events (avoids relay round-trip for auto-backup)
    allEvents = prefetchedEvents.filter((e: RawEvent) => {
      const dTag = e.tags.find((t: string[]) => t[0] === "d")?.[1];
      return dTag !== DTAG_BACKUP;
    });
  } else {
    const [calendarEvents, allAppData] = await Promise.all([
      queryEvents(relays, {
        kinds: [KIND_DATE_EVENT, KIND_TIME_EVENT, KIND_CALENDAR],
        authors: [pubkey],
      }),
      queryEvents(relays, {
        kinds: [KIND_APP_DATA],
        authors: [pubkey],
      }),
    ]);

    // Exclude the backup reference event itself
    const appDataEvents = allAppData.filter((e: RawEvent) => {
      const dTag = e.tags.find((t: string[]) => t[0] === "d")?.[1];
      return dTag !== DTAG_BACKUP;
    });

    allEvents = [...calendarEvents, ...appDataEvents];
  }

  if (allEvents.length === 0) return null;

  const backupData = {
    version: 2,
    events: allEvents,
    preferences: settings,
  };

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
  // NIP-44 has a 65535-byte plaintext limit. Chunk the backup into pieces
  // that fit, encrypt each separately, and store as an array.
  const NIP44_MAX = 60_000; // leave headroom below the 65535 hard limit
  let uploadData: string;
  if (backupJson.length <= NIP44_MAX) {
    const encrypted = await nip44.encrypt(pubkey, backupJson);
    uploadData = JSON.stringify({ encrypted: true, v: 1, data: encrypted });
  } else {
    const chunks: string[] = [];
    for (let i = 0; i < backupJson.length; i += NIP44_MAX) {
      chunks.push(await nip44.encrypt(pubkey, backupJson.slice(i, i + NIP44_MAX)));
    }
    uploadData = JSON.stringify({ encrypted: true, v: 2, chunks });
  }
  const blob = new Blob([uploadData], { type: "application/json" });
  // Guard against uploading unexpectedly large blobs (50 MB limit matches download cap)
  const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
  if (blob.size > MAX_UPLOAD_BYTES) {
    throw new Error(`Backup too large (${(blob.size / 1024 / 1024).toFixed(1)} MB). Maximum is 50 MB.`);
  }
  const arrayBuf = await blob.arrayBuffer();
  const hashBuf = await crypto.subtle.digest("SHA-256", arrayBuf);
  const sha256 = Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const createAuth = async (method: string, hash?: string) => {
    const now = Math.floor(Date.now() / 1000);
    const tags: string[][] = [
      ["t", method.toLowerCase()],
      ["expiration", String(now + 600)],
    ];
    if (hash) tags.push(["x", hash]);
    const authEvent = await signEvent({
      kind: 24242,
      created_at: now,
      tags,
      content: `Blossom ${method} auth`,
    });
    return btoa(JSON.stringify(authEvent));
  };

  let uploadedTo = 0;
  for (const server of BLOSSOM_SERVERS) {
    try {
      const auth = await createAuth("upload", sha256);
      const res = await fetch(`${server}/upload`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Nostr ${auth}`,
        },
        body: blob,
      });
      if (res.ok) uploadedTo++;
    } catch {
      // Continue
    }
  }

  if (uploadedTo > 0) {
    // Build history: fetch existing entries, prepend new one, keep 3
    const newEntry: BackupEntry = {
      sha256,
      servers: [...BLOSSOM_SERVERS],
      timestamp: new Date().toISOString(),
      totalEvents: counts.total,
      calendarEvents: counts.calCount,
      calendarCollections: counts.colCount,
      taskLists: counts.taskCount,
    };

    let history: BackupEntry[] = [newEntry];
    if (pubkey && relays) {
      try {
        const existing = await findBackupRefs(pubkey, relays);
        // Deduplicate by sha256 (don't re-add the same hash)
        const prev = existing.filter((e) => e.sha256 !== sha256);
        history = [newEntry, ...prev].slice(0, 3);
      } catch { /* best-effort */ }
    }

    const backupEvent = await signEvent({
      kind: KIND_APP_DATA,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["d", DTAG_BACKUP],
        ["x", sha256],
        ...BLOSSOM_SERVERS.map((s) => ["server", s]),
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
    });
    await publishEvent(backupEvent);
  }

  return { uploadedTo, sha256 };
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
  nip44?: { encrypt: (pubkey: string, plaintext: string) => Promise<string> }
): Promise<{ uploadedTo: number; total: number } | null> {
  const result = await buildBackupBlob(pubkey, relays, settings);
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

