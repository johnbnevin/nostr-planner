# Lists and Sets (NIP-51)

*Verified 2026-07-25 against NIP-51.*

**Read this before inventing a kind.** NIP-51 plus NIP-78 app data covers most of what people reach for a custom kind to do. Using a standard list means every other client can already read, render, and respect your data — which is the "publish to interoperate" principle in its most concrete form.

## Two shapes

| | **Standard lists** | **Sets** |
|---|---|---|
| Event class | Replaceable (`10000`–`19999`) | Addressable (`30000`–`39999`) |
| How many | **One per user per kind** | **Many**, each with a distinct `d` tag |
| Extra tags | — | Optional `title`, `image`, `description` for UI |
| Example | "my mute list" | "my Yaks curation", "my dev relays" |

If the user should have exactly one, it's a standard list. If they should be able to have several named ones, it's a set.

## Public and private items in the same event

This is the part people miss, and it matters for privacy.

- **Public items** go in the event `tags` array as normal.
- **Private items** go in `.content`: take a JSON array shaped exactly like `tags`, stringify it, and **NIP-44 encrypt it to yourself** — the conversation key is computed from the author's own public and private key.

```
private_items = [["p","<pubkey>"], ["a","<addr>"]]
event.content = nip44.encrypt(JSON.stringify(private_items))
```

- An earlier version used NIP-04. **That's deprecated.** For backward compatibility, detect which by looking for `"iv"` in the ciphertext and decrypting accordingly — NIP-04 payloads contain it, NIP-44 payloads don't.
- **Append new items to the end** of the list so order stays chronological.

A mute list that leaks who you muted is a safety failure; put those entries in the encrypted half. Same for bookmarks that reveal reading habits. Default to private for anything that describes the user's *avoidance* or *attention* rather than their public affiliation.

## Standard lists

| Name | Kind | Holds |
|---|---|---|
| Follow list | `3` | `p` pubkeys (relay hint + petname optional) — NIP-02 |
| **Mute list** | `10000` | `p` pubkeys, `t` hashtags, `word` (lowercase), `e` threads |
| Pinned notes | `10001` | `e` kind:1 notes |
| Read/write relays | `10002` | NIP-65 |
| Bookmarks | `10003` | `e` notes, `a` articles |
| Communities | `10004` | `a` kind:34550 |
| Public chats | `10005` | `e` kind:40 |
| **Blocked relays** | `10006` | `relay` URLs — clients should **never** connect to these |
| Search relays | `10007` | `relay` URLs |
| Profile badges | `10008` | `a`/`e` badge refs |
| Simple groups | `10009` | `group` (NIP-29 id + relay + name), `r` |
| Favorite follow sets | `10011` | `a` kind:30000 — **contested number, see below** |
| Relay feeds | `10012` | `relay` URLs, `a` kind:30002 |
| Private relays | `10013` | `relay` (NIP-44 encrypted) — NIP-37 drafts |
| Interests | `10015` | `t` hashtags, `a` kind:30015 |
| Git authors | `10017` | `p` pubkeys (NIP-34) |
| Git repositories | `10018` | `a` kind:30617 |
| Media follows | `10020` | `p` pubkeys |
| Emojis | `10030` | `emoji`, `a` kind:30030 |
| **DM relays** | `10050` | `relay` — NIP-17. Not the same as 10002 |
| **Blossom servers** | `10063` | `server` — NIP-B7 |
| Favorite podcasts | `10054` | `p`, `url` |
| Authored podcasts | `10064` | `p` |
| Good wiki authors | `10101` | `p` pubkeys |
| Good wiki relays | `10102` | `relay` URLs |

## Sets

| Name | Kind | Holds |
|---|---|---|
| Follow sets | `30000` | `p` pubkeys |
| Relay sets | `30002` | `relay` URLs |
| Bookmark sets | `30003` | `e` notes, `a` articles |
| Curation sets — articles/notes | `30004` | `a` kind:30023, `e` kind:1 |
| Curation sets — video | `30005` | `e` kind:21 |
| Curation sets — pictures | `30006` | `e` kind:20 |
| **Kind mute sets** | `30007` | `p` pubkeys — **`d` tag MUST be the kind string** |
| Badge sets | `30008` | `a`/`e` |
| Interest sets | `30015` | `t` hashtags |
| Emoji sets | `30030` | `emoji` |
| Release artifact sets | `30063` | `e` kind:1063 files, `a` software app |
| App curation sets | `30267` | `a` software apps |
| Calendar | `31924` | `a` calendar events |
| Starter packs | `39089` | `p` pubkeys |
| Media starter packs | `39092` | `p` pubkeys |

## Deprecated forms — migrate

| Old | Now use |
|---|---|
| `30000` with `d:"mute"` | `10000` mute list |
| `30001` with `d:"pin"` | `10001` pinned notes |
| `30001` with `d:"bookmark"` | `10003` bookmarks |
| `30001` with `d:"communities"` | `10004` communities |

## `kind:10011` is contested

`10011` is listed here as *favorite follow sets*, **and** the kind table assigns `10011` to *External Identities* (NIP-39). A renumbering of the NIP-51 use to `10021` is open in PR #2417. Until it resolves: read defensively (match on kind **plus** expected tag shape), and don't write `10011` for follow sets in new code. See the collision guidance in `protocol.md`.

## Using lists instead of new kinds

Before minting anything, check whether the thing you want is:

- a **grouping of events** → curation set `30004`/`30005`/`30006`
- a **grouping of people** → follow set `30000`, or starter pack `39089` to share
- a **grouping of relays** → relay set `30002`
- **saved items** → bookmarks `10003` / bookmark sets `30003`
- **things to hide** → mute list `10000`, kind mute sets `30007`
- **opaque app config** → NIP-78 app data `30078`
- **a shop or catalog** → curation set `30004` over NIP-99 listings (see `commerce-and-content.md`)

A custom kind nobody else reads is lock-in wearing protocol clothes. A curation set is legible to every client in the ecosystem on day one.

## Client obligations

- **Honor `10006` blocked relays.** It is an explicit user "no". Connecting anyway — even for a "helpful" fallback — overrides a stated decision.
- **Honor `10000` mute list everywhere**, not just the main feed: notifications, search results, thread replies, reactions, zap lists. A mute that only works in one view isn't a mute.
- Support `word` and `t` mutes, not just pubkey mutes.
- **Preserve items you don't understand.** When rewriting a list, carry unknown tags through unchanged — clobbering another client's entries is data loss, and the user won't know it was you.
- **Don't silently add yourself.** Injecting your relay into `10002`, or your server into `10063`, is capture.
- Read the encrypted half before rewriting, or you will destroy the user's private entries.
