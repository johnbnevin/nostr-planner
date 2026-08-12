# Commerce, Payments, and Long-Form Content

*Verified 2026-07-25.*

## Marketplaces — NIP-99

**NIP-99 classified listings** won, and it's the right thing to build on. NIP-15's structured marketplace (30017–30020) is marked **unrecommended** for being too complicated.

| Kind | Role |
|---|---|
| `30402` | Classified listing — live, addressable, `d` tag is the listing id |
| `30403` | Draft / inactive listing — same shape, not published |

### Why it holds up

It standardizes only the *listing shape* and stays deliberately **payment-agnostic** — no rail is baked into the protocol, so you settle over Lightning, Cashu/nutzaps, or anything else without forking the spec. It stretches across physical goods, services, work opportunities, rentals, free giveaways, and personals, so one kind covers cases that would each otherwise want their own.

### The payoff is cross-client visibility

A seller publishes once and every NIP-99 client can render it. One client specializes in local classifieds, another in subscriptions, another in a global catalog — all reading the same events. **Design listings so they degrade gracefully in a client you've never seen.** That's the whole point of publishing to a protocol instead of a platform.

### Live marketplace implementations

Worth reading before designing anything — this is where the conventions are actually being set.

| Client | Notes |
|---|---|
| **Conduit** — https://conduit.market · https://github.com/Conduit-BTC | Decentralized commerce on Nostr + Lightning. **Zero platform custody of funds or user data**, instant Bitcoin payouts, no fees. Built on the **Gamma Markets Market Spec** on top of NIP-99, explicitly for interoperability between stores and markets |
| **Plebeian Market** — https://plebeian.market | Migrating **from NIP-15 to NIP-99**, which is the clearest signal available about which spec won. Moving to richer Markdown listings with tags for price, location, and category |
| **Shopstr** — https://shopstr.store | Long-running NIP-99 storefront client |
| **Cypher** | Part of the same marketplace developer collective |

**Gamma Markets** authored an e-commerce use-case extension to NIP-99 (nostr-protocol/nips PR #1784) because NIP-99 alone is broad enough that everyone was inventing incompatible e-commerce conventions. If you're building commerce specifically, follow that spec rather than freelancing on top of bare NIP-99 — it's what Conduit implements and what the other marketplace devs are converging on.

### Composing a storefront without inventing kinds

- `30402` listings as the products
- **NIP-51 sets** — `30004` curation sets to group listings into a shop or category, `30003` bookmark sets for wishlists
- **NIP-32 labels** (1985) for taxonomy
- **NIP-22 comments** (1111) for reviews and Q&A on a listing
- **NIP-78** app-specific data (30078) before minting anything new
- Zaps or nutzaps on the listing event double as public sales signal

Spec shepherd: **Open Markets Foundation** (openmarkets.pub), a non-profit backing the NIP-99 / Gamma Markets de-commerce specification. **Eric FJ and Sync's Open Markets Podcast** is the best running source on where merchant tooling is heading.

## Payments

**NIP-57 Lightning Zaps** (9734 request / 9735 receipt) — the established path. Requires an LNURL-capable Lightning address on the recipient's profile, which means a server in the loop.

**NIP-47 Nostr Wallet Connect** (13194 info / 23194 request / 23195 response) — remote-control a wallet over nostr. How a web client spends without holding funds.

**NIP-60 Cashu Wallet** (17375 wallet, 7375 tokens, 7376 history, 7374 reserved) — ecash balance stored *as encrypted nostr events*, so the wallet follows the user across clients with no server. calle's Cashu underneath.

**NIP-61 Nutzaps** (9321, plus 10019 mint recommendations) — the zap *is* the ecash token, sent as an event. No Lightning invoice round-trip, no LNURL server, and it works while the recipient is offline. Meaningfully simpler than NIP-57 for many apps, and the more cypherpunk default.

**NIP-87** (38172 Cashu mint / 38173 Fedimint announcements) — discovering which mints are trusted.

**NIP-75 Zap Goals** (9041) — fundraising targets.

## Long-Form and Publications

**NIP-23** (30023 article / 30024 draft) — single long-form articles, Markdown content.

**NKBIP-01** (Silberengel / GitCitadel) — *modular* publications. `30040` is the index carrying metadata plus an ordered list of `30041` content sections. This is how you model a book, journal, or magazine rather than one giant Markdown blob. **Alexandria** is the reference reader; the parser is an NKBIP-01 extension of Asciidoctor.

**NKBIP-02** — AI embeddings / vector lists (kind 1987).
**NKBIP-03** — reference kinds `30` internal, `31` external web, `32` hardcopy, `33` prompt.

Related:
- **NIP-84 highlights** (9802)
- **NIP-54 wiki** (30818 article, 30819 redirects, 818 merge requests)
- **NIP-22 comments** (1111) — the general-purpose comment kind. Use this rather than kind 1 replies for anything that isn't a text note
- **NIP-37 drafts** (31234, 1234 checkpoint, 10013 private event relay list)
