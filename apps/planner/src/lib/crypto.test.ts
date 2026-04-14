/**
 * Unit tests for crypto.ts — kind masking roundtrips for NIP-44 and AES-GCM.
 */
import { describe, it, expect } from "vitest";
import * as nip44 from "nostr-tools/nip44";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import {
  encryptEvent,
  decryptEvent,
  encryptEventWithSharedKey,
  decryptEventWithSharedKey,
  isEncryptedEvent,
  isSharedEncryptedEvent,
  getSharedCalendarRef,
} from "./crypto";
import { generateSharedKey } from "./sharing";
import { KIND_APP_DATA } from "./nostr";
import type { NostrSigner, UnsignedEvent } from "./signer";
import type { NostrEvent } from "@nostrify/nostrify";

// ── Test helpers ────────────────────────────────────────────────────────

/** Real NIP-44 signer backed by a generated keypair. Safe to use in Node tests. */
function makeSigner(secretKey: Uint8Array): NostrSigner {
  const pubkey = getPublicKey(secretKey);
  return {
    getPublicKey: async () => pubkey,
    signEvent: async (_: UnsignedEvent): Promise<NostrEvent> => {
      throw new Error("signEvent not needed for crypto tests");
    },
    nip44: {
      encrypt: async (recipientPubkey: string, plaintext: string): Promise<string> => {
        const convKey = nip44.getConversationKey(secretKey, recipientPubkey);
        return nip44.encrypt(plaintext, convKey);
      },
      decrypt: async (senderPubkey: string, ciphertext: string): Promise<string> => {
        const convKey = nip44.getConversationKey(secretKey, senderPubkey);
        return nip44.decrypt(ciphertext, convKey);
      },
    },
  };
}

const KIND_TIME_EVENT = 31923;
const KIND_DATE_EVENT = 31922;

// ── NIP-44 kind masking ─────────────────────────────────────────────────

describe("NIP-44 encryptEvent / decryptEvent kind masking", () => {
  it("publishes as kind 30078 regardless of original kind", async () => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const signer = makeSigner(sk);

    const tags = [["d", "test-dtag"], ["title", "Test Meeting"], ["start", "1718000000"]];
    const result = await encryptEvent(pk, KIND_TIME_EVENT, "test-dtag", tags, "", signer);

    expect(result.kind).toBe(KIND_APP_DATA);
    expect(result.kind).toBe(30078);
  });

  it("restores the original kind after decryption", async () => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const signer = makeSigner(sk);

    const tags = [["d", "test-dtag"], ["title", "Team Lunch"], ["start", "1718000000"]];
    const encrypted = await encryptEvent(pk, KIND_TIME_EVENT, "test-dtag", tags, "", signer);
    const decrypted = await decryptEvent(pk, encrypted.content, KIND_APP_DATA, "test-dtag", signer);

    expect(decrypted.kind).toBe(KIND_TIME_EVENT);
  });

  it("only keeps d and encrypted tags in the clear", async () => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const signer = makeSigner(sk);

    const tags = [
      ["d", "priv-event"],
      ["title", "Secret Meeting"],
      ["start", "1718000000"],
      ["location", "HQ"],
    ];
    const encrypted = await encryptEvent(pk, KIND_TIME_EVENT, "priv-event", tags, "", signer);

    const clearTagNames = encrypted.tags.map((t) => t[0]);
    expect(clearTagNames).toContain("d");
    expect(clearTagNames).toContain("encrypted");
    expect(clearTagNames).not.toContain("title");
    expect(clearTagNames).not.toContain("location");
    expect(isEncryptedEvent(encrypted.tags)).toBe(true);
  });

  it("restores all metadata tags after roundtrip", async () => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const signer = makeSigner(sk);

    const tags = [
      ["d", "roundtrip"],
      ["title", "My Event"],
      ["start", "1718000000"],
      ["location", "Conference Room A"],
      ["t", "work"],
      ["t", "meeting"],
    ];
    const encrypted = await encryptEvent(pk, KIND_TIME_EVENT, "roundtrip", tags, "", signer);
    const decrypted = await decryptEvent(pk, encrypted.content, KIND_APP_DATA, "roundtrip", signer);

    expect(decrypted.tags.find((t) => t[0] === "title")?.[1]).toBe("My Event");
    expect(decrypted.tags.find((t) => t[0] === "location")?.[1]).toBe("Conference Room A");
    expect(decrypted.tags.filter((t) => t[0] === "t").map((t) => t[1])).toEqual(["work", "meeting"]);
  });

  it("falls back to provided kind when originalKind is absent (backwards compat)", async () => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const signer = makeSigner(sk);

    // Simulate a legacy payload without originalKind
    const legacyPayload = JSON.stringify({ title: "Legacy", start: "1718000000" });
    const ciphertext = await signer.nip44.encrypt(pk, legacyPayload);

    const result = await decryptEvent(pk, ciphertext, KIND_DATE_EVENT, "legacy", signer);
    expect(result.kind).toBe(KIND_DATE_EVENT);
  });

  it("roundtrips content (description) correctly", async () => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const signer = makeSigner(sk);

    const tags = [["d", "desc-test"], ["title", "Meeting"]];
    const encrypted = await encryptEvent(pk, KIND_TIME_EVENT, "desc-test", tags, "Important notes here", signer);
    const decrypted = await decryptEvent(pk, encrypted.content, KIND_APP_DATA, "desc-test", signer);

    expect(decrypted.content).toBe("Important notes here");
  });
});

