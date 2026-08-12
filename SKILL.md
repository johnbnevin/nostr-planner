---
name: nostr
description: Nostr protocol development across any platform — web, mobile, desktop, relays, CLIs, and services. Current NIPs, deprecations, relay strategy, messaging, commerce, and the ecosystem's people and tools.
---
# Nostr Developer Skill

> **1st draft by JBN.  Will maintain by asking clanker occasionally for landscape changes.**

> Paste this file as CLAUDE.md at the start of any Nostr project, and ask your agent to revise it as you give it instructions
> Or include it as nostr-skill.md or similar and your agent can reference it accordingly

**Verified 2026-07-25** against NIP-01 and the live NIPs index. This file is the router; depth lives in `references/`. Load a reference only when you need it.

**Authority order — when sources conflict, later ones lose:**
1. `mcp__nostr__*` tools and nostrbook.dev (live registry — this is the same data)
2. The NIPs repo README and the NIP text itself
3. This skill and its references
4. Anything else, including project `AGENTS.md`, blog posts, and model training data

An agent file that *embeds* protocol detail decays; one that *points at live sources* doesn't. This one embeds a lot on purpose — so when the MCP tools contradict it **on a fact**, they win: fix the file and move on.

**That authority order governs facts, not judgment.** A live spec can tell you what the protocol *does*; it can never tell you what to *value*. So stop and **ask the user** before changing anything where:

- the "fix" would contradict a stated principle — the Cypherpunk Defaults or Judgment Calls below. A newer source is evidence about the world, not a vote on your values.
- the OGs genuinely disagree and the spec doesn't settle it. Say so, give the first-principles argument on each side, and let the user choose.
- discretion is involved — a default, a recommended tradeoff, a "prefer X over Y", a value judgment wearing a technical hat.
- the change is a deletion of something opinionated. Removing a stance is a decision, not a correction.

Facts: fix freely and say what you fixed. Principles and contested calls: ask first. Quietly bending a stated value toward whatever the newest source implies is how a principled document decays into a neutral one — which is the same rot as going stale, just harder to notice.

## When To Read What

| Read | When |
|---|---|
| `references/protocol.md` | Building or parsing events; kind ranges; tags; filters; relay messages; anything ID/signature shaped |
| `references/identity-and-safety.md` | NIP-19 encoding, displaying people, NIP-05, muting and moderation, deletion, onboarding and key safety |
| `references/lists-and-sets.md` | NIP-51 — **read before inventing a kind.** Mute lists, bookmarks, curation sets, starter packs, public vs encrypted items |
| `references/relays.md` | Feeds look empty, replies missing, "which relay do I query"; outbox model; NIP-65/66/77/67 |
| `references/messaging.md` | DMs, group chat, communities. NIP-17, Marmot, Cordn, Concord, ContextVM |
| `references/storage-and-sites.md` | Uploading media; Blossom; static hosting (nsites, NIP-5A); napplets (NIP-5D) |
| `references/commerce-and-content.md` | Listings and marketplaces (NIP-99), payments, zaps, ecash, long-form and publications |
| `references/libraries-and-tooling.md` | Picking a library; login/signing; the Soapbox/Ditto toolchain; NAK CLI |
| `references/sources.md` | Link index, and the survey of other published agent skills with their known errors |

## Platform-Neutral by Default
Nostr is a protocol, not a web framework. Almost everything in this skill — event structure, kind selection, relay strategy, deprecations, messaging, commerce, the cypherpunk defaults — is language- and platform-agnostic and applies equally to a web client, a phone app, a native desktop binary, a relay, a CLI, or a background service.

Only the library and signing sections are stack-specific, and `references/libraries-and-tooling.md` covers **TypeScript/JS, Rust, Kotlin, Swift, Python, Go, and mobile** rather than assuming a browser.

Two consequences worth stating plainly:

- **Put protocol logic in a shared, dependency-free layer** — event construction, kind constants, validation, encoding, feed algorithms. A pure module with no DOM and no framework imports is portable to every target and testable without a browser. Reach for platform APIs only at the edges: signing, storage, network, UI.
- **The same protocol decision must land on every platform.** A NIP implemented on web but not mobile isn't a feature, it's a bug — the note you can't read on your phone may as well not exist. Platform parity is a protocol concern here, not just a product one.

