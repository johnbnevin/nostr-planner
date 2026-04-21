/**
 * @module backup
 *
 * Simple snapshot-based backup/restore for the Nostr planner.
 *
 * ## Design
 *
 * The user's entire in-memory state (events, calendars, habits, lists,
 * settings) is serialized into a single JSON snapshot, AES-256-GCM encrypted
 * with a per-backup random key, the key NIP-44-encrypted to the user's own
 * pubkey, and stored as one Blossom blob. A replaceable kind-30078 Nostr
 * event (d-tag `nostr-planner-backup`) records the blob's sha256 and the
 * servers it's stored on.
 *
 * ## Flow
 *
 *   login  → {@link loadSnapshot} → decrypt → apply to app state
 *   save   → {@link saveSnapshot} → one Blossom upload, publish pointer,
 *                                   mirror to extras in the background
 *   logout → flush any pending save
 *
 * ## Guarantees
 *
 * - One NIP-44 signer call per save (wrap the AES key) plus one sign for
 *   the Blossom upload auth + one sign for the pointer event: 3 total.
 * - One NIP-44 signer call per restore (unwrap the AES key).
 * - Save returns after the FIRST Blossom server accepts; the other three
 *   are mirrored lazily in the background so the user never waits on them.
 * - Restore races all known servers in parallel; the first sha256-verified
 *   blob wins.
 */

import { BlossomClient, type SignedEvent } from "blossom-client-sdk";
import { SimplePool } from "nostr-tools/pool";
import { KIND_APP_DATA, DTAG_BACKUP, type CalendarEvent, type CalendarCollection } from "./nostr";
import { queryEvents, getPrimaryRelay } from "./relay";
import { logger } from "./logger";
import type { PersistedSettings } from "../contexts/SettingsContext";
import type { DailyHabit, UserList } from "../contexts/TasksContext";
import { mergeSnapshots } from "./merge";

const log = logger("backup");

import { SUGGESTED_BLOSSOM_SERVERS } from "./nostr";

// ── User-configurable Blossom server state ─────────────────────────
//
// `primaryBlossom` is where each save is uploaded first — the blob isn't
// considered durable until this server confirms. `blossomRedundancy` is
// the number of additional suggested servers that receive a background
// mirror copy after the primary succeeds. SettingsContext drives both
// via `setPrimaryBlossom` / `setBlossomRedundancy` on login and on
// user-initiated changes; before that we fall back to the hardcoded
// defaults so the app works out of the box.

let primaryBlossom: string = SUGGESTED_BLOSSOM_SERVERS[0];
let blossomRedundancy: number = SUGGESTED_BLOSSOM_SERVERS.length - 1;

export function getPrimaryBlossom(): string {
  return primaryBlossom;
}

export function setPrimaryBlossom(url: string): void {
  const trimmed = url.trim();
  if (!trimmed || !/^https?:\/\//i.test(trimmed)) {
    log.warn("ignoring invalid primary Blossom URL:", url);
    return;
  }
  if (trimmed === primaryBlossom) return;
  log.debug("switching primary Blossom:", primaryBlossom, "→", trimmed);
  primaryBlossom = trimmed;
}

export function getBlossomRedundancy(): number {
  return blossomRedundancy;
}

export function setBlossomRedundancy(count: number): void {
  const clamped = Math.max(0, Math.min(10, Math.floor(count)));
  if (clamped === blossomRedundancy) return;
  log.debug("blossom redundancy →", clamped);
  blossomRedundancy = clamped;
}

/** Effective upload targets: primary first, then up to blossomRedundancy
 *  additional entries from SUGGESTED_BLOSSOM_SERVERS (excluding primary),
 *  deduplicated. The primary is always included even if the user set
 *  redundancy to 0 — the primary *is* the data store, not a mirror. */
function effectiveBlossomServers(): string[] {
  const extras = SUGGESTED_BLOSSOM_SERVERS
    .filter((s) => s !== primaryBlossom)
    .slice(0, blossomRedundancy);
  return [primaryBlossom, ...extras];
}

const MAX_BLOB_BYTES = 50 * 1024 * 1024;

// ── Types ───────────────────────────────────────────────────────────

export interface Snapshot {
  version: 1;
  savedAt: string; // ISO 8601
  calendars: CalendarCollection[];
  events: CalendarEvent[];
  habits: DailyHabit[];
  completions: Record<string, string[]>;
  lists: UserList[];
  settings: PersistedSettings;
}

