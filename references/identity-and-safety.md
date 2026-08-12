# Identity, Display, Safety, and Deletion

*Verified 2026-07-25 against NIP-19, NIP-09, NIP-36, NIP-51.*

This is the file for everything between the protocol and the person: how identity is shown, how users protect themselves from each other, what happens when someone wants something gone, and how not to destroy a beginner's account.

## NIP-19 — bech32 Entities

**These are for display and input only.** The spec is explicit: bech32 forms are *not* meant to be used anywhere in the core protocol. Store and transmit **hex** internally.

| Prefix | Contains |
|---|---|
| `npub` | public key |
| `nsec` | **private key** |
| `note` | event id |
| `nprofile` | pubkey + optional relay hints (TLV) |
| `nevent` | event id + optional relays, author, kind (TLV) |
| `naddr` | addressable coordinate: `d` identifier + author + kind + relays (TLV) |
| `nrelay` | deprecated |

TLV types: `0` special (the pubkey / id / `d`-identifier), `1` relay (**may repeat**), `2` author, `3` kind (32-bit big-endian).

Rules that bite:
- **`npub` MUST NOT appear in NIP-01 events or in NIP-05 JSON responses.** Hex only. This is a common bug that makes your events unreadable to conformant clients.
- **Ignore unrecognized TLV types** rather than erroring — forward compatibility depends on it.
- Accept **both** hex and bech32 on input; normalize to hex immediately.
- Limit bech32 strings to 5000 characters.
- For `naddr` on a *normal* replaceable event, the identifier is an **empty string**.

**Prefer `nprofile`/`nevent`/`naddr` over bare `npub`/`note` when sharing.** The bare forms carry no relay hint, so the recipient's client may simply fail to find the thing. Embedding hints is the difference between a link that works for a stranger and one that only works for you.

**Never render an `nsec` anywhere.** Not in logs, not in error messages, not in a "copy your key" field that stays on screen. If your UI must show one during backup, treat it like a seed phrase: deliberate reveal, warning, no clipboard persistence, no screenshot-friendly layout.

## NIP-21 — `nostr:` URIs

`nostr:npub1…`, `nostr:nevent1…`, etc. Use these in `.content` for mentions and citations, paired with a `p` or `q` tag (see tag discipline in `protocol.md`). The tag is what makes it machine-readable and routable; the URI is what makes it renderable.

## Displaying People

The user-facing rule from the router — *show avatars and human-readable names, not npubs* — has protocol substance behind it:

- Resolve kind 0 metadata and show `display_name` / `name`, falling back to a **deterministic generated name** rather than a truncated key. `npub1x7f…3k2q` is not an identity, it's a failure to look one up.
- Offer copy-to-clipboard for the full `npub` where a user genuinely needs it. Truncated keys are useless for verification *and* unreadable — the worst of both.
- **Petnames**: NIP-02 follow lists carry an optional petname per `p` tag. A user's own name for someone outranks that person's self-assigned one.
- **Impersonation is the failure mode.** Two accounts can share a display name and picture. Show something distinguishing near the name — NIP-05 verification, a follow-graph signal, or "you don't follow this account" — anywhere a name alone could mislead. This matters most exactly where it's easiest to skip: DM lists, zap confirmations, and mentions.

## NIP-05 — DNS Identifiers

`name@domain.com` maps to a pubkey via `https://domain.com/.well-known/nostr.json?name=<name>`. Responses use **hex**, never `npub`.

Treat it as a **nicety, not an identity**:
- The pubkey is the identity. NIP-05 is a convenience mapping that a domain owner can change, lose, or have taken.
- Verify it, cache it, and **re-verify periodically** — a stale green check is worse than none.
- **Never make login or core function depend on it.** An app that breaks when a domain lapses has smuggled a certificate authority into a keypair protocol.
- Show *what* it means. "Verified" implies an authority that doesn't exist here; "controls example.com" is honest.

## Safety and Moderation

Nostr has no central moderator, which means client-side tools are the entire user-facing safety story. Shipping without them isn't neutrality — it's leaving users undefended.

**Mute list — kind `10000`** (see `lists-and-sets.md`). Supports `p` pubkeys, `t` hashtags, `word` (lowercase substrings), and `e` threads. Put entries in the **encrypted** half by default: a public list of who you're avoiding is itself a harm. Apply mutes **everywhere** — feed, notifications, search, thread replies, reactions, zaps. A mute honored in one view is not a mute.

**Kind mute sets — `30007`**, where the `d` tag MUST be the kind number as a string. Lets a user mute someone's long-form posts while keeping their notes.