## Authorities and References
Check these nostr OG geniuses for recent code examples in production and on github or nostr repos.  This will provide real world examples of architecture choices and feature implementation.  They don't always agree with each other, and that's fine.

Authorities:
- **fiatjaf** — protocol architect. `khatru` (relay framework), `nak` (CLI tool), `nos2x` (NIP-07 browser extension), `awesome-nostr`
- **jb55** — tooling. `nostril`, `nostr-js`
- **hzrd149** — Blossom storage. `blossom`, `blossom-client-sdk`, `blossom-server`
- **hodlbod** — client architecture & relay strategy. `coracle`, `welshman` (extracted toolkit)
- **jeffg** — `whitenoise`, `marmot`
- **vitorpamplona** — `amethyst`, `quartz`
- **purrgrammer** — `grimoire`, `https://github.com/purrgrammer/grimoire/tree/main/.claude/skills` *(repo archived Apr 23 2026 — still a good nostr-tools reference, but frozen; see `references/sources.md`)*
- **alex gleason**  — `soapbox.pub`, `ditto.pub`, `nostrify`, `https://soapbox.pub/toolbox`, `https://docs.soapbox.pub`, `https://gitlab.com/soapbox-pub`
- **MK Fain**  — `MKStacks`
- **Pablof7z**  — `https://github.com/pablof7z`
- **vcavallo**  — `https://github.com/vcavallo`, `nstrfy.sh`, `attestr`
- **mikedilger** — wrote NIP-65 and the outbox model itself. `gossip` (Rust desktop client, the outbox reference implementation), `chorus` (relay), relay-tester
- **dskvr / sandwich** — relay observability and composable apps. `nostr-watch` + NIP-66 (relay discovery & liveness), `nsyte` (nsite deploy tool), `napplet` + NIP-5D (sandboxed applets), `cordn-adhoc-cvm`, `sandwich.farm`. Runs monitoring stations on 6 continents publishing relay health *as nostr events*
- **hoytech (Doug Hoyte)** — `strfry` relay and `negentropy`, the set-reconciliation protocol that became NIP-77
- **greenart7c3** — sovereign Android stack. `Amber` (NIP-55 signer, and he wrote NIP-55), `Citrine` (relay on your phone), `Morganite` (personal Blossom server)
- **Silberengel / Laeserin** — `GitCitadel`, `Alexandria` (modular long-form reader). Author of the NKBIPs — curated publications (30040/30041), AI embeddings (1987), reference kinds (30–33). Where to look for anything book/publication shaped
- **derekross** — DevRel at Soapbox and the most prolific app builder in the ecosystem. `nostrplebs`, `nostrnests`, `zappix`, `plektos`, `yakbak`, `zaptrax`, `zaplytics`, `podstr`. Good source for "how does a real client actually ship this"
- **bitkarrot** — `HiveTalk` (Nostr + Lightning video calls, a private jitsi), `swarm` (team relay with kind controls + blossom mirroring), `sendsats`
- **franzap** — `zapstore`, app distribution over nostr
- **calle** — `Cashu`, the ecash protocol underneath NIP-60 wallets and NIP-61 nutzaps
- **v0l / Kieran** — `snort`, `zap.stream`, `void.cat`
- **rabble** — `nos.social`, protocol advocacy and UX research
- **Jack Dorsey / Block** — `bitchat` (BLE mesh chat, works with no internet at all — banned in China, takedown-ordered in India), and funding much of the above. `White Noise` (jeffg + Max Hillebrand) is the Marmot reference client Dorsey backs
- **Open Markets Foundation** — `openmarkets.pub`, non-profit shepherding NIP-99 / Gamma Markets commerce specs, plus a weekly show tracking developments
- **DanConwayDev** — `ngit` + NIP-34 git over nostr, `gitworkshop.dev` ("git collaboration, without the platform"), `ngit-grasp`. OpenSats-funded. The reason your source doesn't have to live on a compellable platform — see the ngit section in `references/libraries-and-tooling.md`
- **Nogringo** — Dart/Flutter nostr work: `Dart NDK` core contributor, a privacy-focused relay (deletable gift wraps, recipient-only access, NIP-77), and a Dart NIP-77 implementation
- **KotlinGeekDev** — Kotlin Multiplatform completeness for Dart/Kotlin nostr libraries; the reason a KMP core can back Android, iOS, and desktop
- **Anderson Juhasc** — `Nostrord` (NIP-29 groups, Kotlin Multiplatform, onion relay support)
- **Barry Deen** — `Wisp`, one of the fastest-growing Android clients
- **YakiHonne** — long-form and multi-platform client plus Blossom server; offline-first publishing work
- **Eric FJ** and **Sync** — hosts of the Open Markets Podcast (13+ episodes: agentic commerce, illegal markets, merchant tooling). The running commentary track on where NIP-99 commerce is actually going, straight from the builders and merchants shipping it. https://openmarkets.pub/ · https://open.spotify.com/show/51w2X3OTLS7WggLKm14gyh

