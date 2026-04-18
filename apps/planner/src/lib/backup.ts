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

import { BlossomClient } from "blossom-client-sdk";
import { SimplePool } from "nostr-tools/pool";
import { KIND_APP_DATA, DTAG_BACKUP, type CalendarEvent, type CalendarCollection } from "./nostr";
import { queryEvents } from "./relay";
import { logger } from "./logger";
import type { PersistedSettings } from "../contexts/SettingsContext";
import type { DailyHabit, UserList } from "../contexts/TasksContext";
import { mergeSnapshots } from "./merge";

const log = logger("backup");

const BLOSSOM_SERVERS = [
  "https://cdn.sovbit.host",
  "https://blossom.yakihonne.com",
  "https://blossom.nostr.build",
  "https://nostr.download",
];
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
  lastKnownSha?: string
): Promise<SnapshotPointer> {
  const startedAt = Date.now();

  // 0. Optimistic-concurrency guard. If another device has published a
  //    newer pointer since we last synced, merge its snapshot into ours
  //    before uploading so we don't silently overwrite their edits.
  let working = snapshot;
  if (relays && lastKnownSha !== undefined) {
    try {
      const current = await findPointer(pubkey, relays);
      if (current && current.sha256 !== lastKnownSha) {
        log.info(`pointer raced (ours=${lastKnownSha.slice(0, 8)}, remote=${current.sha256.slice(0, 8)}); merging`);
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

  // 3. Upload to the first server that accepts and returns a matching
  //    descriptor. Sequential; first success wins.
  const errors: string[] = [];
  let primary: string | null = null;
  for (const server of BLOSSOM_SERVERS) {
    try {
      log.debug(`uploading to ${server}`);
      const res = await fetchWithTimeout(
        `${server}/upload`,
        { method: "PUT", body: blob, headers: { authorization: authHeader } },
        20_000
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        errors.push(`${server}: HTTP ${res.status} ${body.slice(0, 120)}`);
        continue;
      }
      const desc = await res.json().catch(() => null) as { sha256?: string } | null;
      if (!desc || desc.sha256 !== sha256) {
        errors.push(`${server}: descriptor mismatch (got ${desc?.sha256?.slice(0, 8) ?? "null"})`);
        continue;
      }
      primary = server;
      log.info(`snapshot uploaded to ${server}`);
      break;
    } catch (err) {
      errors.push(`${server}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (!primary) {
    throw new Error(`Every Blossom server rejected the upload:\n${errors.join("\n")}`);
  }

  // 4. Publish the pointer event. Lists ALL known servers — mirrors in
  //    step 5 may arrive after the pointer is published, but that's OK
  //    because restore also falls back to BLOSSOM_SERVERS.
  const servers = [primary, ...BLOSSOM_SERVERS.filter((s) => s !== primary)];
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

  // 5. Background mirror to redundancy servers. Best-effort — user's data
  //    is already durable on `primary` and we've already returned.
  const mirrorTargets = BLOSSOM_SERVERS.filter((s) => s !== primary);
  if (mirrorTargets.length > 0) {
    scheduleIdle(() => {
      void (async () => {
        for (const server of mirrorTargets) {
          try {
            const res = await fetchWithTimeout(
              `${server}/upload`,
              { method: "PUT", body: blob, headers: { authorization: authHeader } },
              20_000
            );
            if (res.ok) log.debug(`mirror ok: ${server}`);
          } catch { /* silent */ }
        }
      })();
    });
  }

  return { sha256, servers, savedAt, counts };
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

  const allServers = [...new Set([...pointer.servers, ...BLOSSOM_SERVERS])];
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
  return { ...snap, _sha256: pointer.sha256 };
}

async function findPointer(
  pubkey: string,
  relays: string[]
): Promise<{ sha256: string; servers: string[] } | null> {
  let events: RawEvent[] = [];
  try {
    events = await queryEvents(
      relays.length > 0 ? relays.slice(0, 5) : ["wss://relay.damus.io", "wss://nos.lol"],
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
      const res = await fetchWithTimeout(`${server}/${sha256}`, {}, 15_000);
      if (!res.ok) return null;
      const buf = await res.arrayBuffer();
      if (buf.byteLength > MAX_BLOB_BYTES) return null;
      const hashBuf = await crypto.subtle.digest("SHA-256", buf);
      const actual = hexEncode(new Uint8Array(hashBuf));
      if (actual !== sha256) { log.warn(`${server}: sha256 mismatch`); return null; }
      return new TextDecoder().decode(buf);
    } catch {
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
  const urls = relays.length > 0 ? relays.slice(0, 5) : ["wss://relay.damus.io", "wss://nos.lol"];

  // Shared pointer-processing logic used by both the live subscription
  // and the periodic safety-net poll.
  const processPointer = async (sha: string, servers: string[]) => {
    if (closed) return;
    if (sha === lastSha) return;
    if (ownPublishedShas.has(sha)) { lastSha = sha; return; }
    log.debug(`watchPointer: new pointer ${sha.slice(0, 8)}, fetching`);
    const allServers = [...new Set([...servers, ...BLOSSOM_SERVERS])];
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
