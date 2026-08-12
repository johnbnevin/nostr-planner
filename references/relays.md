# Relay Strategy

*Verified 2026-07-25 against NIP-65, NIP-11, and the @welshman/router docs.*

Read this when feeds look empty, replies are missing, or you're deciding which relays to query. **Relay selection is the single most common cause of "nostr is broken" bugs** — before debugging your query, check where you sent it.

## Kinds of Relay, and What Each Is For

"Relay" covers several quite different things. Using the wrong type is a common design error — a general public relay is not an archive, and an indexer is not somewhere to publish.

| Type | What it does | Use it for |
|---|---|---|
| **General public** | Accepts most kinds from anyone. `nos.lol`, `relay.damus.io` | Bootstrap, discovery, broad reach. Never assume retention |
| **Paid / restricted** | `payment_required` or `restricted_writes`. `nostr.wine`, `nostr.land` | Reliability, retention, less spam. Read NIP-11 `fees` first |
| **Indexer** | Optimized for kind 0 profiles and kind 10002 relay lists | Bootstrapping the outbox model — resolve *who writes where*, then leave |
| **Search** | NIP-50 `search` filter. Ditto Relay (OpenSearch-backed) | Full-text queries. Most relays don't support search at all |
| **Archive / stats** | Deep history, aggregate counts. `antiprimal.net`, `indexer.nostrarchives.com` | Zap totals, follower counts, a cheap first check before an outbox sweep |
| **Personal / local** | Runs on your device. **Citrine** (Android, greenart7c3), **Mi** (in-browser, Soapbox) | Local-first cache, offline reads, a copy of your own data nobody can take |
| **Community / team** | Membership-gated. NIP-29 relays, **swarm** (bitkarrot), Ditto | Groups, moderation, team spaces |
| **DM / inbox** | Listed in kind 10050, not 10002 | NIP-17 gift wraps. Sending DMs anywhere else means they never arrive |
| **Signaling** | Carries NIP-46 bunker traffic | Remote signing. See the privacy note in `libraries-and-tooling.md` |
| **Blast / broadcast** | Fans one event out to many relays | Convenience only. It's a middleman that sees everything you publish |

**Relays do not store files.** Blobs live on **Blossom** servers (kind 10063), never on relays — see `storage-and-sites.md`. What a relay limits is *event* size, via NIP-11 `max_message_length` and `max_content_length`. If you're trying to put an image in an event, the design is wrong: upload to Blossom, reference the hash, add `imeta`.

**Citrine** deserves special mention for the local-first case: a relay running on the user's own phone. Write everything there first, sync outward. The user keeps a complete copy of their own data, the app works offline, and no network participant can deny them their own history. Pair with NIP-77 negentropy to reconcile cheaply. This is the most direct expression of "local-first" the ecosystem currently offers.

## Read NIP-11 Before You Trust a Relay

Fetch `https://<relay>` with `Accept: application/nostr+json`. Relays MUST send CORS headers, so this works from a browser. Cache it; don't refetch per request.

`supported_nips` tells you whether a feature exists at all — search (50), negentropy (77), count (45), auth (42). Don't send a filter the relay can't answer.

The `limitation` object is where the surprises are:

| Field | Why you care |
|---|---|
| `max_message_length` | **Effectively the max event size**, measured `[` to `]` after UTF-8 serialization — so non-ASCII costs 2–3 bytes per character. Also caps how large a subscription you can send |
| `max_limit` | The relay **silently clamps** your filter's `limit` to this. You get a truncated result with no error. If you're near it, narrow the time range and page instead |
| `default_limit` | What you get if you send no `limit` at all — another silent truncation |
| `max_subscriptions` | Per **connection**. Exceed it and subscriptions get dropped |
| `max_event_tags` | Bites on follow lists, curation sets, and nsite manifests, which are all tag-heavy |
| `max_content_length` | Unicode **characters**, separate from the byte limit above |
| `min_pow_difficulty` | Mine NIP-13 PoW or be rejected |
| `auth_required` | NIP-42 before anything else works |
| `payment_required` / `restricted_writes` | You will be rejected until you've met a condition |
| `created_at_lower_limit` / `created_at_upper_limit` | Clock-skew rejections. A device with a wrong clock silently fails to publish |

`max_limit` and `default_limit` are the two that produce *wrong* behavior rather than errors — you think you have all the events and you don't. If completeness matters, check them, and prefer NIP-67's EOSE completeness hint where available.

## How Many Relays

**NIP-65 is explicit: clients SHOULD guide users to keep `kind:10002` small — 2–4 relays of each category.** This is a spec recommendation, not folklore, and it exists because the outbox model makes every follower pay for your list length. A 30-relay list doesn't make you more reachable; it makes everyone who follows you open 30 connections.

Practical numbers:

- **User's own list:** 2–4 write, 2–4 read. Guide them toward this; warn above ~6.
- **Reading a feed:** the union of your follows' write relays, then capped — Welshman's default limit is 3 per scenario, plus fallbacks. Somewhere between 5 and 15 concurrent connections is normal for a social client.
- **Publishing:** author's write relays **plus every tagged user's read relays**. This is the step people skip, and it's why mentions don't arrive.
- **Bootstrap/indexer:** 2–3, used only to resolve profiles and relay lists.

Don't confuse "more relays" with "more resilient". More *independent* relays helps; more connections to the same software and the same operator does not.

## Welshman — Relay Selection as a Library

`@welshman/router` (hodlbod, extracted from Coracle) is the most complete relay-selection implementation in TypeScript, and worth reading even if you don't adopt it — it encodes decisions you'd otherwise make badly.

Configure once as a singleton:

```ts
Router.configure({
  getUserPubkey:   () => currentPubkey,
  getPubkeyRelays: (pubkey, mode) => relaysFor(pubkey, mode),  // "read" | "write" | "messaging"
  getDefaultRelays: () => FALLBACK_RELAYS,
  getIndexerRelays: () => INDEXER_RELAYS,
  getRelayQuality:  (url) => scoreFrom0To1(url),
  getLimit:         () => 3,
})
```

Then ask by **scenario** rather than assembling URLs by hand:

| Scenario | Purpose |
|---|---|
| `FromUser()` / `FromPubkey(pk)` / `FromPubkeys(pks)` | Reading events by those authors |
| `Event(event)` | Relays for an event's author |
| `ForUser()` / `ForPubkey(pk)` | Publishing |
| `PublishEvent(event)` | Author's write relays **+ mentioned users' inbox relays** — the correct publish set, computed for you |
| `MessagesForUser()` / `MessagesForPubkey()` | DM relays (kind 10050) |
| `Quote(event, id, hints)` | Locating a quoted event |
| `Search()` / `Index()` / `Default()` | Task-specific relay classes |

Scenarios are chainable: `.limit(n)`, `.weight(scale)`, `.allowLocal()`, `.allowOnion()`, `.allowInsecure()`, then `.getUrls()`.

Fallback policy is explicit — `addNoFallbacks`, `addMinimalFallbacks` (one relay if empty), `addMaximalFallbacks` (fill to the limit). Choose deliberately: maximal fallbacks get you results, but they route queries to relays the author never chose.

`getFilterSelections(filters)` routes automatically: search filters → search relays, profile/relay-list kinds → indexers, author filters → those authors' relays, with the user's read relays as a low-weight baseline. It returns relay↔filter pairings rather than one filter blasted everywhere.

Note the tradeoff honestly: Welshman is **stateful, heuristic, and non-deterministic** — it uses `Math.random()` for tie-breaks. That's a reasonable choice for a client and a bad one for a test suite. If you need reproducibility, wrap it or use a deterministic policy layer.

Welshman also ships **agent skills** (`npx skills add coracle-social/welshman`) — one per package, including `welshman-router`. If you adopt the library, install those too.

## The Outbox Model

Route queries to the relays each **author** declared in NIP-65, rather than to a fixed set of popular relays.

The 2026 nostrability benchmarks, across 15 clients/libraries in 5 languages:

| Strategy | Event recall |
|---|---|
| Query popular relays only | ~26% |
| Greedy set-cover + Thompson Sampling | 80–90% |
| + latency-aware (hyperbolic discounting, EWMA latency) | 72–96% at the 2s mark |

The naive approach loses roughly **three quarters** of events. That's the difference between "the network is quiet today" and a routing bug.

**Relay hints** in event tags complement kind 10002 — they don't replace it. Try both, and populate the author-pubkey position (see tag discipline in `protocol.md`) so a client can fall back to the author's write relays when a hint is dead.

Research: https://github.com/nostrability/outbox

## Being a Good Citizen

Relays are mostly run by individuals paying out of pocket. Your client's behavior is someone else's hosting bill.

- **One websocket per relay**, multiplexed. Never a connection per subscription.
- **Close subscriptions you're done with.** `CLOSE` is not optional politeness; abandoned subscriptions stream events forever.
- **Always bound `REQ` with `limit`** and a time range. An unbounded query against a large relay is expensive for them and slow for you.
- **Respect `max_subscriptions`.** Queue rather than exceed it.
- **Deduplicate before sending.** Merge overlapping filters into one `REQ` instead of firing several near-identical ones.
- **Don't poll.** Nostr subscriptions are live; a `REQ` loop on a timer is the wrong shape.
- **Cache aggressively.** Profiles and relay lists are replaceable and change rarely — refetching kind 0 on every render is pure waste. Use a local relay or store.
- **Publish deliberately, not everywhere.** Blasting to 50 relays to "be safe" externalizes your cost onto 50 operators. Write relays plus tagged users' inboxes is the correct set.
- **Back off on failure** (below) — retry storms are how a struggling relay becomes a dead one.
- **Read the `terms_of_service`** if you're building something high-volume, and use the `pubkey` contact to ask before hammering.

## Failure Handling, Backoff, and When To Give Up