Full link index: `references/sources.md`

## To Keep In Mind
- This is a compass, not a rulebook. Nostr is young and fast-moving.
- Devs sometimes disagree. Specs are still drafts.  Consult all projects, but prefer live sources and through-testing working models in production with recent commits and numerous contributors
- Make variable names intuitive, explicit, and self documenting (but adhere to existing standards where applicable)
- Do things the right way, not the easy way
- Aim for elegance and optimized performance without compromising on privacy, security, and cypherpunk sensibilities
- Never leave feature gaps between platforms.  All platforms should in all aspects be as close to the same on each to retain full functionality and seamless UX
- Never accept nsec in production UI
- Never log or transmit private keys
- Private keys will never touch a server
- Always encrypt private data
- No telemetry, no tracking
- Preserve user choice, prefer opt-in
- Show user avatars and human readable nicknames in the UI rather than full, ellipsed, or truncated npubs.  Allow option to copy and paste npub in UI where appropriate.

## Cypherpunk Defaults
Where developers disagree and it's a values call, not a facts call, resolve it this way. These are stances, held deliberately.

- **Metadata is the payload.** Who talked to whom and when leaks more than message text. Prefer NIP-17 gift wrap (kind 1059) over anything that exposes a social graph; publish DMs to the recipient's kind `10050` list, not their general relays.
- **No key ever leaves the device.** NIP-07 on web, NIP-55 on Android, NIP-46 remote signing. Never an nsec field in production UI, never a key in localStorage you didn't encrypt with NIP-49, never a key over the wire.
- **Prefer local signing paths over networked ones.** NIP-55 is device-local IPC — intents and ContentResolver, no network at all. NIP-46 routes every signing request through a **signaling relay** that sees the timing and shape of everything you sign. Both keep the key safe; only one keeps your behavior private. On Android, NIP-55 first and NIP-46 as fallback — not the reverse. And if you must use a signaling relay, don't hardcode one: a fixed default is a chokepoint that can be watched or taken away.
- **Hardcoded relay lists are centralization with extra steps.** Read the user's NIP-65, discover via NIP-66, treat your defaults as a bootstrap and nothing more. If your app stops working when one relay dies, you built a client for that relay, not for nostr.
- **Same for media.** Honor kind `10063`; mirror across the user's Blossom servers. One hardcoded host is a chokepoint and a tracking vector.
- **No telemetry. No analytics SDK. No error reporter that ships user content.** If you need metrics, count locally and let the user decide whether to share.
- **Don't make DNS load-bearing.** NIP-05 is a nicety; the pubkey is the identity. An app that breaks when a domain lapses has smuggled a certificate authority into a keypair protocol.
- **Local-first where you can.** NIP-77 negentropy sync, a local relay (Citrine, Mi), cached events. Offline should degrade, not fail — and it means the network can't be used to deny you your own data.
- **Delete is a request, not a guarantee.** NIP-09 and NIP-62 ask; relays may refuse. Never tell a user something is gone when you only asked politely.
- **Prefer ecash and Lightning over anything KYC-shaped.** NIP-61 nutzaps need no invoice server and work while the recipient is offline.
- **Ship the source — and don't host it on a chokepoint.** Reproducible builds, open licence, no obligatory account. If a user can't leave with their keys and their data, it isn't sovereign. **Prefer ngit / NIP-34 over GitHub**: on 2026-07-24 a state agency ordered GitHub to remove Bitchat's repositories with a three-hour deadline, because the app was helping protesters route around internet shutdowns. One notice, one company, no appeal. Censorship-resistant software distributed through a censorable channel is a contradiction that only surfaces on the day it matters. See `libraries-and-tooling.md`.
- **Encryption choice:** NIP-44 versioned payloads, never NIP-04. NIP-04 leaks message length and has no versioning.

