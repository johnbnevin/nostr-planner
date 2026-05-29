/**
 * Unit tests for sharing.ts — AES key management, invite encode/decode.
 */
import { describe, it, expect, beforeAll } from "vitest";
import {
  generateSharedKey,
  exportKeyToBase64,
  importKeyFromBase64,
  encryptAES,
  decryptAES,
  encodeInvitePayload,
  decodeInvitePayload,
  lookupNip05,
  isAcceptedShare,
  isRejectedShare,
  acceptShare,
  rejectShare,
} from "./sharing";

// ── AES key generation and round-trip ──────────────────────────────────

describe("generateSharedKey", () => {
  it("generates a CryptoKey", async () => {
    const key = await generateSharedKey();
    expect(key).toBeInstanceOf(CryptoKey);
    expect(key.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
  });

  it("generates unique keys", async () => {
    const k1 = await exportKeyToBase64(await generateSharedKey());
    const k2 = await exportKeyToBase64(await generateSharedKey());
    expect(k1).not.toBe(k2);
  });
});

describe("exportKeyToBase64 / importKeyFromBase64", () => {
  it("round-trips a key", async () => {
    const original = await generateSharedKey();
    const b64 = await exportKeyToBase64(original);
    const imported = await importKeyFromBase64(b64);
    const reimported = await exportKeyToBase64(imported);
    expect(b64).toBe(reimported);
  });

  it("produces valid base64", async () => {
    const key = await generateSharedKey();
    const b64 = await exportKeyToBase64(key);
    expect(() => atob(b64)).not.toThrow();
    // AES-256 = 32 bytes
    expect(atob(b64).length).toBe(32);
  });
});

// ── AES-GCM encrypt/decrypt ────────────────────────────────────────────

describe("encryptAES / decryptAES", () => {
  it("round-trips plaintext", async () => {
    const key = await generateSharedKey();
    const plaintext = "Hello, world! 🔐";
    const ciphertext = await encryptAES(key, plaintext);
    const decrypted = await decryptAES(key, ciphertext);
    expect(decrypted).toBe(plaintext);
  });

  it("produces different ciphertext each time (unique IV)", async () => {
    const key = await generateSharedKey();
    const plaintext = "same text";
    const ct1 = await encryptAES(key, plaintext);
    const ct2 = await encryptAES(key, plaintext);
    expect(ct1).not.toBe(ct2); // Different IVs
  });

  it("fails with wrong key", async () => {
    const key1 = await generateSharedKey();
    const key2 = await generateSharedKey();
    const ciphertext = await encryptAES(key1, "secret");
    await expect(decryptAES(key2, ciphertext)).rejects.toThrow();
  });

  it("handles empty string", async () => {
    const key = await generateSharedKey();
    const ciphertext = await encryptAES(key, "");
    const decrypted = await decryptAES(key, ciphertext);
    expect(decrypted).toBe("");
  });

  it("handles large payloads", async () => {
    const key = await generateSharedKey();
    const large = "x".repeat(100_000);
    const ciphertext = await encryptAES(key, large);
    const decrypted = await decryptAES(key, ciphertext);
    expect(decrypted).toBe(large);
  });

  it("ciphertext format is iv:ciphertext in base64", async () => {
    const key = await generateSharedKey();
    const ciphertext = await encryptAES(key, "test");
    const parts = ciphertext.split(":");
    expect(parts).toHaveLength(2);
    // Both parts should be valid base64
    expect(() => atob(parts[0]!)).not.toThrow();
    expect(() => atob(parts[1]!)).not.toThrow();
    // IV should be 12 bytes
    expect(atob(parts[0]!).length).toBe(12);
  });
});

// ── Invite payload encode/decode ───────────────────────────────────────

describe("encodeInvitePayload / decodeInvitePayload", () => {
  const validOpts = {
    ownerPubkey: "a".repeat(64),
    calDTag: "cal-test-123",
    title: "My Calendar",
  };

  it("round-trips a valid payload with key always empty", () => {
    const encoded = encodeInvitePayload(validOpts);
    const decoded = decodeInvitePayload(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded!.o).toBe(validOpts.ownerPubkey);
    expect(decoded!.c).toBe(validOpts.calDTag);
    expect(decoded!.t).toBe(validOpts.title);
    expect(decoded!.k).toBe(""); // key is never embedded in URLs
    expect(decoded!.v).toBe(1);
  });

  it("rejects invalid base64", () => {
    expect(decodeInvitePayload("not-valid-base64!!!")).toBeNull();
  });

  it("rejects missing required fields", () => {
    const incomplete = btoa(JSON.stringify({ v: 1, o: "a".repeat(64) }));
    expect(decodeInvitePayload(incomplete)).toBeNull();
  });

  it("rejects wrong version", () => {
    const wrong = btoa(JSON.stringify({
      v: 2,
      o: "a".repeat(64),
      c: "cal",
      k: "key",
    }));
    expect(decodeInvitePayload(wrong)).toBeNull();
  });

  it("rejects invalid pubkey format", () => {
    const bad = btoa(JSON.stringify({
      v: 1,
      o: "not-a-hex-pubkey",
      c: "cal",
      k: "key",
      t: "title",
    }));
    expect(decodeInvitePayload(bad)).toBeNull();
  });

  it("rejects dTag with path traversal characters", () => {
    const bad = btoa(JSON.stringify({
      v: 1,
      o: "a".repeat(64),
      c: "../../../etc/passwd",
      k: "key",
      t: "title",
    }));
    expect(decodeInvitePayload(bad)).toBeNull();
  });

  it("rejects missing title field (t)", () => {
    const bad = btoa(JSON.stringify({
      v: 1,
      o: "a".repeat(64),
      c: "mycal",
      k: "key",
      // t is absent
    }));
    expect(decodeInvitePayload(bad)).toBeNull();
  });

  it("rejects empty calDTag", () => {
    const bad = btoa(JSON.stringify({
      v: 1,
      o: "a".repeat(64),
      c: "",
      k: "key",
      t: "title",
    }));
    expect(decodeInvitePayload(bad)).toBeNull();
  });

  it("rejects calDTag that exceeds max length", () => {
    const bad = btoa(JSON.stringify({
      v: 1,
      o: "a".repeat(64),
      c: "a".repeat(129), // > 128 chars
      k: "key",
      t: "title",
    }));
    expect(decodeInvitePayload(bad)).toBeNull();
  });

  it("accepts unicode characters in title", () => {
    const encoded = encodeInvitePayload({
      ownerPubkey: "a".repeat(64),
      calDTag: "cal",
      title: "Café & 日本語 Events 🗓️",
    });
    const decoded = decodeInvitePayload(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded!.t).toBe("Café & 日本語 Events 🗓️");
  });
});

// ── NIP-05 lookup input validation (SSRF guards) ──────────────────────────
//
// We don't exercise the network — just the early-return guards on malformed
// identifiers, so the fetch is never reached. Anything returning null before
// fetch is safe by construction.

describe("lookupNip05 input validation", () => {
  it("rejects an identifier with no @", async () => {
    expect(await lookupNip05("example.com")).toBeNull();
  });
  it("rejects empty name or domain", async () => {
    expect(await lookupNip05("@example.com")).toBeNull();
    expect(await lookupNip05("alice@")).toBeNull();
  });
  it("rejects embedded userinfo that would mask the real host", async () => {
    // domain="evil.com@localhost" would pass an isBlockedHostname(evil.com)
    // check while the fetch actually resolved to localhost. Must be rejected
    // before the request is built.
    expect(await lookupNip05("alice@evil.com@localhost")).toBeNull();
  });
  it("rejects path / query / fragment / whitespace in the domain", async () => {
    expect(await lookupNip05("alice@example.com/x")).toBeNull();
    expect(await lookupNip05("alice@example.com?x=1")).toBeNull();
    expect(await lookupNip05("alice@example.com#frag")).toBeNull();
    expect(await lookupNip05("alice@example .com")).toBeNull();
  });
  it("rejects URL meta-chars in the name", async () => {
    expect(await lookupNip05("a/b@example.com")).toBeNull();
    expect(await lookupNip05("a#b@example.com")).toBeNull();
  });
  it("rejects loopback / private hosts", async () => {
    expect(await lookupNip05("alice@localhost")).toBeNull();
    expect(await lookupNip05("alice@127.0.0.1")).toBeNull();
    expect(await lookupNip05("alice@192.168.1.1")).toBeNull();
  });
});

// ── Invitation consent (durable accept/reject) ────────────────────────────
//
// Gates auto-import of shared-calendar key envelopes so a third party can't
// inject a calendar into a victim's view. Backed by localStorage (jsdom).

describe("invitation consent", () => {
  const me = "f".repeat(64);
  const owner = "a".repeat(64);
  const cal = "cal-xyz";

  // This test file runs in the node environment (no DOM); provide a minimal
  // localStorage so the durable-consent helpers have somewhere to persist.
  beforeAll(() => {
    if (typeof globalThis.localStorage === "undefined") {
      const store = new Map<string, string>();
      (globalThis as unknown as { localStorage: Storage }).localStorage = {
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        setItem: (k: string, v: string) => void store.set(k, String(v)),
        removeItem: (k: string) => void store.delete(k),
        clear: () => store.clear(),
        key: (i: number) => [...store.keys()][i] ?? null,
        get length() { return store.size; },
      } as Storage;
    }
  });

  it("defaults to neither accepted nor rejected", () => {
    expect(isAcceptedShare(me, owner, cal)).toBe(false);
    expect(isRejectedShare(me, owner, cal)).toBe(false);
  });

  it("records acceptance durably and owner-specifically", () => {
    acceptShare(me, owner, cal);
    expect(isAcceptedShare(me, owner, cal)).toBe(true);
    // A different owner with the same calDTag is a distinct decision.
    expect(isAcceptedShare(me, "b".repeat(64), cal)).toBe(false);
    // Another user's store is independent.
    expect(isAcceptedShare("c".repeat(64), owner, cal)).toBe(false);
  });

  it("records rejection durably", () => {
    rejectShare(me, owner, "cal-rejected");
    expect(isRejectedShare(me, owner, "cal-rejected")).toBe(true);
    expect(isAcceptedShare(me, owner, "cal-rejected")).toBe(false);
  });
});
