# Protocol Reference (NIP-01)

*Verified 2026-07-25 against NIP-01 as served by `mcp__nostr__read_nip("01")`.*

Read this when building or parsing events, choosing a kind, constructing tags or filters, or debugging why a relay rejected something.

## Kind Ranges — Exact Rules

**Most published versions of this table are wrong**, including several agent skill files and MKStack scaffolding. The carve-outs are not optional trivia; they're why kinds 4–44 (DMs, chat, threads, pictures, video, public messages) are stored at all.

| Class | Exact NIP-01 rule | Behavior |
|---|---|---|
| **Regular** | `1000 <= n < 10000` **or** `4 <= n < 45` **or** `n == 1` **or** `n == 2` | all stored by relays |
| **Replaceable** | `10000 <= n < 20000` **or** `n == 0` **or** `n == 3` | latest per pubkey+kind wins |
| **Ephemeral** | `20000 <= n < 30000` | not stored |
| **Addressable** | `30000 <= n < 40000` | latest per pubkey+kind+`d` wins |

Common errors to avoid:
- 11000–19999 is **replaceable**, not regular.
- Kind `3` is **replaceable**; kinds `1` and `2` are **regular**. "Everything under 1000 is legacy" is a guess, not the rule.
- "Parameterized replaceable" is the **retired** name for addressable.
- `kind` is an integer 0–65535.

Ties: for replaceable events with the same `created_at`, keep the **lowest id in lexical order** and discard the rest. Relays answering a `REQ` for replaceable events SHOULD return only the latest.

These are conventions — relay implementations may differ. Don't build correctness on a relay honoring them perfectly.

## Event Structure

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

**Event ID.** `sha256` of the UTF-8 JSON serialization of `[0, pubkey, created_at, kind, tags, content]`. No whitespace, no line breaks. Escape exactly these in `content` and nothing else:

| Character | Escape |
|---|---|
| line break `0x0A` | `\n` |
| double quote `0x22` | `\"` |
| backslash `0x5C` | `\\` |
| carriage return `0x0D` | `\r` |
| tab `0x09` | `\t` |
| backspace `0x08` | `\b` |
| form feed `0x0C` | `\f` |

Get this wrong and your IDs silently differ from everyone else's — events will look valid locally and be rejected everywhere. `sig` is Schnorr (BIP-340, secp256k1) over that 32-byte id.

## Tags

```
["e", "<event-id>", "<relay-url>", "<author-pubkey>"]   — 3rd/4th optional
["p", "<pubkey>", "<relay-url>"]
["a", "<kind>:<pubkey>:<d-tag>", "<relay-url>"]         — addressable
["a", "<kind>:<pubkey>:", "<relay-url>"]                — plain replaceable, KEEP the trailing colon
```

- Only **single-letter** tags (`a-z`, `A-Z`) are indexed by relays.
- **Only the first value in a given tag is indexed.** Stuffing data into position 3+ and expecting to filter on it will not work.
- The first element is the tag *name*, the second the *value*. Elements after the second have no conventional name.

## Tag Discipline — This Is What Makes Your Events Usable By Anyone Else

Tags are the public interface of your event. Content is for humans; **tags are the API**. A client that has never heard of your app decides what your event *is*, where it belongs in a thread, and who to notify, entirely from the tags. Get them wrong and the event still publishes, still validates, still looks fine in your own UI — and is invisible or misfiled everywhere else. This is the single easiest way to accidentally build a walled garden while believing you're publishing to a protocol.

Fill in the optional positions even when you don't need them. They cost nothing and they are what someone else's client needs.

### Threading: two schemes, and you must pick by kind

**Kind 1 replies use NIP-10. Everything else uses NIP-22.** Both specs say this explicitly and in both directions: kind 1 replies MUST NOT reply to other kinds, and kind 1111 comments MUST NOT be used to reply to kind 1 notes. Mixing them is the most common threading bug, and the symptom is a reply that simply doesn't appear under its parent in other clients.

**NIP-10 — kind 1 threads.** Use *marked* `e` tags; positional ones are deprecated.

