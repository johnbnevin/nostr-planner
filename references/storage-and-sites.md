# Storage, Static Sites, and Applets

*Verified 2026-07-25 against NIP-5A and NIP-B7.*

## Blossom Storage — now NIP-B7

Decentralized blob storage. SHA-256 content-addressed, nostr keys for auth. Standardized as **NIP-B7**; kind `10063` is the user's server list (BUD-03), kind `24242` is the auth event.

**NIP-96 is deprecated — replaced by Blossom.** Kind `10096` is superseded by `10063`.

```bash
npm install blossom-client-sdk
# or via NDK:
npm install @nostr-dev-kit/ndk-blossom
```

Core flow:
1. `PUT /upload` → server returns a Blob Descriptor: `{ url, sha256, size, type, uploaded }`
2. Store the `sha256` in a nostr event as the reference
3. `GET /<sha256>` from **any** Blossom server retrieves it — content addressing means the host is interchangeable
4. Mirror to multiple servers for redundancy (BUD-04)

Key SDK methods: `uploadBlob()`, `multiServerUpload()`, `listBlobs()`, `createUploadAuth()`

**Always read the user's kind 10063 list and upload to *their* servers**, mirroring across several. A single hardcoded server is a point of failure and a tracking vector — it quietly re-centralizes your app.

Pair uploads with **NIP-92 `imeta`** tags so clients can lay out media without fetching it first.

Spec: https://github.com/hzrd149/blossom (BUD-01 through BUD-09)

## NSite — Static Hosting, now NIP-5A

Static web apps hosted under your npub. Files go to Blossom; a manifest event maps paths to hashes; a gateway resolves the manifest from relays and serves blobs from Blossom.

**The kinds changed. Anything teaching kind 34128 is out of date:**

| Kind | Role |
|---|---|
| `15128` | **Root site** — replaceable, one per pubkey, MUST NOT have a `d` tag |
| `35128` | **Named site** — addressable, `d` tag is the site id, must match `^[a-z0-9-]{1,13}$` and not end with `-` |
| `5128` | **Manifest snapshot** — regular event, pins a version, addressable by event id |
| `34128` | legacy, deprecated |

The 1–13 character limit on `d` exists because DNS labels cap at 63 and `pubkeyB36` eats 50 of them.

### Manifest tags

- `["path", "/absolute/path", "<sha256>"]` — one or more, required
- `["x", "<sha256-hex>", "aggregate"]` — recommended, makes the site version indexable
- `["server", "<url>"]` — Blossom hints
- `title`, `description`, `source` — optional metadata
- `["app", "<kind>:<pubkey>:<d>", "<relay>"]` — links to a NIP-89 or other app descriptor
- Copied sites: `a` = immediate parent, `A` = origin of the lineage (both required when copying)

### Aggregate hash

Sort `"<hash> <path>\n"` lines lexicographically, concatenate as UTF-8, SHA-256. Two manifests are equivalent iff their aggregate hashes match.

```javascript
const aggregateHash = sha256(event.tags.filter(t => t[0] === "path").map(([, path, hash]) => `${hash} ${path}\n`).sort().join(""))
```

```bash
nak req -k 15128 -a <pubkey> --limit 1 wss://relay.example.com \
  | jq -r '.tags[] | select(.[0] == "path") | "\(.[2]) \(.[1])"' | sort | sha256sum
```

### Gateway resolution

Single-label subdomains, to dodge wildcard-certificate limits:

- Root site: `<npub>.host`
- Snapshot: `v<snapshotIdB36>.host` (50 chars after the `v`)
- Named site: `<pubkeyB36><dTag>.host` (pubkey base36 is always exactly 50 chars, `d` appended with no separator)

Gateways fall back to `/index.html` for directory paths and `/404.html` when nothing matches, SHOULD verify the blob hash matches the manifest, and MUST forward `Content-Type` / `Content-Length` from the Blossom server.

### Deploy

**`nsyte` (dskvr) is the current tool** — a Deno rewrite of flox1an's `nsite-cli`:

```bash
deno install -A -f -g -n nsyte jsr:@nsyte/cli
npm run build
nsyte deploy ./dist
```

Requires a NIP-07 extension or nsec to sign the deployment. Visitors log in with their own keys — no server accounts. `nsite-action` runs this from CI. Other options: `nsite-cli`, `nous-cli`, `nostr-deploy-cli` (see awesome-nsite).

### nsites in practice

