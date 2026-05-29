import { describe, it, expect } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { nsecEncode } from "nostr-tools/nip19";
import { bytesToHex } from "@noble/hashes/utils";
import { LocalSigner } from "./localSigner";

// ── fromKey input validation ──────────────────────────────────────────
//
// fromKey must reject malformed / out-of-range keys with a clear error
// rather than constructing a signer bound to an unintended (or invalid)
// keypair.

describe("LocalSigner.fromKey validation", () => {
  it("accepts a valid 64-char hex key", () => {
    const sk = generateSecretKey();
    const hex = bytesToHex(sk);
    const signer = LocalSigner.fromKey(hex);
    expect(signer).toBeInstanceOf(LocalSigner);
  });

  it("accepts a valid nsec and matches the hex pubkey", async () => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const signer = LocalSigner.fromKey(nsecEncode(sk));
    expect(await signer.getPublicKey()).toBe(pk);
  });

  it("trims surrounding whitespace", () => {
    const hex = bytesToHex(generateSecretKey());
    expect(() => LocalSigner.fromKey(`  ${hex}\n`)).not.toThrow();
  });

  it("rejects hex of the wrong length", () => {
    expect(() => LocalSigner.fromKey("abc123")).toThrow(/Invalid private key/);
    expect(() => LocalSigner.fromKey("a".repeat(63))).toThrow(/Invalid private key/);
    expect(() => LocalSigner.fromKey("a".repeat(65))).toThrow(/Invalid private key/);
  });

  it("rejects non-hex characters", () => {
    expect(() => LocalSigner.fromKey("z".repeat(64))).toThrow(/Invalid private key/);
  });

  it("rejects the all-zero key", () => {
    expect(() => LocalSigner.fromKey("0".repeat(64))).toThrow(/zero/);
  });

  it("rejects an out-of-range key (>= secp256k1 group order)", () => {
    // n itself is not a valid scalar (valid range is [1, n-1]).
    const n = "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141";
    expect(() => LocalSigner.fromKey(n)).toThrow(/out of secp256k1 range/);
    // All-ff is also > n.
    expect(() => LocalSigner.fromKey("f".repeat(64))).toThrow(/out of secp256k1 range/);
  });

  it("rejects a malformed nsec", () => {
    expect(() => LocalSigner.fromKey("nsec1notvalid")).toThrow(/Invalid nsec/);
  });
});