```
["e", "<event-id>", "<relay-url>", "<marker>", "<pubkey>"]
```
- `<marker>` is `"root"` or `"reply"`. **Those are the only two** — `"mention"` was removed; use a `q` tag to cite instead.
- A direct reply to the root gets **one** `e` tag, marked `"root"`. Not two.
- The 5th position `<pubkey>` is the *referenced event's author*, and it matters more than it looks: outbox-model clients use it to go fetch that event from the author's write relays when the relay hint fails. Omitting it makes your reply un-resolvable for anyone whose relay set differs from yours.
- **`p` tags carry the participants.** A reply must include every `p` tag from the event it replies to, **plus** that event's author. Given a note by `a1` tagging `[p1, p2, p3]`, your reply tags `[a1, p1, p2, p3]`. Drop these and nobody in the thread gets notified.

**NIP-22 — comments on anything else** (kind `1111`, plaintext content, no markdown).
- **UPPERCASE tags point at the root scope; lowercase point at the immediate parent.** `E`/`e`, `A`/`a`, `I`/`i`, `K`/`k`, `P`/`p`.
- **`K` and `k` MUST both be present** — the root kind and the parent kind. This is what lets a client render your comment without fetching the thing it comments on.
- For a top-level comment, root and parent are the same values.
- When the parent is replaceable or addressable, include **both** `a` (the address) and `e` (the specific id).
- `I`/`i` scope comments to things that aren't nostr events at all — URLs, podcast GUIDs, geohashes, ISBNs (NIP-73). `K` then holds a type like `"web"` or `"podcast:item:guid"`. This is how you comment on the open web without inventing anything.

### Referencing rather than replying

- **`q`** — cite an event in `.content` via NIP-21: `["q", "<id-or-address>", "<relay-url>", "<pubkey>"]`. Use this instead of an unmarked `e`.
- **`p`** — mention a pubkey you reference in content, so it reaches their inbox.
- Authors of anything you `e` or `q` **SHOULD** also get a `p` tag. Notification is opt-in by tag, not inferred.

### Always include relay hints

The third position of `e`, `p`, `a`, and `q` is a relay URL. It is optional and you should populate it anyway. Relay hints plus the author pubkey are the two mechanisms that let a stranger's client resolve your reference at all; without them a reader on a different relay set sees a dangling pointer. `""` is acceptable when you genuinely have nothing — a wrong hint is worse than an empty one.

### Other tags worth using correctly

| Tag | Use |
|---|---|
| `d` | Identifier for addressable events. Required, stable, and the thing your event is addressed by |
| `t` | Hashtag, lowercase by convention |
| `imeta` | NIP-92 media metadata, so clients can lay out an image without fetching it first |
| `expiration` | NIP-40 — a request, not a guarantee. Relays may ignore it |
| `-` | NIP-70 protected: only the author may publish it |
| `alt` | Human-readable fallback for unknown kinds. Appears in NIP-01's own example, though its NIP (31) is `unrecommended` — cheap to add, don't rely on clients honoring it |
| `client` | Attribution. Optional, and it publishes what software the user runs — omit it if that's a fingerprinting concern for your users |

### Rules of thumb

- Use a standard tag with its spec'd meaning, or use a new tag name. **Never repurpose an existing tag** — someone's client already trusts what it means.
- Remember only single-letter tags are indexed, and only their first value. Anything you need to filter on must live in position 2 of a single-letter tag.
- Test against a client you didn't write. If your note doesn't thread in another client, your tags are wrong — regardless of how it looks in yours.

## Filters

```json
{ "ids": [], "authors": [], "kinds": [], "#e": [], "#p": [], "#t": [],
  "since": 0, "until": 0, "limit": 50, "search": "query" }
```

