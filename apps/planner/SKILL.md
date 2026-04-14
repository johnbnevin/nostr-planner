---
name: nostr-react-typescript description: Ready to make a nostr website using react and typescript.
---
# Nostr React/TypeScript Developer Skill

> Paste this file as CLAUDE.md at the start of any Nostr project.
> This is a compass, not a rulebook. Nostr is young and fast-moving.
> Devs sometimes disagree. Specs are still drafts. Prefer live sources over anything in this file.

---

## MCP Tools — Use These Before Guessing

| Tool | Use |
|------|-----|
| `mcp__nostr__read_nip` | Read full NIP spec — e.g. `read_nip("52")` |
| `mcp__nostr__read_kind` | Look up any kind number |
| `mcp__nostr__read_tag` | Look up a tag name |
| `mcp__nostr__read_nips_index` | Browse all NIPs |
| `mcp__nostr__read_protocol` | Protocol fundamentals |
| `mcp__nostr__generate_kind` | Scaffold a new event kind |
| `mcp__nostr__fetch_event` | Fetch a live event from relays |

---

## Authorities

Check their recent GitHub repos when in doubt — they don't always agree with each other, and that's fine:

- **fiatjaf** — protocol architect. `khatru` (relay framework), `nak` (CLI tool), `nos2x` (NIP-07 browser extension), `awesome-nostr`
- **jb55** — tooling. `nostril`, `nostr-js`
- **hzrd149** — Blossom storage. `blossom`, `blossom-client-sdk`, `blossom-server`
- **hodlbod** — client architecture & relay strategy. `coracle`, `welshman` (extracted toolkit)
- **jeffg** — `whitenoise`, `marmot`
- **vitorpamplona** — `amethyst`, `quartz`
- **purrgrammer** — `grimoire`, `https://github.com/purrgrammer/grimoire/tree/main/.claude/skills`

Key references:
- NIPs: https://nips.nostr.com
- Kind registry (check before picking/creating a kind): https://undocumented.nostrkinds.info/
- Outbox model research: https://github.com/nostrability/outbox
- NSite hosting: https://nsite.run
- NSite CLI: https://github.com/flox1an/nsite-cli
- Building Nostr (coracle guide): https://building-nostr.coracle.social/
- Core Nostr Functionality Library: https://nostrcompass.org/en/topics/quartz/
- NAK skill doc: https://gitlab.com/soapbox-pub/nostr-skills/-/blob/main/skills/nak/SKILL.md
- Nostr client tools: https://github.com/nbd-wtf/nostr-tools
- Nostr projects tools: https://github.com/soapbox-pub/nostrify
- Cheap and fast statistics (zap totals, follower totals etc): https://antiprimal.net/
---

## ⚠ Before Choosing or Creating an Event Kind

Do this every time, even if you think you know the answer:

1. `mcp__nostr__read_kind` — does this kind already exist?
2. Check https://undocumented.nostrkinds.info/ — is the number already in use?
3. `mcp__nostr__read_nips_index` — is there a NIP covering this use case?
4. Look at what the authority devs have shipped — don't reinvent what already exists

When creating a new kind:
- Don't invent kinds for things that already have NIPs (even draft ones)
- Don't pick a number already in use — verify at undocumented.nostrkinds.info
- Prefer 30000–39999 for addressable (parameterized replaceable) events
- Document your reason for the specific number chosen

---

## Protocol Basics (NIP-01)

Event structure:
```json
{
  "id": "<sha256 of serialized event>",
  "pubkey": "<hex pubkey>",
  "created_at": "<unix seconds>",
  "kind": "<integer>",
  "tags": [["tag", "value"], ["tag2", "value2"]],
  "content": "<string>",
  "sig": "<Schnorr signature>"
}
```

Event categories by kind range:
- **Regular** (1–9999, 11000–19999): stored, not replaced
- **Replaceable** (0, 10000–19999): latest per pubkey+kind wins
- **Addressable** (30000–39999): latest per pubkey+kind+`d` tag wins
- **Ephemeral** (20000–29999): not stored by relays

---

## Key Libraries

These overlap — pick one per project and stay consistent.

### @nostrify/nostrify (JSR)
```bash
npx jsr add @nostrify/nostrify
```
Modular TypeScript. Works browser/Node/Deno. AsyncGenerator-based relay streaming. Interchangeable signers and storage backends. Interops with nostr-tools and NDK.

