# Sources, and Other Agent Skills

*Surveyed and fact-checked 2026-07-25.*

## Other Agent Skills — What's Out There, and Where It's Wrong

Read these for ideas; don't inherit their errors.

| Source | Last touched | Verdict |
|---|---|---|
| **Soapbox `nostr-skills`** — gitlab.com/soapbox-pub/nostr-skills (`nak` + `nostr`) | Jan 26 2026, Alex Gleason | **Sound, by design.** Embeds almost no protocol knowledge — it tells the agent to fetch the NIPs README and read the live spec. Nothing to go stale. CC-BY-SA-4.0 |
| **purrgrammer `grimoire`** — `.claude/skills/nostr` | **Archived Apr 23 2026 — read-only** | Excellent nostr-tools reference, but frozen. Two concrete errors below |
| **MKStack `AGENTS.md`** (ships in generated projects) | varies per scaffold | Useful project map; kind-range table incomplete; ships presenting NIP-04 DMs as a live option |
| **Welshman skills** — `npx skills add coracle-social/welshman` | Jun 2026, hodlbod | **The best-designed set in the ecosystem.** Eleven skills, one per package (`welshman-router`, `welshman-net`, `welshman-signer`…), each with a `description` written for auto-activation, plus manual `/welshman-*` invocation. Library-scoped rather than protocol-scoped, so it doesn't go stale the way protocol claims do. Install if you use Welshman; read it for the structure either way |
| **Nostrbook** — nostrbook.dev | live registry | **Best agent-native source.** MCP server (`@nostrbook/mcp`) plus `.md` endpoints: `/kinds/1.md`, `/tags/e.md`, `/protocol/event.md`, `/kinds/index.md`, `/llms.txt` |
| **NIPs repo README** | continuous | The actual ground truth. Kind table + deprecation markers |

### Verified errors found in the wild — do not copy

- *"`ids` and `authors` support prefix matching."* **False.** NIP-01 requires exact 64-char lowercase hex. Prefix matching was removed.
- *"Parameterized replaceable."* Renamed to **addressable**.
- *Kind-range tables omitting `4 <= n < 45`, `n == 1`, `n == 2` from regular.* Nearly universal, and it's why people wrongly conclude kinds 4–44 aren't stored.
- *NIP-04 presented as a current option.* Deprecated in favor of NIP-17.
- *nsite manifests as kind 34128.* Superseded by NIP-5A (15128 / 35128 / 5128).
- *NIP-96 for file storage.* Replaced by Blossom (NIP-B7).
- *Calling every unrecommended NIP "deprecated."* An error this file made until corrected. The repo's word is `unrecommended` — a steer, not a removal. Only NIP-04 and NIP-08 are additionally called deprecated, and only kinds 34128 and 10096. NIP-28 is still `draft` and NIP-EE is still `final`; their kinds still work and are still in use. Precision here is not pedantry: it decides whether you tell a user their data is dead.

### The lesson worth stealing from Gleason

An agent file that *embeds* protocol detail decays; one that *points at live sources* doesn't. This skill embeds a lot on purpose — so treat the MCP tools and nostrbook as authoritative whenever they contradict a **fact** written here, and **fix the file** when they do.

**Facts only.** That deference does not extend to the Cypherpunk Defaults or the Judgment Calls in the router. A spec describes what the protocol does; it has no standing on what to value. Before "fixing" anything that touches a principle, reflects OG disagreement the spec doesn't settle, involves discretion (a default, a tradeoff, a recommendation), or deletes a stance — **ask the user**. Silently bending a value toward the newest source is decay too, just harder to spot than staleness.

## Link Index

**Protocol**
- NIPs: https://nips.nostr.com
- NIPs repo: https://github.com/nostr-protocol/nips
- Machine-readable kind registry (canonical): https://github.com/nostr-protocol/registry-of-kinds
- Kind registry (community): https://undocumented.nostrkinds.info/
- Nostrbook agent endpoints: https://nostrbook.dev/llms.txt · `/kinds/<n>.md` · `/tags/<t>.md` · `/protocol/<section>.md` · MCP at `/mcp`
- Soapbox nostr skills (CC-BY-SA-4.0): https://gitlab.com/soapbox-pub/nostr-skills

**Relays**
- Outbox model research + benchmarks: https://github.com/nostrability/outbox
- Relay health, live: https://nostr.watch
- Building Nostr (coracle guide): https://building-nostr.coracle.social/

**Git over nostr**
- ngit CLI: https://codeberg.org/DanConwayDev/ngit-cli
- gitworkshop.dev — git collaboration without the platform
- ngit-grasp: https://ngit.danconwaydev.com/
- NIP-34 remote URL format PR: nostr-protocol/nips #1624
- What is ngit (Soapbox): https://soapbox.pub/blog/what-is-ngit

**Libraries & tooling**
- Welshman: https://github.com/coracle-social/welshman · docs https://welshman.coracle.social · skills `npx skills add coracle-social/welshman`
- rust-nostr (Rust + Python/Kotlin/Swift/C#/JS/Flutter bindings): https://rust-nostr.org · https://github.com/rust-nostr/nostr
- rust-nostr native bindings: https://github.com/rust-nostr/nostr-sdk-ffi
- NIP-55 Expo module (Android signer): https://github.com/chebizarro/Nostr-Signer-Expo-Module
- Nostrum (RN/Expo NIP-46 signer, iOS + Android): https://github.com/nostr-connect/nostrum
- Nostr client tools: https://github.com/nbd-wtf/nostr-tools
- Nostrify: https://github.com/soapbox-pub/nostrify · https://nostrify.dev
- Applesauce: https://applesauce.build/
- Soapbox toolbox: https://soapbox.pub/toolbox
- Soapbox docs: https://docs.soapbox.pub
- Ditto resources / Nostr 101 / self-hosting: https://about.ditto.pub
- Core Nostr Functionality Library: https://nostrcompass.org/en/topics/quartz/
- Nostr Compass project directory (check before building): https://nostrcompass.org/en/projects/

**Messaging**
- Marmot Protocol: https://github.com/marmot-protocol/marmot
- Concord protocol (CORD-01..07): https://github.com/concord-protocol/concord
- Cordn: https://cordn.net · https://github.com/Cordn-msg/cordn
- Cordn Ad-hoc CVM: https://github.com/sandwichfarm/cordn-adhoc-cvm
- Armada: https://armada.buzz · Accordion: https://accordion.chat
- ContextVM (MCP over nostr): https://docs.contextvm.org

**Storage & sites**
- Blossom BUDs: https://github.com/hzrd149/blossom
- NSite hosting: https://nsite.run · https://nsite.info
- nsyte: https://nsyte.run · https://github.com/sandwichfarm/nsyte
- nsite-cli (older): https://github.com/flox1an/nsite-cli
- awesome-nsite: https://github.com/nostrver-se/awesome-nsite
- Napplets / NIP-5D: https://napplet.run/

**Commerce**
- Open Markets Foundation: https://openmarkets.pub/
- Open Markets Podcast (Eric FJ & Sync): https://open.spotify.com/show/51w2X3OTLS7WggLKm14gyh
- Conduit: https://conduit.market · https://github.com/Conduit-BTC
- Plebeian Market: https://plebeian.market
- Shopstr: https://shopstr.store
- Gamma Markets NIP-99 e-commerce extension: nostr-protocol/nips PR #1784