**NIP-36 content warnings.** A `["content-warning", "<optional reason>"]` tag means: hide until the reader opts in. Honor it on render, and offer it on compose. It may be qualified with NIP-32 `L`/`l` label tags under the `content-warning` namespace or another ontology.

**NIP-32 labels — kind `1985`.** Namespaced labelling (`L` namespace, `l` value) for content classification by anyone, not just the author. This is how decentralized moderation composes: users subscribe to labellers they trust rather than a platform's single ruleset.

**NIP-56 reports — kind `1984`.** Report events or pubkeys with a type. Reports are a signal to *other users and relays*, not a complaint to an authority — there isn't one. Be honest in the UI about what reporting does and doesn't accomplish.

**Blocked relays — kind `10006`.** An explicit "never connect here." Honor it even in fallback paths.

Design notes:
- **Filtering is the user's, not yours.** Ship defaults, expose them, let them be changed. A hidden, unconfigurable filter is editorial control wearing a safety label.
- **Don't leak the moderation graph.** Who someone mutes, reports, or blocks is sensitive.
- Reactions, zaps, and mentions are all abuse vectors. Rate-limit and filter notifications by the same rules as the feed.
- Optimistic rendering plus muting is a trap: apply mutes *before* first paint, or the user sees exactly what they asked not to see.

## Deletion — NIP-09, and What You Must Not Promise

Kind `5` deletion request: `e` and/or `a` tags for targets, a `k` tag per kind, optional reason in `.content`.

**The security-critical rule:** a client **MUST validate that the `pubkey` of each referenced event matches the `pubkey` of the deletion request** before hiding anything. Relays generally cannot perform this check and **are not authoritative**. Skip it and anyone can delete anyone's events from your UI — a trivially exploitable censorship bug.

Other facts worth internalizing:
- Relays SHOULD keep serving **deletion requests** indefinitely, since clients may already hold the target. Clients SHOULD **rebroadcast** deletion requests to relays that lack them.
- With an `a` tag, all versions of the addressable event up to the request's `created_at` are covered.
- A deletion request against a deletion request **does nothing**. There is no undo.
- Clients MAY fully hide the target, or show it marked as disowned. If you display the reason, label it clearly as a reason — not as the original content.

**Tell the truth in the UI.** NIP-09 explicitly says clients MAY inform the user that deletion is not guaranteed. Do it. "Delete" that means "asked politely, results vary" must say so. Never render a confirmation implying the data is gone from the network — it isn't, and a user who acts on that belief can be seriously harmed.

**NIP-62 request to vanish (kind `62`)** asks a relay to remove everything for a pubkey. Same honesty applies, at larger scale.

**NIP-40 `expiration`** is likewise a request, not a guarantee — some relays honor it, some don't. **NIP-70** `-` marks an event as publishable only by its author.

## Onboarding and Keeping Beginners Safe

The highest-stakes moment in any nostr app is the thirty seconds where a new user acquires a key they don't yet understand. Most permanent losses originate here.

- **Generate with a CSPRNG.** Platform randomness — `crypto.getRandomValues`, `react-native-get-random-values`, the OS on native. Never `Math.random()`, never a homegrown PRNG. On React Native, **verify signing against a known-good test vector on device**; a silently broken randomness polyfill produces plausible keys and unrecoverable accounts.
- **Prefer a signer to holding a key at all** — NIP-07 on web, NIP-55 on Android, NIP-46 elsewhere. The best key handling is none.
- **If you must hold one, encrypt it** — NIP-49 `ncryptsec`, OS keychain on native, never plaintext in localStorage or AsyncStorage.
- **Force backup before the account has value**, while losing it is cheap. Explain in plain words: there is no reset, no support desk, nobody who can recover it.
- **Make the destructive path harder than the safe one.** Logging out with an unbacked-up key should require deliberate confirmation. So should clearing storage or importing over an existing key.
- **Re-verify before overwriting anything cumulative.** Follow lists (kind 3) and other replaceable events are trivially destroyed by publishing a partial version from a stale read: fetch, confirm you have a complete current copy, *then* merge and publish. Publishing a follow list of 4 over one of 400 is a permanent, silent loss.
- **Warn on irreversible publication.** Anything public is public forever somewhere. Say that before the first post, not after.
- **Never dark-pattern the safe option.** No "skip backup" styled as the primary button.
- **Assume the user will not read a NIP.** That is the normal condition of someone who just wants to use the thing. Design so ignorance is survivable rather than punishing.