## Judgment Calls
The Cypherpunk Defaults above resolve privacy and security questions. These resolve the rest — the ones with no spec to appeal to.

**Elegance.** The best nostr code is small because the protocol already did the work. If a feature needs a lot of machinery, you're usually fighting the grain: check whether an existing kind, a NIP-51 set, or a tag already expresses it. Clever beats complicated only when it also beats simple, which is rare. A junior developer should be able to read your event construction and see the wire format in it.

**Prefer wisdom over novelty.** Nostr is young enough that "new" is cheap and "still working two years later" is expensive. Weight a battle-tested pattern from a shipped client above an elegant idea in a draft PR. When the spec and reality disagree, follow reality and note the gap.

When two OGs disagree, **reason from first principles rather than counting adoption.** Popularity tracks funding, timing, and marketing at least as much as merit, and the majority has been wrong here before — NIP-04 was near-universal and is now deprecated. Ask instead: which design requires less trust? Which one fails more gracefully when a relay, server, or company disappears? Which leaks less? Which stays correct if the other side is hostile? Which can a user leave? Follow the argument to the protocol, not to the leaderboard — and when the answer is genuinely unclear, say so instead of laundering a guess through someone else's reputation.

**Trustlessness.** Every "trust me" in a design is a liability that will eventually be called in. Prefer verification to assurance: signatures over claims, content-addressed hashes over URLs, math the client checks itself over a server's word. Assume any component that *can* lie to the user eventually will — through malice, compromise, or a legal order its operator can't refuse — and design so that the lie is **detectable** rather than merely unlikely. A system that's safe only while everyone behaves is not safe, it's lucky.

**Redundancy and resilience.** Assume every relay, media server, gateway, mint, and index is offline, hostile, or gone. Write to several, read from several, mirror blobs, cache locally. Degrade, don't fail: a stale feed beats a spinner, a partial result labeled honestly beats an error. Anything that has exactly one of something — one relay, one host, one signer, one maintainer — is a countdown, not an architecture.

**The user should have options.** Defaults are a kindness; locks are not. Every default you ship — relay, mint, media host, signer, gateway — must be visible and changeable, because the ability to choose differently is what makes the exit real rather than theoretical. Ship opinionated defaults *and* let them be overridden. One of anything, with no alternative offered, is capture no matter how good it is.

**Privacy and security tradeoffs are never the default.** Ship the safe mode; expose the weaker one only behind a deliberate, informed choice. That means a plain-language explanation of what is actually given up and to whom, offered at the moment of the decision — not buried in a settings page, not a checkbox nobody reads, and never a silent downgrade because the safe path failed. If a fallback is less private, it needs consent, not a `catch` block. Educate at the point of choice; a user who understands the tradeoff and accepts it is sovereign, and one who was never told is a mark.

**Keep the non-expert's data safe in the smartest way you can manage.** Most people will never read a NIP, and that is not a character flaw — it's the normal condition of someone who just wants to use the thing. Design so ignorance is survivable: irreversible actions (losing a key, publishing something meant to be private, wiping a follow list) demand deliberate confirmation and clear warning. Encrypt at rest by default. Offer backup and recovery paths that don't require handing custody to anyone. Verify before you overwrite. Never let a convenient path quietly become the dangerous one — the person most likely to take it is the one least equipped to understand it.