- Values **within** a list are OR'd; **different** fields are AND'd; **multiple filters** in one `REQ` are OR'd.
- **There is no AND across tag values.** `{"#t": ["a","b"]}` means "a *or* b", never "both". If you need an intersection you must over-fetch and filter client-side. A `&` intersection modifier is proposed ("NIP-91", PR #2252) but **not merged** — don't design a feature that depends on it.
- `ids`, `authors`, `#e`, `#p` **MUST be exact 64-char lowercase hex**. Prefix matching was removed — any doc still teaching it is stale.
- `since <= created_at <= until`, inclusive at both ends.
- `limit` applies to the **initial query only** and MUST be ignored afterwards. It means "the last n events by `created_at`", newest first, ties broken by lowest id.
- Always set a sane `limit` (50–500). An unbounded `REQ` against a big relay is how you hang the UI.
- `search` requires NIP-50 support; check NIP-11 first.

## Client ↔ Relay Messages

**Client → relay:** `EVENT`, `REQ`, `CLOSE`, `AUTH` (NIP-42), `COUNT` (NIP-45)

```
["EVENT", <event>]
["REQ", <subscription_id>, <filter>, <filter>, ...]
["CLOSE", <subscription_id>]
```

**Relay → client:** `EVENT`, `OK`, `EOSE`, `CLOSED`, `NOTICE`, `AUTH`, `COUNT`

```
["EVENT", <subscription_id>, <event>]
["OK", <event_id>, <true|false>, <message>]
["EOSE", <subscription_id>]
["CLOSED", <subscription_id>, <message>]
["NOTICE", <message>]
```

`subscription_id` is max 64 chars, per-connection, **not globally unique**. Open **one** websocket per relay and multiplex subscriptions over it — relays may cap connections per IP.

Re-using an existing `subscription_id` in a new `REQ` **replaces** that subscription rather than adding one.

## OK / CLOSED Prefixes

Machine-readable, single word, followed by `:` and prose. Parse the prefix; never regex the prose.

`duplicate` · `pow` · `blocked` · `rate-limited` · `invalid` · `restricted` · `mute` · `error`

Handling:
- `duplicate:` — success in disguise; the relay already had it.
- `blocked:` / `restricted:` — you aren't allowed here. Retry elsewhere; don't retry the same relay.
- `rate-limited:` — back off, then retry.
- `pow:` — the relay wants NIP-13 proof of work.
- `invalid:` — your event is malformed or the timestamp is too far off. Fix, don't retry.
- `error:` — relay-side failure; retry is reasonable.

The 4th parameter of `OK` MUST always be present, but MAY be empty when the 3rd is `true`.

## Kinds Worth Knowing That Postdate Most Tutorials

| Kind | What | NIP |
|---|---|---|
| `9` | Chat message | C7 |
| `11` | Forum thread | 7D |
| `20` | Picture-first post | 68 |
| `21` / `22` | Video / short-form portrait video | 71 |
| `24` | Public message | A4 |
| `1111` | Comment (the general-purpose one) | 22 |
| `1222` / `1244` | Voice message / voice comment | A0 |
| `1068` / `1018` | Poll / poll response | 88 |
| `1337` | Code snippet | C0 |
| `9321` | Nutzap | 61 |
| `17375` / `7375` | Cashu wallet / tokens | 60 |
| `30040` / `30041` | Curated publication index / content | NKBIP-01 |
| `30166` / `10166` | Relay discovery / monitor announcement | 66 |
| `30382` / `30383` | Trusted assertions (web of trust) | 85 |
| `39089` | Starter packs | 51 |
| `62` | Request to vanish | 62 |
| `15128` / `35128` / `5128` | nsite root / named / snapshot manifest | 5A |

Prefer `mcp__nostr__read_kind(<n>)` over this table — it's live.

## Kind Collisions — Check Before You Trust a Number

Kind numbers are claimed by convention, and the registry occasionally issues one twice. A live example as of 2026-07-25: **`kind:10011`** is External Identities (NIP-39) *and* was merged as NIP-51 favorite follow sets (PR #2413); a renumbering to `kind:10021` is open in PR #2417 precisely because of the conflict.

So before relying on any kind number:

1. `mcp__nostr__read_kind(<n>)` — what does the registry say it is?
2. Cross-check https://github.com/nostr-protocol/registry-of-kinds and https://undocumented.nostrkinds.info/
3. Search open NIP PRs — a number can be contested while the docs still look settled.

If a kind you depend on is disputed, parse defensively: match on kind **plus** an expected tag shape, not on the number alone. An event you can't confidently interpret should be ignored, never guessed at.
