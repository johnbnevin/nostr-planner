# Messaging — DMs, Groups, Communities

*Verified 2026-07-25.*

Four live standards with genuinely different tradeoffs. Pick deliberately; retrofitting is expensive.

| Need | Use |
|---|---|
| 1:1 or a handful of people | **NIP-17** |
| Small, high-security group; key rotation matters | **Marmot** (relays as delivery service) |
| Same, but you want to own/inspect the delivery service | **Cordn** |
| Encrypted group with zero infrastructure, ad hoc | **Cordn Ad-hoc CVM** |
| Large, casual, high-churn, Discord-shaped | **Concord** |
| Server-hosted groups, E2EE not required | **NIP-29** |

**NIP-04 is deprecated.** Read-only for legacy history; never write it, never offer it as a choice.

## Platforms and Clients to Study

Reading a shipped implementation beats reading a spec twice. These are the ones to look at.

**Ditto** — https://ditto.pub · gitlab.com/soapbox-pub/ditto (alex gleason). A **community server** rather than a chat protocol: built-in relay, web UI, moderation tooling, spam filters, NIP-05 self-service, zaps. Its distinguishing move is implementing the **Mastodon REST API**, so any Mastodon client works against it, and the **Mostr** bridge translates Nostr ↔ ActivityPub in real time — you can follow and be followed from Mastodon, Pleroma, and Misskey. Choose it when you want a curated, moderated public community on your own domain, with fediverse reach, rather than an encrypted private group. Docs: https://docs.soapbox.pub · https://about.ditto.pub

**Armada** — https://armada.buzz (Soapbox, TypeScript). A **Concord** client: Discord-shaped encrypted communities with channels, roles, and invites. The nearest thing to a reference TS implementation of the CORD specs, and the one to read alongside `applesauce-concord` when wiring Concord into your own app.

**Accordion** — https://accordion.chat. The other Concord client; useful as a second data point on how the specs are actually being interpreted.

**Vector** (Rust) moved its group chats to Concord in v0.4.0 (2026-07-15) and **Amethyst** (Kotlin) shipped its own Concord implementation — so there are now four independent implementations to compare against.

**White Noise** — the Marmot reference client (jeffg + Max Hillebrand).

Rule of thumb for picking among these: Ditto for **public, moderated, bridged** community; Armada/Accordion for **private, encrypted, Discord-shaped** community; White Noise for **small high-security** groups.

## NIP-17 — Private Direct Messages

Kinds 14 (message) and 15 (file), sealed in kind 13, wrapped in a NIP-59 **gift wrap** (kind 1059) under an ephemeral key. The seal hides the sender; the wrap hides everything else. Encryption is **NIP-44** versioned payloads.

Publish to the recipient's **kind 10050** DM relay list — not their kind 10002. Getting this wrong is the usual reason DMs silently never arrive.

This replaces NIP-04 entirely.

## Marmot Protocol / NIP-EE — MLS Group Messaging

https://github.com/marmot-protocol/marmot · kinds **443** KeyPackage, **444** Welcome, **445** Group, **10051** KeyPackage relays.

Nostr keys for identity, nostr-event-shaped payloads inside MLS, MLS as the continuous group key agreement layer. Gives forward secrecy, post-compromise recovery, and real member add/remove semantics that gift-wrapped DMs cannot provide.

**Status: adopted** as of 2026-07-08 — the spec repo moved 42 files off `draft for internal review` / `experimental draft`, dropped the `v2` framing, and reclassified the older MIP-era documents as the deprecated prior version. Two documents remain draft **by design**: the implementation model and multi-device support. So Marmot itself is stable to build on; **multi-device is not** — don't assume a user's second client can join an existing group cleanly.

**Read both documents — this is not a replacement.** NIP-EE is `final` `unrecommended`: the repo says "superseded by the Marmot Protocol", but Marmot **extends** it rather than replacing it. Those four kinds are **defined in NIP-EE**; Marmot inherits them and adds its own specs for media and group management. NIP-EE is where the mechanics live, and you'll need it:

- MLS `Credential` must be `BasicCredential` with `identity` = the 32-byte hex Nostr pubkey. Clients MUST reject any `Proposal` that changes the identity field.
- The MLS signing key **MUST NOT** be the Nostr identity key, and SHOULD be rotated — immediately after joining via a last-resort key package, then regularly.
- Required group extensions: `required_capabilities`, `ratchet_tree`, `nostr_group_data`. `last_resort` on KeyPackages is strongly recommended to avoid invite race conditions.
- Kind 445 content is NIP-44 encrypted using a keypair derived from the MLS **`exporter_secret`** (32 bytes, label `nostr`), not from sender/receiver keys. Rotate it on every new epoch.
- Group Events are published from a **fresh ephemeral keypair each time**, to obfuscate participant count and identity. The `h` tag carries the rotatable Nostr group ID — never the permanent MLS group ID, which MUST NOT be published in any form.
- Inner application messages are **unsigned** Nostr events (kind 9 for chat, 7 for reactions) and MUST carry no `h` tag — so a leak can't be published or attributed to a group.
- Kind 444 Welcome events MUST never be signed, and are gift-wrapped per NIP-59.
- **Commit race handling:** if two commits target the same epoch, apply the one with the lowest `created_at`; tie-break on lowest event `id`. Wait for relay acknowledgement of your own commit before applying it locally. Retain prior group state briefly to recover from forks.
- Above ~150 members, Welcome messages exceed the maximum event size. "Light" client welcomes are still being worked out upstream.