// ── AES-GCM kind masking ────────────────────────────────────────────────

describe("AES-GCM encryptEventWithSharedKey / decryptEventWithSharedKey kind masking", () => {
  it("publishes as kind 30078 regardless of original kind", async () => {
    const sharedKey = await generateSharedKey();
    const tags = [["d", "shared-dtag"], ["title", "Shared Event"], ["start", "1718000000"]];

    const result = await encryptEventWithSharedKey(
      sharedKey, "my-calendar", KIND_TIME_EVENT, "shared-dtag", tags, ""
    );

    expect(result.kind).toBe(KIND_APP_DATA);
    expect(result.kind).toBe(30078);
  });

  it("restores the original kind after decryption", async () => {
    const sharedKey = await generateSharedKey();
    const tags = [["d", "shared-dtag"], ["title", "Event"], ["start", "1718000000"]];

    const encrypted = await encryptEventWithSharedKey(
      sharedKey, "my-calendar", KIND_TIME_EVENT, "shared-dtag", tags, ""
    );
    const decrypted = await decryptEventWithSharedKey(
      sharedKey, encrypted.content, KIND_APP_DATA, "shared-dtag"
    );

    expect(decrypted.kind).toBe(KIND_TIME_EVENT);
  });

  it("includes shared-calendar tag in the clear", async () => {
    const sharedKey = await generateSharedKey();
    const tags = [["d", "shared-dtag"], ["title", "Event"]];

    const result = await encryptEventWithSharedKey(
      sharedKey, "cal-abc", KIND_TIME_EVENT, "shared-dtag", tags, ""
    );

    expect(isSharedEncryptedEvent(result.tags)).toBe(true);
    expect(getSharedCalendarRef(result.tags)).toBe("cal-abc");
  });

  it("does not leak title or location in the clear tags", async () => {
    const sharedKey = await generateSharedKey();
    const tags = [
      ["d", "evt"],
      ["title", "Secret Shared Event"],
      ["location", "Private HQ"],
    ];

    const result = await encryptEventWithSharedKey(
      sharedKey, "cal-1", KIND_TIME_EVENT, "evt", tags, ""
    );

    const clearTagNames = result.tags.map((t) => t[0]);
    expect(clearTagNames).not.toContain("title");
    expect(clearTagNames).not.toContain("location");
  });

  it("fails to decrypt with a different key", async () => {
    const key1 = await generateSharedKey();
    const key2 = await generateSharedKey();
    const tags = [["d", "event"], ["title", "Secret"]];

    const encrypted = await encryptEventWithSharedKey(
      key1, "cal-1", KIND_TIME_EVENT, "event", tags, ""
    );

    await expect(
      decryptEventWithSharedKey(key2, encrypted.content, KIND_APP_DATA, "event")
    ).rejects.toThrow();
  });

  it("roundtrips all metadata correctly", async () => {
    const sharedKey = await generateSharedKey();
    const tags = [
      ["d", "evt"],
      ["title", "Shared Meeting"],
      ["start", "1718000000"],
      ["end", "1718003600"],
      ["location", "Main Hall"],
      ["t", "shared"],
    ];

    const encrypted = await encryptEventWithSharedKey(
      sharedKey, "test-cal", KIND_TIME_EVENT, "evt", tags, "meeting notes"
    );
    const decrypted = await decryptEventWithSharedKey(
      sharedKey, encrypted.content, KIND_APP_DATA, "evt"
    );

    expect(decrypted.tags.find((t) => t[0] === "title")?.[1]).toBe("Shared Meeting");
    expect(decrypted.tags.find((t) => t[0] === "location")?.[1]).toBe("Main Hall");
    expect(decrypted.content).toBe("meeting notes");
  });

  it("falls back to provided kind when originalKind is absent (backwards compat)", async () => {
    const sharedKey = await generateSharedKey();

    // Simulate legacy payload without originalKind
    const { encryptAES } = await import("./sharing");
    const legacyPayload = JSON.stringify({ title: "Old Event", start: "1718000000" });
    const ciphertext = await encryptAES(sharedKey, legacyPayload);

    const result = await decryptEventWithSharedKey(sharedKey, ciphertext, KIND_DATE_EVENT, "old-evt");
    expect(result.kind).toBe(KIND_DATE_EVENT);
  });
});