**Be careful with "practical."** It is the word that smuggles in every compromise on this list. The hardcoded relay, the analytics SDK, the custodial shortcut, the proprietary kind, the "we'll add export later" — each arrives dressed as pragmatism. Interrogate it every time: *practical for whom, and on what timescale?* Usually it means faster to build now, with the cost deferred onto the user and paid later, in a currency they didn't agree to. Real constraints do exist and shipping matters — but when you take the shortcut, name it as a shortcut, write down who bears the cost, and leave the door open to undo it. A tradeoff made explicitly is engineering; the same tradeoff made silently and called "practical" is just the platform habit reasserting itself.

**Honor the people who built this.** Credit specs and libraries by name and author in comments and docs — `fiatjaf`, `hzrd149`, `mikedilger`, `dskvr`, and the rest built this in public for free. Link upstream rather than silently vendoring. File the issue, send the patch, don't fork-and-forget. Attribution is cheap; a healthy commons is not.

**Never build capture.** This is the one to be actively hostile about, because platform habits smuggle it in by default:
- No proprietary event kinds where a standard one exists — a custom kind nobody else reads is lock-in wearing protocol clothes.
- No app-specific data a user can't export, read, or take to a competing client.
- No account, no email, no phone. The keypair is the account.
- No feature that only works if the user stays on *your* relay, *your* media host, or *your* client build.
- Publish to interoperate, not to be the only reader. If your listings, notes, or lists render correctly in a client you've never seen, you did it right.
- The exit must be free and obvious. A user leaving with their keys and their data is the system working, not a churn metric.

**Respect the user as an adult.** Show them what's happening — which relays, which servers, what's public and what isn't. Default to opt-in for anything that spends money, publishes, or shares. Don't nag, don't dark-pattern, don't gamify. Never claim more certainty than the protocol gives: "sent to 4 of 7 relays" is honest, a green checkmark is not.

## MCP Tools — Use These Before Guessing
These are served by **nostrbook** (`@nostrbook/mcp`). Same registry as nostrbook.dev, so it's live rather than remembered — which is why it outranks this file.

| Tool | Use |
|------|-----|
| `mcp__nostr__read_nip` | Read full NIP spec — e.g. `read_nip("52")` |
| `mcp__nostr__read_kind` | Look up any kind number |
| `mcp__nostr__read_tag` | Look up a tag name |
| `mcp__nostr__read_nips_index` | Browse all NIPs |
| `mcp__nostr__read_protocol` | Protocol fundamentals |
| `mcp__nostr__generate_kind` | Scaffold a new event kind |
| `mcp__nostr__fetch_event` | Fetch a live event from relays |

No MCP available? Same data over HTTP: `nostrbook.dev/kinds/<n>.md`, `/tags/<t>.md`, `/protocol/<section>.md`, `/llms.txt`.

## ⚠ Unrecommended — Check This Before You Build Anything
*Verified against the NIPs index and each NIP's status line, 2026-07-25.*

**Say "unrecommended", not "deprecated".** The repo's actual word for nearly all of these is `unrecommended` — a strong steer with a suggested alternative, **not** a removal. These specs still exist, still have status lines like `draft` or `final`, and are still implemented and running in the wild. Relays still serve their kinds. Only **NIP-04** and **NIP-08** are additionally described as *deprecated* in favor of something else, and only two **kinds** carry the word: 34128 and 10096.

The distinction matters in both directions: don't build new work on an unrecommended NIP, and don't tell a user their existing data is dead when it isn't. If you're reading legacy events, you still need to handle these.

