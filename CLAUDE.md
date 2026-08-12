# Planner — Repo Root

Turborepo monorepo. The application lives in `apps/planner/`, which has its own `CLAUDE.md` covering decisions specific to that app — read it when working there.

## Nostr Protocol Guidance — Read `SKILL.md` First

**Before writing any Nostr protocol code, read `SKILL.md` at this repo root.** It is the router; load a file from `references/` when the task needs it (`references/protocol.md` for events/tags/filters, `references/relays.md` for relay strategy, `references/lists-and-sets.md` before ever inventing a kind, and so on — `SKILL.md` has the full index).

It exists because most Nostr knowledge in training data is out of date: NIP-04 is deprecated, NIP-96 was replaced by Blossom, nsites moved off kind `34128`, NIP-15 lost to NIP-99, and the commonly published kind-range table is wrong. `SKILL.md` is fact-checked against the live NIPs index and dated.

**Authority order** — when sources conflict, later ones lose:
1. `mcp__nostr__*` tools / nostrbook.dev (the live registry)
2. The NIPs repo and NIP text
3. `SKILL.md` and its `references/`
4. Everything else, including model training data

That order governs **facts, not judgment**. The Cypherpunk Defaults and Judgment Calls in `SKILL.md` are stated positions; a newer source does not override them. If a correction would touch a principle, reflect a genuine disagreement among Nostr devs, or involve discretion, **ask rather than changing it**.

`SKILL.md` is also published at https://github.com/johnbnevin/ai-coding-agent-skill-document-for-nostr-projects — keep the copies here in sync with it.