### @nostr-dev-kit/ndk (npm)
```bash
npm install @nostr-dev-kit/ndk
npm install @nostr-dev-kit/ndk-react   # React hooks
npm install @nostr-dev-kit/ndk-blossom # Blossom integration
```
Higher-level, broad NIP coverage, good ecosystem. Popular choice for React apps.

### nostr-tools (npm)
```bash
npm install nostr-tools
```
Low-level. Event creation, signing, verification, NIP-19 encode/decode. Good when you want fine-grained control.

### welshman (coracle)
https://github.com/coracle-social/welshman — best for advanced relay logic, web-of-trust, outbox model. TypeScript monorepo.

---

## Login / Key Management

**NIP-07 — browser extension (preferred for web apps):**
```typescript
if (window.nostr) {
  const pubkey = await window.nostr.getPublicKey()
  const signed = await window.nostr.signEvent(unsignedEvent)
}
```
Extensions: nos2x (fiatjaf), Alby, Amber (Android)

**NIP-46 — remote signer / bunker:**
App connects to a signer app via Nostr relay. Private key never touches the web app. Uses `nsecbunker://` connection strings.

**NIP-49 — encrypted local key:**
`ncryptsec` format. Password-protected key for backup/restore flows.

Rules:
- Never accept nsec in production UI
- Never log or transmit private keys
- Key never touches a server you control

---

## Relay Strategy

**NIP-65 (kind 10002) — user's relay list:**
Fetch this first for any user. It declares where to read/write their events.

**Outbox model:** Route queries to the relays each author declared in NIP-65, not just popular relays. Research at https://github.com/nostrability/outbox shows learning-based relay selection (Thompson Sampling) gives the best event recovery. For simple apps: start with 3–5 known relays + user's NIP-65 list. Add sophistication later if needed.

**NIP-42:** Some relays require authentication. Handle the `AUTH` challenge gracefully rather than failing silently.

---

## Blossom Storage (hzrd149)

Decentralized blob storage. SHA-256 content-addressed. Nostr keys for auth.

```bash
npm install blossom-client-sdk
# or via NDK:
npm install @nostr-dev-kit/ndk-blossom
```

Core flow:
1. `PUT /upload` → server returns Blob Descriptor: `{ url, sha256, size, type, uploaded }`
2. Store the `sha256` in a Nostr event as a reference
3. `GET /<sha256>` from any Blossom server to retrieve content
4. Mirror to multiple servers for redundancy (BUD-04 spec)

Key SDK methods: `uploadBlob()`, `multiServerUpload()`, `listBlobs()`, `createUploadAuth()`

Public servers: `https://blossom.nostr.build`, `https://nostr.download`

Spec: https://github.com/hzrd149/blossom (BUD-01 through BUD-09)

---

## NSite (Decentralized Static Hosting)

Hosts static web apps under your Nostr npub. Accessible at `<npub>.nostr.hu` and other gateways.

Architecture:
- Static files → uploaded to Blossom servers (SHA-256 addressed)
- File path → hash mappings → stored as kind 34128 events on Nostr relays
- Gateway fetches mappings from relays + serves files from Blossom

Deploy:
```bash
npm install -g nsite-cli
npm run build
nsite-cli deploy ./dist
```

Requires NIP-07 extension or nsec for signing deployments. Anyone can visit the nsite and login with their own Nostr keys — no server accounts needed.

---

## What's Still Evolving (early 2026)

No consensus winner yet in these areas:
- Relay selection algorithms (outbox, Thompson Sampling, etc.)
- Key management UX (NIP-07 vs NIP-46 vs custodial)
- Blossom server discovery and federation
- NSite tooling and gateway reliability
- Many NIPs are still marked `draft` or `optional`

When you hit uncertainty: check the authority devs' recent commits, use MCP tools to read the current NIP, and prefer simpler over clever.

---

## NAK CLI (useful for dev & testing)

```bash
curl -sSL https://raw.githubusercontent.com/fiatjaf/nak/master/install.sh | sh

nak req -k 31923 wss://relay.damus.io    # query events by kind
nak event -k 1 -c "test" <relay-url>    # publish a test event
nak decode nevent1...                    # decode NIP-19 identifier
nak encode npub <hex-pubkey>             # encode to npub
nak key gen                              # generate a keypair
```

Six mental models for nak: Query & Discovery, Broadcast & Migration, Identity & Encoding, Event Creation & Publishing, Development & Testing, Analytics & Monitoring.