export interface SnapshotPointer {
  sha256: string;
  servers: string[];
  savedAt: string;
  counts: { events: number; calendars: number; habits: number; lists: number };
}

export type RawEvent = {
  id: string; pubkey: string; created_at: number; kind: number;
  tags: string[][]; content: string; sig: string;
};
type SignEventFn = (e: { kind: number; created_at: number; tags: string[][]; content: string }) => Promise<RawEvent>;
type PublishEventFn = (e: RawEvent) => Promise<void>;
type Nip44 = {
  encrypt: (pubkey: string, plaintext: string) => Promise<string>;
  decrypt: (pubkey: string, ciphertext: string) => Promise<string>;
};

// ── Encoding helpers ────────────────────────────────────────────────

const b64Encode = (bytes: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
};
const b64Decode = (s: string): Uint8Array => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const hexEncode = (bytes: Uint8Array): string =>
  Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
const hexDecode = (hex: string): Uint8Array => {
  if (hex.length % 2 !== 0) throw new Error("invalid hex length");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
};

const fetchWithTimeout = async (url: string, init: RequestInit, timeoutMs: number) => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try { return await fetch(url, { ...init, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
};

// Sha256s of pointers this tab just published. watchPointer uses this to
// ignore its own publishes so the user never sees "Synced from another
// device" for a save they made themselves on this device.
const ownPublishedShas = new Set<string>();
const markOwnPublish = (sha: string) => {
  ownPublishedShas.add(sha);
  setTimeout(() => ownPublishedShas.delete(sha), 60_000);
};

// Sha256s of pointers this tab has loaded (either via loadSnapshot on
// login or via the pre-save optimistic-concurrency check). watchPointer
// also consults this set so the live subscription doesn't treat a pointer
// we just loaded as a fresh cross-device update and fire a spurious
// "Synced from another device" toast.
const seenRemoteShas = new Set<string>();
const markSeenRemote = (sha: string) => {
  seenRemoteShas.add(sha);
  setTimeout(() => seenRemoteShas.delete(sha), 60_000);
};

const withTimeout = async <T>(p: Promise<T>, ms: number, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

// ── Envelope encryption ─────────────────────────────────────────────

interface Envelope {
  v: 1;
  /** NIP-44 ciphertext of the AES-256 key as 64 hex chars. */
  key: string;
  /** Base64 AES-GCM nonce (12 bytes). */
  iv: string;
  /** Base64 AES-GCM ciphertext of the snapshot JSON (includes auth tag). */
  data: string;
}

async function wrapEnvelope(plaintext: string, pubkey: string, nip44: Nip44): Promise<Envelope> {
  const aesKeyBytes = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aesKey = await crypto.subtle.importKey("raw", aesKeyBytes, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, aesKey, new TextEncoder().encode(plaintext)
  );
  const encryptedKey = await nip44.encrypt(pubkey, hexEncode(aesKeyBytes));
  return { v: 1, key: encryptedKey, iv: b64Encode(iv), data: b64Encode(new Uint8Array(ciphertext)) };
}

async function unwrapEnvelope(env: Envelope, pubkey: string, nip44: Nip44): Promise<string> {
  if (env.v !== 1) throw new Error(`unsupported envelope version ${env.v}`);
  const aesKeyHex = await nip44.decrypt(pubkey, env.key);
  const aesKeyBytes = hexDecode(aesKeyHex);
  if (aesKeyBytes.length !== 32) throw new Error("invalid AES key length after NIP-44 decrypt");
  const aesKey = await crypto.subtle.importKey("raw", aesKeyBytes, { name: "AES-GCM" }, false, ["decrypt"]);
  const plainBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64Decode(env.iv) }, aesKey, b64Decode(env.data)
  );
  return new TextDecoder().decode(plainBuf);
}

// ── Save ────────────────────────────────────────────────────────────

/**
 * Encrypt + upload a snapshot to Blossom, publish the pointer event.
 * Returns after the FIRST server confirms; mirrors to the rest in the
 * background. Throws with detailed error text if every server fails or
 * any signer step times out.
 */
export async function saveSnapshot(
  pubkey: string,
  snapshot: Snapshot,
  signEvent: SignEventFn,
  publishEvent: PublishEventFn,
  nip44: Nip44,
  /** User's Nostr relays, used for the optimistic-concurrency pre-check. */
  relays?: string[],
  /** sha256 this tab last loaded/saved. When another device has raced us
   *  and published a newer pointer with a different sha256, we merge first
   *  so we don't clobber their edits. */
  lastKnownSha?: string,
  /** sha256 of the generation-2-back blob to delete after this save
   *  succeeds. Decoupled from `lastKnownSha` so the caller can keep the
   *  immediate-prior blob as a recovery safety net (delete N-2, keep N-1
   *  and N). Pass undefined to skip any cleanup. */
  shaToDelete?: string
): Promise<SnapshotPointer> {
  const startedAt = Date.now();

  // 0. Optimistic-concurrency guard. If a remote pointer exists and
  //    differs from the sha this tab last loaded/saved, merge it into
  //    our snapshot before uploading so we don't silently clobber the
  //    other device's edits. An undefined lastKnownSha is treated as
  //    "we haven't synced with the remote yet, assume anything there is
  //    newer" — this closes the window where a first login that fails
  //    to find the pointer (e.g. primary relay is missing it) would
  //    otherwise publish a blind overwrite on the next fingerprint
  //    change.
  let working = snapshot;
  if (relays) {
    try {
      const current = await findPointer(pubkey, relays);
      if (current && current.sha256 !== lastKnownSha) {
        const oursLabel = lastKnownSha ? lastKnownSha.slice(0, 8) : "unknown";
        log.info(`pointer raced (ours=${oursLabel}, remote=${current.sha256.slice(0, 8)}); merging`);
        // loadSnapshot itself calls markSeenRemote(sha256), so the live
        // watchPointer subscription won't re-deliver this sha as a
        // cross-device update moments from now.
        const remote = await loadSnapshot(pubkey, relays, nip44);
        if (remote) working = mergeSnapshots(working, remote);
      }
    } catch (err) {
      log.warn("pre-save pointer check failed (continuing with local):", err);
    }
  }

  // 1. Serialize + encrypt. One NIP-44 signer call.
  const json = JSON.stringify(working);
  log.info(`encrypting snapshot — ${json.length} bytes plaintext`);
  const envelope = await withTimeout(
    wrapEnvelope(json, pubkey, nip44), 60_000, "encrypt snapshot key"
  );
  const blob = new Blob([JSON.stringify(envelope)], { type: "application/octet-stream" });
  if (blob.size > MAX_BLOB_BYTES) {
    throw new Error(`Snapshot too large: ${(blob.size / 1024 / 1024).toFixed(1)} MB (max 50 MB).`);
  }
  const sha256 = await BlossomClient.getFileSha256(blob);
  log.info(`snapshot ${sha256.slice(0, 8)} — ${blob.size} bytes encrypted`);
  markOwnPublish(sha256);

  // 2. Sign ONE upload auth, reuse across all servers.
  const authEvent = await withTimeout(
    BlossomClient.createUploadAuth(sha256, signEvent, "Planner snapshot"),
    30_000, "sign Blossom upload auth"
  );
  const authHeader = BlossomClient.encodeAuthorizationHeader(authEvent);

  // 3. Upload in preference order: the user's chosen primary first, then
  //    any remaining suggested server as a fallback if primary is down.
  //    Sequential; first success wins and becomes the effective primary
  //    recorded on the pointer event.
  const uploadOrder = [
    primaryBlossom,
    ...SUGGESTED_BLOSSOM_SERVERS.filter((s) => s !== primaryBlossom),
  ];
  const errors: string[] = [];
  let primary: string | null = null;
  for (const server of uploadOrder) {
    try {
      log.info(`blossom upload → ${server}`);
      const res = await fetchWithTimeout(
        `${server}/upload`,
        { method: "PUT", body: blob, headers: { authorization: authHeader } },
        20_000
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        const msg = `${server}: HTTP ${res.status} ${body.slice(0, 120)}`;
        log.warn(`blossom upload ✗ ${msg}`);
        errors.push(msg);
        continue;
      }
      const desc = await res.json().catch(() => null) as { sha256?: string } | null;
      if (!desc || desc.sha256 !== sha256) {
        const msg = `${server}: descriptor mismatch (got ${desc?.sha256?.slice(0, 8) ?? "null"})`;
        log.warn(`blossom upload ✗ ${msg}`);
        errors.push(msg);
        continue;
      }
      primary = server;
      log.info(`blossom upload ✓ ${server}`);
      break;
    } catch (err) {
      const msg = `${server}: ${err instanceof Error ? err.message : String(err)}`;
      log.warn(`blossom upload ✗ ${msg}`);
      errors.push(msg);
    }
  }
  if (!primary) {
    throw new Error(`Every Blossom server rejected the upload:\n${errors.join("\n")}`);
  }

  // 4. Publish the pointer event. Lists the user's configured set plus
  //    any fallback used as primary so restore can race them all on load.
  const servers = [primary, ...SUGGESTED_BLOSSOM_SERVERS.filter((s) => s !== primary)];
  const savedAt = working.savedAt;
  const counts = {
    events: working.events.length,
    calendars: working.calendars.length,
    habits: working.habits.length,
    lists: working.lists.length,
  };
  const refEvent = await withTimeout(signEvent({
    kind: KIND_APP_DATA,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["d", DTAG_BACKUP],
      ["x", sha256],
      ...servers.map((s) => ["server", s]),
    ],
    content: JSON.stringify({ type: "nostr-planner-snapshot", savedAt, ...counts }),
  }), 30_000, "sign snapshot pointer event");
  await withTimeout(publishEvent(refEvent), 15_000, "publish snapshot pointer event");
  log.info(`pointer published in ${Date.now() - startedAt}ms`);

  // 5a. Best-effort cleanup of the N-2 blob. Blossom blobs are
  //     content-addressed, so every save writes a new sha — without
  //     cleanup, each user's footprint on every mirror server grows
  //     linearly with save count. We intentionally skip deleting the
  //     immediate-prior blob (lastKnownSha, the N-1 generation); that
  //     one is kept as a safety net in case the just-published sha is
  //     corrupted at the storage layer. Caller manages the rolling
  //     window and passes N-2 as shaToDelete. Fire-and-forget.
  if (shaToDelete && shaToDelete !== sha256 && shaToDelete !== lastKnownSha) {
    scheduleIdle(() => { void deletePreviousBlob(shaToDelete, signEvent); });
  }

  // 5. Background mirror to the user's chosen redundancy servers (capped
  //    by `blossomRedundancy` in Settings). Best-effort — user's data is
  //    already durable on `primary` and we've already returned.
  const mirrorTargets = effectiveBlossomServers().filter((s) => s !== primary);
  if (mirrorTargets.length > 0) {
    scheduleIdle(() => {
      void (async () => {
        for (const server of mirrorTargets) {
          try {
            log.info(`blossom mirror → ${server}`);
            const res = await fetchWithTimeout(
              `${server}/upload`,
              { method: "PUT", body: blob, headers: { authorization: authHeader } },
              20_000
            );
            if (res.ok) log.info(`blossom mirror ✓ ${server}`);
            else log.warn(`blossom mirror ✗ ${server}: HTTP ${res.status}`);
          } catch (err) {
            log.warn(`blossom mirror ✗ ${server}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      })();
    });
  }

  return { sha256, servers, savedAt, counts };
}

/**
 * Sign one BUD-02 delete auth and DELETE the blob from every known
 * Blossom server in parallel. Errors are logged at debug and ignored —
 * a server that never had the blob returns 404, a server that refuses
 * self-delete returns 401/403, and a down server throws. None of these
 * are worth surfacing because the blob that matters is the one the
 * current pointer points at; cleanup of the prior blob is opportunistic.
 */
async function deletePreviousBlob(sha: string, signEvent: SignEventFn): Promise<void> {
  let auth: SignedEvent;
  try {
    auth = await BlossomClient.getDeleteAuth(
      sha,
      signEvent as unknown as Parameters<typeof BlossomClient.getDeleteAuth>[1],
      "Planner snapshot cleanup"
    );
  } catch (err) {
    log.debug("could not sign delete auth (ignored):", err);
    return;
  }
  // Delete from every suggested server — we don't track which ones have a
  // copy (user changed redundancy or primary between saves could orphan
  // blobs on servers not in the current effective set). 404s are fine.
  log.info(`blossom delete ${sha.slice(0, 8)} → ${SUGGESTED_BLOSSOM_SERVERS.length} server(s)`);
  await Promise.allSettled(
    SUGGESTED_BLOSSOM_SERVERS.map((server) =>
      BlossomClient.deleteBlob(server, sha, auth)
        .then(() => log.info(`blossom delete ✓ ${server} ${sha.slice(0, 8)}`))
        .catch((err) => {
          log.info(`blossom delete ✗ ${server} ${sha.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
        })
    )
  );
}

function scheduleIdle(fn: () => void): void {
  type IC = { requestIdleCallback?: (cb: () => void) => void };
  const ric = (globalThis as unknown as IC).requestIdleCallback;
  if (typeof ric === "function") ric(fn);
  else setTimeout(fn, 2_000);
}

// ── Load ────────────────────────────────────────────────────────────

/**
 * Find the pointer event, race all known servers for the blob, decrypt.
 * Returns null if no pointer, no fetchable blob, or decrypt fails.
 */
export async function loadSnapshot(
  pubkey: string,
  relays: string[],
  nip44: Nip44
): Promise<(Snapshot & { _sha256: string }) | null> {
  const pointer = await findPointer(pubkey, relays);
  if (!pointer) {
    log.info("no snapshot pointer found");
    return null;
  }

  const allServers = [...new Set([...pointer.servers, ...SUGGESTED_BLOSSOM_SERVERS])];
  log.info(`fetching snapshot ${pointer.sha256.slice(0, 8)} from ${allServers.length} servers`);

  const envelopeJson = await raceFetch(pointer.sha256, allServers);
  if (!envelopeJson) {
    log.warn("could not fetch snapshot blob from any server");
    return null;
  }

  let env: Envelope;
  try { env = JSON.parse(envelopeJson); }
  catch { log.warn("snapshot blob is not JSON"); return null; }

  let plaintext: string;
  try {
    plaintext = await withTimeout(unwrapEnvelope(env, pubkey, nip44), 60_000, "decrypt snapshot");
  } catch (err) {
    log.warn("snapshot decrypt failed:", err);
    return null;
  }

  let snap: Snapshot;
  try { snap = JSON.parse(plaintext) as Snapshot; }
  catch { log.warn("decrypted snapshot is not JSON"); return null; }

  if (snap.version !== 1) {
    log.warn(`unsupported snapshot version ${snap.version}`);
    return null;
  }
  // Rehydrate Date objects.
  for (const e of snap.events) {
    e.start = new Date(e.start as unknown as string);
    if (e.end) e.end = new Date(e.end as unknown as string);
  }
  log.info(`restored: ${snap.events.length} events, ${snap.calendars.length} calendars, ${snap.habits.length} habits, ${snap.lists.length} lists`);
  // Tell watchPointer we've already processed this sha so the live
  // subscription doesn't re-deliver it as a "Synced from another device"
  // event seconds later.
  markSeenRemote(pointer.sha256);
  return { ...snap, _sha256: pointer.sha256 };
}

async function findPointer(
  pubkey: string,
  relays: string[]
): Promise<{ sha256: string; servers: string[] } | null> {
  let events: RawEvent[] = [];
  try {
    events = await queryEvents(
      relays.length > 0 ? relays : [getPrimaryRelay()],
      { kinds: [KIND_APP_DATA], authors: [pubkey], "#d": [DTAG_BACKUP], limit: 1 },
      10_000
    ) as unknown as RawEvent[];
  } catch (err) {
    log.warn("pointer query failed:", err);
    return null;
  }
  if (events.length === 0) return null;
  events.sort((a, b) => b.created_at - a.created_at);
  const evt = events[0];
  const sha256 = evt.tags.find((t) => t[0] === "x")?.[1];
  if (!sha256) return null; // cleared pointer
  const servers = evt.tags.filter((t) => t[0] === "server").map((t) => t[1]);
  return { sha256, servers };
}

async function raceFetch(sha256: string, servers: string[]): Promise<string | null> {
  const fetchAndVerify = async (server: string): Promise<string | null> => {
    try {
      log.info(`blossom fetch → ${server} ${sha256.slice(0, 8)}`);
      const res = await fetchWithTimeout(`${server}/${sha256}`, {}, 15_000);
      if (!res.ok) {
        log.info(`blossom fetch ✗ ${server}: HTTP ${res.status}`);
        return null;
      }
      const buf = await res.arrayBuffer();
      if (buf.byteLength > MAX_BLOB_BYTES) {
        log.warn(`blossom fetch ✗ ${server}: blob too large (${buf.byteLength} bytes)`);
        return null;
      }
      const hashBuf = await crypto.subtle.digest("SHA-256", buf);
      const actual = hexEncode(new Uint8Array(hashBuf));
      if (actual !== sha256) {
        log.warn(`blossom fetch ✗ ${server}: sha256 mismatch`);
        return null;
      }
      log.info(`blossom fetch ✓ ${server}`);
      return new TextDecoder().decode(buf);
    } catch (err) {
      log.info(`blossom fetch ✗ ${server}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  };

  return new Promise((resolve) => {
    if (servers.length === 0) { resolve(null); return; }
    let remaining = servers.length;
    let done = false;
    for (const s of servers) {
      fetchAndVerify(s).then((body) => {
        remaining--;
        if (done) return;
        if (body) { done = true; resolve(body); return; }
        if (remaining === 0) resolve(null);
      }).catch(() => {
        remaining--;
        if (!done && remaining === 0) resolve(null);
      });
    }
  });
}

// ── Live pointer subscription (multi-device sync) ───────────────────

/**
 * Watch for newer snapshot pointer events published by OTHER devices of
 * the same user. When a newer pointer arrives (different sha256 from the
 * last one this tab is aware of), fetch + decrypt the blob and hand it
 * to `onNewer`. Returns a close function.
 *
 * The caller is responsible for merging the remote snapshot with its
 * local state and re-applying to the UI.
 *
 * Reliability features:
 * - **Restart on focus/visibility.** Backgrounded tabs have their
 *   WebSockets silently killed by the OS after a few minutes. When the
 *   user returns, we tear down + re-create the subscription so fresh
 *   sockets are established. Without this, Device B stops receiving
 *   pointers and appears stale forever.
 * - **Clock-skew tolerance.** The `since` filter is offset by 60 s so
 *   a phone with a slightly fast clock doesn't cause the relay to
 *   silently drop pointers whose `created_at` is "in the past".
 * - **Safety-net poll.** Every POLL_MS (90 s), if nothing has arrived
 *   via the subscription, we explicitly query for the latest pointer.
 *   This catches the case where both restart-on-focus and the live
 *   subscription fail silently.
 */
const POINTER_POLL_MS = 90_000;
const POINTER_SINCE_SKEW_SEC = 60;

export function watchPointer(
  pubkey: string,
  relays: string[],
  nip44: Nip44,
  /** Ref holding the sha256 of the snapshot this tab most recently
   *  loaded or saved. Read once at subscription open to seed lastSha so
   *  the initial pointer (which we already have locally) doesn't trigger
   *  a spurious re-fetch. Passed as a ref — not a value — so callers
   *  don't have to re-open the subscription on every save. */
  initialShaRef: { current: string | null },
  onNewer: (snapshot: Snapshot) => void
): () => void {
  let closed = false;
  let lastSha = initialShaRef.current;
  let pool: SimplePool | null = null;
  let sub: { close: () => void } | null = null;
  // Live pointer subscription only to the current primary — matches the
  // hot-path relay policy in relay.ts. Redundancy copies land via idle
  // publishes. If the user switches primary in settings, callers should
  // re-run watchPointer (their effect deps include primaryRelay) so a new
  // subscription is opened against the new primary.
  const urls = [getPrimaryRelay()];

  // Shared pointer-processing logic used by both the live subscription
  // and the periodic safety-net poll.
  const processPointer = async (sha: string, servers: string[]) => {
    if (closed) return;
    if (sha === lastSha) return;
    // Skip pointers we've already ingested on this tab — either through
    // our own publish or through a prior load (login restore, pre-save
    // concurrency check). Without this, a pointer that arrives on the
    // live subscription seconds after we load it fires a spurious
    // "Synced from another device" toast.
    if (ownPublishedShas.has(sha) || seenRemoteShas.has(sha)) { lastSha = sha; return; }
    log.debug(`watchPointer: new pointer ${sha.slice(0, 8)}, fetching`);
    const allServers = [...new Set([...servers, ...SUGGESTED_BLOSSOM_SERVERS])];
    const body = await raceFetch(sha, allServers);
    if (!body || closed) return;
    try {
      const env: Envelope = JSON.parse(body);
      const plaintext = await unwrapEnvelope(env, pubkey, nip44);
      const snap = JSON.parse(plaintext) as Snapshot;
      if (snap.version !== 1) return;
      for (const e of snap.events) {
        e.start = new Date(e.start as unknown as string);
        if (e.end) e.end = new Date(e.end as unknown as string);
      }
      lastSha = sha;
      log.info(`watchPointer: merged ${sha.slice(0, 8)} (${snap.events.length} events)`);
      onNewer({ ...snap, _sha256: sha } as Snapshot & { _sha256: string });
    } catch (err) {
      log.warn("watchPointer: remote snapshot decrypt failed:", err);
    }
  };

  const openSubscription = () => {
    if (closed) return;
    // Close prior pool before replacing — this is what fixes stale
    // WebSockets after the tab has been backgrounded.
    try { sub?.close(); pool?.close(urls); } catch { /* ignore */ }
    pool = new SimplePool();
    sub = pool.subscribe(
      urls,
      {
        kinds: [KIND_APP_DATA],
        authors: [pubkey],
        "#d": [DTAG_BACKUP],
        // Skew the since filter back 60s so ±1 min of clock drift
        // doesn't cause the relay to silently drop our pointers.
        since: Math.floor(Date.now() / 1000) - POINTER_SINCE_SKEW_SEC,
      },
      {
        onevent: async (event) => {
          const sha = event.tags.find((t) => t[0] === "x")?.[1];
          if (!sha) return;
          const servers = event.tags.filter((t) => t[0] === "server").map((t) => t[1]);
          await processPointer(sha, servers);
        },
      }
    );
    log.debug("watchPointer: subscription opened on", urls.length, "relays");
  };

  // Periodic safety-net: if the subscription dies silently (common on
  // mobile PWAs after backgrounding), this poll still catches new
  // pointers by querying the relays directly.
  const pollOnce = async () => {
    if (closed) return;
    try {
      const ptr = await findPointer(pubkey, relays);
      if (ptr) await processPointer(ptr.sha256, ptr.servers);
    } catch (err) {
      log.debug("watchPointer: poll failed (not fatal):", err);
    }
  };

  const onVisibilityChange = () => {
    if (document.visibilityState !== "visible") return;
    // Tab regained focus. Rebuild the sub with a fresh WebSocket, then
    // do a one-shot poll to catch anything we missed while backgrounded.
    log.debug("watchPointer: tab visible, refreshing subscription");
    openSubscription();
    void pollOnce();
  };

  openSubscription();
  // Kick off an immediate poll so we don't wait up to POLL_MS for the
  // first pointer on a fresh load — relays sometimes don't backfill
  // replaceable events reliably to subscriptions using a `since` filter.
  void pollOnce();
  const pollTimer = setInterval(() => { void pollOnce(); }, POINTER_POLL_MS);
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("focus", onVisibilityChange);

  return () => {
    closed = true;
    clearInterval(pollTimer);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("focus", onVisibilityChange);
    try { sub?.close(); pool?.close(urls); } catch { /* ignore */ }
  };
}

// ── Clear pointer (escape hatch for a corrupt backup) ───────────────

export async function clearSnapshotPointer(
  signEvent: SignEventFn,
  publishEvent: PublishEventFn
): Promise<void> {
  const evt = await signEvent({
    kind: KIND_APP_DATA,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["d", DTAG_BACKUP], ["cleared", "1"]],
    content: JSON.stringify({ type: "nostr-planner-snapshot", cleared: true }),
  });
  await publishEvent(evt);
}

// ── Convenience: build a snapshot from in-memory state ─────────────

export function buildSnapshot(opts: {
  calendars: CalendarCollection[];
  events: CalendarEvent[];
  /** Deleted-event tombstones to include in the snapshot so cross-device
   *  merges preserve the deletion rather than resurrecting the event from
   *  another device's older state. */
  eventTombstones?: CalendarEvent[];
  habits: DailyHabit[];
  habitTombstones?: DailyHabit[];
  completions: Record<string, string[]>;
  lists: UserList[];
  listTombstones?: UserList[];
  settings: PersistedSettings;
}): Snapshot {
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    calendars: opts.calendars,
    events: opts.eventTombstones && opts.eventTombstones.length > 0
      ? [...opts.events, ...opts.eventTombstones]
      : opts.events,
    habits: opts.habitTombstones && opts.habitTombstones.length > 0
      ? [...opts.habits, ...opts.habitTombstones]
      : opts.habits,
    completions: opts.completions,
    lists: opts.listTombstones && opts.listTombstones.length > 0
      ? [...opts.lists, ...opts.listTombstones]
      : opts.lists,
    settings: opts.settings,
  };
}