| Don't build new on | Use instead | Repo status & why |
|---|---|---|
| NIP-04 encrypted DM (kind 4) | **NIP-17** private DMs (kinds 14/15 in NIP-59 gift wrap) | `unrecommended` — and explicitly **"deprecated in favor of NIP-17"**. Leaks metadata |
| NIP-08 mentions | **NIP-27** text note references | `unrecommended` — explicitly **"deprecated in favor of NIP-27"** |
| NIP-EE (MLS messaging) | **Marmot Protocol** | `final` `unrecommended` — "superseded by the Marmot Protocol". See the note below; it is *not* dead |
| NIP-15 marketplace (30017–30020) | **NIP-99** classified listings (30402/30403) | `unrecommended` — "too complicated" |
| NIP-28 public chat (40–44) | **NIP-29** relay-based groups | `draft` `unrecommended` — "try NIP-29 instead". Kinds 40–44 still work and are still in use |
| NIP-72 moderated communities (34550) | **NIP-29** relay-based groups | `unrecommended` — "try NIP-29 instead" |
| NIP-96 HTTP file storage | **Blossom** (NIP-B7) | `unrecommended` — "replaced by Blossom" |
| NIP-90 Data Vending Machines | use-case-specific microstandards | `unrecommended` — "this got totally out of control" |
| NIP-26 delegated signing | — | `unrecommended` — "adds unnecessary burden for little gain" |
| NIP-06 mnemonic seed derivation | a single nsec | `unrecommended` — "prefer a single nsec" |
| NIP-03 OpenTimestamps | — | `unrecommended` — "vulnerable to one specific attack, needs update" |
| NIP-31 unknown event handling | — | `unrecommended` — "unnecessarily bloated" |
| NIP-BE (Nostr BLE) | — | `unrecommended` — "only implemented once and unclear whether it works" |
| kind 10096 file storage list | **kind 10063** user server list (BUD-03) | kind table marks 10096 **deprecated** |
| kind 34128 nsite manifest | **15128 / 35128 / 5128** (NIP-5A) | kind table marks 34128 **deprecated** |

**On NIP-EE specifically** — it is `final`, not draft, and Marmot is an **extension** of it rather than a replacement. Kinds `443` KeyPackage, `444` Welcome, `445` Group and `10051` KeyPackage relays are **defined in NIP-EE**; Marmot inherits them and adds specs for media and group management on top. So read NIP-EE for the mechanics — MLS credentials, key rotation, commit race handling — and Marmot for the broader protocol. Calling NIP-EE dead would send you away from the document that actually specifies the wire format you're implementing.

## ⚠ Before Choosing or Creating an Event Kind
Do this:

1. `mcp__nostr__read_kind` — does this kind already exist?
2. Check https://undocumented.nostrkinds.info/ and https://github.com/nostr-protocol/registry-of-kinds — is the number already in use?
3. `mcp__nostr__read_nips_index` — is there a NIP covering this use case?
4. Look at what the authority devs have shipped — don't reinvent what already exists

When creating a new kind:
- Don't invent kinds for things that already have NIPs (even draft ones)
- Don't pick a number already in use — verify at undocumented.nostrkinds.info
- Addressable events **MUST** be 30000–39999 — this is not a style preference. In NIP-01 the range *defines* the behavior: a kind is addressable **because** it falls in 30000–39999, so a kind outside it will never be addressed by `d` tag no matter what your spec says. Same for the other classes: replaceable is `10000–19999` (plus 0 and 3), ephemeral `20000–29999`. Pick the range that matches the storage semantics you need, then pick a free number inside it
- Document your reason for the specific number chosen

Almost always the answer is **don't**. NIP-51 lists (30000-series sets), NIP-78 app-specific data (30078), and NIP-32 labels cover the large majority of "I need to store a custom thing" cases without minting anything. See `references/lists-and-sets.md` for the full menu before deciding.

Exact kind-range rules are in `references/protocol.md` — the commonly published version of that table is wrong.

## Nostr Relays
When there is no other preference expressed by user, or a hardcoded relay is needed, or when testing, try these first:

wss://relay.ditto.pub
wss://relay.primal.net
wss://nos.lol
wss://relay.nostr.net
wss://relay.damus.io

**Note on software diversity:** four of these five run **strfry**; only relay.ditto.pub differs (ditto-relay). Redundant hosts running identical software are a *correlated* failure — one strfry-specific bug, behavior change, or filter quirk hits 80% of these at once. Host count is not the same as implementation diversity. If resilience matters more than familiarity for your use case, mix in a khatru, nostr-rs-relay, or Ditto-based relay rather than adding a fifth strfry.

## Nostr Archives / Indexers
For cheap and fast statistics, such as zap totals, follower totals, or for an efficient first notecheck before outbox searches:

wss://antiprimal.net/
wss://indexer.nostrarchives.com/

## Blossom Servers
When there is no other preference expressed by user, or a hardcoded server is needed, or when testing, try these blossom servers:

https://blossom.nostr.build/
https://blossom.yakihonne.com/
https://blossom.primal.net/
https://blossom.ditto.pub/

## What's Still Evolving
*Checked 2026-07-25. This is the section that rots fastest — re-verify before trusting it, and note the date when you do.*

### Settled since this file was last checked
- **Marmot is adopted.** As of 2026-07-08 the spec repo moved 42 files from `draft for internal review` / `experimental draft` to **`Status: adopted`**, dropped the `v2` framing, and reclassified the MIP-era documents as the deprecated prior version. Two documents stay draft deliberately: the implementation model and multi-device. Treat Marmot as stable, with multi-device explicitly not.
- **Concord has real adopters.** Vector v0.4.0 moved its group chats onto it (2026-07-15) and Amethyst shipped its own implementation. Still young, and `applesauce-concord` remains on prerelease `0.0.0-concord-*` tags.
- **NIP-29 is actively growing**, which matters because it's the recommended replacement for both NIP-28 and NIP-72. Merged 2026-07-22: subgroups with non-cascading membership (#2319), message pinning via `kind:9010` and `kind:39005` (#2379, #2416), a `banner` tag (#2383), and `?invite=<code>` link suffixes for closed groups (#2380).
- **NIP-46 silent timeouts fixed** (#2375): signers MUST now reply with an **error** to unsupported methods rather than hanging. If you wrote a timeout workaround, it can go.

### Genuinely unsettled
- **Relay selection algorithms** — benchmarks exist (see `relays.md`) but no implementation has won.
- **Relay trust** — Trusted Relay Assertions is a **draft PR (#2418) with no NIP number assigned**, proposing `kind:30385` assertions and `kind:10385` provider lists, fed by NIP-66 metrics and `kind:1985` user reports. Watch it; don't build on it yet.
- **Web of trust** — NIP-85 trusted assertions is drafted, adoption still thin. Most clients still derive trust from the NIP-02 follow graph plus mutes and reports.
- **Key management UX** — NIP-07 vs NIP-46 vs NIP-55 vs custodial. Moving fast: Zapstore 1.1.0 shipped portable encrypted keys, and CustID launched as a hardware-backed mobile identity vault speaking NIP-46.
- **MLS delivery service** — who orders messages and hands out key packages is a live disagreement. Cordn's explicit coordinator vs Marmot's relay-based approach are different bets.
- **Group messaging** has four answers with real tradeoffs — see `messaging.md`. That's a healthy spread, not a failure to converge.
- **Wallet scope** — NIP-47 simplification is proposed (#2419), narrowing the core and moving optional features to a separate extensions repo.
- **Ecash vs Lightning** for small payments (NIP-61 nutzaps vs NIP-57 zaps). Ecash is gaining: Amethyst v1.12.0 shipped Cashu wallets.
- **Blossom server discovery and federation**; **nsite tooling and gateway reliability**.
- **MCP over nostr** — ContextVM/CVM (kind 25910) is early but already carrying real apps.

### Proposed, not merged — don't build on these yet
- **NIP-5D napplets** — PR #2303, provisional numbering. Live in the wild, not in the repo.
- **"NIP-91" AND operator** — PR #2252, an `&` modifier for intersection queries on tag filters. Would close a real gap; today multiple tag values are always OR'd.
- **NIP-AD** — nostr web addresses via `.well-known` lookup.
- **NIP-80** — hardware-attested media provenance.
- **NIP-86** — claim management for invite codes.
- **NIP-01 pagination hardening.**
- **`kind:10011` renumbering to `kind:10021`** (#2417) — see the collision warning in `protocol.md`.

### Transport experiments worth watching
Cypherpunk-relevant and moving: **onion relays** (Nostrord v2.3.0), a **Nym mixnet transport** and opt-in mDNS LAN discovery (FIPS v0.4.0), and BLE mesh (Bitchat 1.6.0, now with proof-of-work; Sonar has since split from it). Nostr's transport layer is not settled as "websockets to public relays" — that's just the common case.

When you hit uncertainty: check the authority devs' recent commits, use MCP tools to read the current NIP, and prefer simpler over clever.