Parse the machine-readable prefix on `OK` and `CLOSED` (full list in `protocol.md`) and branch on it — this is the difference between a client that recovers and one that hammers.

| Response | Meaning | Action |
|---|---|---|
| `duplicate:` | Already had it | **Success.** Don't retry |
| `rate-limited:` | Too fast | Exponential backoff with jitter |
| `blocked:` / `restricted:` | Not allowed here | **Stop.** Don't retry this relay for this key. Try elsewhere |
| `auth-required:` / NIP-42 challenge | Needs auth | Authenticate once, then retry |
| `pow:` | Needs NIP-13 work | Mine to the stated difficulty or move on |
| `invalid:` | Malformed, or clock skew | **Fix, don't retry.** Retrying identical bad data is pure noise |
| `error:` | Relay-side fault | Retry with backoff; a few attempts, then drop |

Connection-level rules:

- **Exponential backoff with jitter**, starting ~1s, capped around 5 minutes. Jitter matters — synchronized reconnects from many clients are a self-inflicted DDoS.
- **Stop trying** a relay after repeated hard failures in a session and mark it unhealthy. Don't retry a `blocked:` relay at all.
- **Reconnect on network change**, not on a timer.
- **Give up on a query, not the app.** Publishing is a success if *any* relay accepts. Report honestly — "sent to 3 of 5" beats a checkmark that means nothing.
- **Track quality over time** and feed it back into selection (Welshman's `getRelayQuality`). Latency, acceptance rate, and completeness are all signal.
- **Never let one dead relay block the UI.** Render on first response; fill in as others arrive.

## Choosing Relays by App Type

| App | Relay strategy |
|---|---|
| **Social client / feed reader** | Full outbox. Indexers to bootstrap, follows' write relays to read, 2–4 own write relays, user's inbox relays for mentions. 5–15 connections |
| **Single-purpose / niche app** | 2–3 relays that keep your kinds, plus the user's NIP-65 for anything social. Check `restricted_writes` — some relays drop unusual kinds |
| **DM / messaging** | Kind 10050 inbox relays, full stop. Never the general list. Consider a paid relay for retention; Marmot adds kind 10051 for KeyPackages |
| **Groups / communities** | The group's own relay (NIP-29) or the community's. Membership is enforced relay-side |
| **Local-first / offline** | Citrine or Mi as primary, NIP-77 negentropy to sync outward, remote relays as replicas |
| **Marketplace / listings** | Broad-reach general relays plus a paid one for retention — a listing nobody can find isn't a listing. Check `max_event_tags` for rich listings |
| **Long-form publishing** | Paid or self-hosted for retention; addressable events are worth keeping. Blossom for media |
| **Relay-side service / bot** | Your own relay plus strfry router or NIP-77 to mirror. Don't build a service that hammers other people's relays |
| **CLI / scripting** | Explicit relay arguments, no magic. `nak relay <url>` first |

## Managing Relay Lists

- **Read the user's kind 10002 first**, before anything else about them. Cache it; it's replaceable and changes rarely.
- **Publish their 10002 widely.** NIP-65 says to spread it to as many relays as viable, especially well-known indexers — an unreachable relay list makes the user unreachable.
- **When publishing any event, also send the author's kind 10002** to every relay you published to. That's a NIP-65 SHOULD, and it's what keeps the graph resolvable.
- **Never silently rewrite a user's list.** Adding your own relay to it is capture. Suggest, explain, let them decide.
- **Surface it in the UI** — which relays, read or write, reachable or not. Users can't manage what they can't see.
- **Distinguish "no relay list" from "empty relay list."** A user with no kind 10002 needs a sensible bootstrap; one who deliberately cleared it does not.
- **Related lists:** kind 10050 for DMs, 10051 for Marmot KeyPackages, 10006 blocked relays, 10007 search relays, 10012 favorite relays, 30002 relay sets. Honor 10006 especially — it's an explicit user "no".

## Discovery, Sync, and Auth

**NIP-66** (kinds 10166 / 30166) — relay health published *as nostr events* by independent monitors, so you can discover live relays supporting a given NIP without hardcoding a list or trusting one authority. dskvr runs monitoring stations across 6 continents. Prefer this over a static fallback array. Live view: https://nostr.watch

**NIP-77 negentropy** — set reconciliation over arbitrary filters with minimal bandwidth. ~16% of reachable relays support it; strfry is the reference (hoytech's negentropy is where the NIP came from). The right tool for catching up after being offline.

**NIP-67** — EOSE completeness hint. Without it, `EOSE` is ambiguous: you can't distinguish "that's everything" from "that's all I have."

**NIP-45 `COUNT`** — ask for a count instead of pulling events. Cheap for follower totals. Check `supported_nips`.

**NIP-42 `AUTH`** — handle the challenge gracefully rather than failing silently.

**Trusted Relay Assertions** — draft PR #2418, `kind:30385` / `kind:10385`, fed by NIP-66 metrics and kind 1985 reports. No NIP number yet. Watch it; don't build on it.