Reference client is **White Noise** (jeffg + Max Hillebrand, backed by Dorsey); libraries are `nostr-openmls` and OpenMLS.

## Cordn — Coordinator-Assisted MLS

https://cordn.net · https://github.com/Cordn-msg/cordn

**Do not confuse with Concord.** The names are unhelpfully close and they solve different halves of the problem.

MLS needs a *Delivery Service* — something to order messages and hand out key packages. Marmot leans on relays for that. Cordn makes the DS explicit and ownable: a minimal MLS delivery-service coordinator exposed as a **runnable ContextVM server**, so it's a distributed service rather than centralized infrastructure.

- monotonic message cursors **per group, not global across all groups**
- bounded catch-up via fetch, plus live delivery over CEP-41 open streams
- key package distribution, including **last-resort key packages** for offline members
- anti-abuse: rate limiting and key package quotas
- storage backends in-memory or SQLite

**Cordn Ad-hoc CVM** (dskvr) — https://github.com/sandwichfarm/cordn-adhoc-cvm — removes the server entirely: a browser-based MLS coordinator that runs the ContextVM coordinator **in a browser tab**, publishes the coordinator pubkey, and keeps key packages and welcomes locally. An encrypted group with no infrastructure at all.

## Concord — Discord-Style Encrypted Communities

Open MIT protocol: https://github.com/concord-protocol/concord

E2EE communities and channels with no company, no central server, and no intermediary holding messages or deciding who's in charge. It replaces the central server with three things:

- **Dumb relays** that only ever see encrypted blobs addressed to rotating labels, so users can switch relays freely
- **Membership defined by key possession** — if you can decrypt, you're in
- **Authority as a signed roster** rooted in the owner's identity, verified mathematically by every member

| Spec | Covers |
|---|---|
| CORD-01 | Private streams — shared-key NIP-59 giftwraps |
| CORD-02 | Communities — membership model, epochs, access tiers |
| CORD-03 | Channels — public/private rooms with derived keys |
| CORD-04 | Roles — granular, ranked permissions |
| CORD-05 | Invites — revocable shareable links |
| CORD-06 | Rekeys & refoundings — member removal, banning |
| CORD-07 | Audio/video — voice and screenshare with blind tokens |

**The design point** is a shared per-channel room key with **rekey-on-removal**, instead of MLS-style continuous ratcheting. Cheap at Discord scale with high churn, where MLS gets heavy.

**Implementations:** Vector (Rust), Armada — https://armada.buzz (TS, Soapbox), Accordion — https://accordion.chat, Amethyst (Kotlin), and **`applesauce-concord`** by hzrd149, the TS library to build on.

### Integration gotcha

`applesauce-concord` requires the applesauce **6.x / `0.0.0-concord-*`** line, which dropped the 5.x blueprint APIs that `marmot-ts` is hard-pinned to (`GiftWrapBlueprint`, `unlockGiftWrap`, `createEvent`, `event-factory`). One dependency tree cannot hold both.

Symptom: `tsc` passes, then the bundle fails with `Missing "./blueprints/gift-wrap" specifier in "applesauce-common"`. Vector hit this same wall and dropped Marmot.

- Do **not** add `applesauce-factory` on the concord tag — it doesn't exist there; event-factory lives in `applesauce-core`.
- Pin every applesauce package to the same concord tag.
- Use npm `overrides` to force transitive copies onto that line.

```ts
import "applesauce-concord";               // side-effect: registers NIP-44 casts
import { EventStore } from "applesauce-core";
import { RelayPool } from "applesauce-relay";
export const eventStore = new EventStore();
export const pool = new RelayPool();
```

## NIP-29 — Relay-Based Groups

Kinds 9000–9030 control events, 39000–39009 metadata, 10009 user group list. Groups live on a specific relay that enforces membership. **Not end-to-end encrypted** and requires a relay that supports it — usually self-hosted. Supersedes NIP-28 public chat and NIP-72 moderated communities, both now unrecommended.

Use when you want moderation and server-side enforcement more than you want privacy.

## ContextVM (CVM) — MCP over Nostr

Worth knowing because Cordn is built on it, and because it's directly relevant to agent tooling.

ContextVM bridges the **Model Context Protocol to Nostr** — MCP servers and clients talk over relays instead of a direct centralized connection. MCP JSON-RPC messages travel in **ephemeral kind `25910`** events. Nostr's own primitives handle verification and authorization: the server is a pubkey, discovery and auth come free, and there's no host to trust or take down.

Supports optional encryption, oversized payloads, open-ended streams. SDKs in **TypeScript and Rust** (transports, gateways, relay handlers, signers, payments). Docs and CEPs: https://docs.contextvm.org

Any tool you'd expose to an LLM over MCP can instead be published to nostr — addressable by pubkey, payable over Lightning or ecash. See also `nutoff-wallet` (Cashu over ContextVM) and `dvmcp` (gzuuus) bridging MCP servers to the DVM ecosystem.