**What you actually get.** A web app addressed by a keypair rather than a domain. No DNS registrar, no hosting account, no CA relationship of your own, and no single server to seize — the manifest is replicated across relays and the files across Blossom servers. Anyone can run a gateway; if one is blocked, another resolves the same npub to the same bytes.

**What you don't get, and must design around:**
- **No server.** No backend, no server-side rendering, no secrets in the build, no API routes. Everything is a static asset plus whatever the client does at runtime against relays and Blossom.
- **Gateways are trusted for delivery.** A gateway *should* verify blob hashes against the manifest, but it's the one serving you JavaScript. Treat a public gateway roughly like a CDN you don't control.
- **The npub is the identity.** Losing that key loses the site's address. Deploying with a hot nsec on a CI runner is a real risk — prefer NIP-07/NIP-46 signing for deploys, and consider a dedicated deploy key that isn't your social identity.
- **Updates are replaceable events.** Publishing a new `15128` replaces the old one. Publish a `5128` snapshot first if you want the previous version to remain addressable.

**Practical build notes.**
- Use **relative paths** — a site served from `<npub>.gateway` and from `v<snapshot>.gateway` must work at both. Absolute `/assets/...` paths are usually fine; a hardcoded origin is not.
- Hash-router or ensure the gateway's `/404.html` fallback handles your history-API routes. Directory paths fall back to `index.html`, everything unmatched to `/404.html`.
- Keep the file count sane: every file is a `path` tag, and relays enforce `max_event_tags` (see `relays.md`). A build that emits thousands of chunks can produce a manifest a relay refuses. Check the limit before shipping a large site.
- Upload to **several** Blossom servers and list them in `server` tags. One server is a countdown.
- Publish the manifest to several relays too — an unreachable manifest is an unreachable site.
- Set `title`, `description`, and `source`. `source` pointing at an ngit/NIP-34 repo closes the loop: verifiable code, verifiable deployment.
- CI: `nsite-action` runs `nsyte` on push. Keep the signing key out of the repo.

**Good fits:** client apps, docs, landing pages, this kind of reference material, anything you want to survive a domain lapse or a takedown. **Bad fits:** anything needing a server secret, server-side auth, or a database you control.

## Napplets — NIP-5D

Where NIP-5A serves *static* sites from Blossom, **NIP-5D** extends the same model to *interactive* ones — apps that read and write nostr events.

### The model

A **napplet** is a sandboxed, single-purpose nostr app running in an **iframe**. The page hosting it is the **shell**. They talk over a structured `postMessage` protocol, and the napplet delegates everything privileged to the shell:

| Napplet does | Shell provides |
|---|---|
| UI and app logic for one job | **Signing** — the napplet never sees a key |
| Renders events it's given | **Relay access** — queries and publishes on its behalf |
| Requests actions | **Storage** and **user context** — who's logged in |

The iframe sandbox is the trust boundary. A napplet **cannot** reach the user's key, cannot exfiltrate it, and cannot open its own relay connections behind the user's back. That inversion is the whole point: today, using a small nostr tool means pasting your nsec into it or installing an extension and granting it everything. With napplets you grant a scoped capability instead.

### Why it matters

- **Composability over monoliths.** Every client currently rebuilds the same feed, DM, profile, and wallet surfaces. Napplets let a user assemble a client from parts, and let a developer ship one good part.
- **A lower floor for contributors.** You can build something useful without deep protocol knowledge and without ever holding anyone's nsec — which is exactly the population currently locked out of building safely.
- **Distribution is nostr-native.** Same pipeline as nsites: files to Blossom, a signed manifest, resolved from relays. A manifest is generated at build time. Nothing to app-store, nothing to take down centrally.
- **Least privilege as the default.** It's the sandbox model applied to a protocol where the alternative is handing over a private key.

### Status — read this before betting on it

dskvr's spec, **PR #2303 with provisional numbering — not merged into the NIPs repo.** It is live in the wild rather than blessed: **Amethyst v1.12.6** added NIP-5D *and* NIP-5A support, resolving both straight from signed manifests over Blossom.

So: real, shipping, and still liable to change. Build a napplet if the sandbox model fits; don't assume the message protocol is frozen, and pin what you depend on.

Runtime, docs, and the reference shell: https://napplet.run/

### When to reach for it

Whenever a feature is genuinely self-contained — a calculator, a poll widget, a zap splitter, a storefront, a chart, a moderation tool. Shipping it as a napplet gets it into **any** shell rather than only your own app, and it's the honest answer to "I want to use this small tool but not give it my key."

Conversely, don't force it: an app that needs its own relay strategy, background sync, or deep platform integration is a client, not a napplet.
