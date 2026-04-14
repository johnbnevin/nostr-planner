# Planner — Project CLAUDE.md

See `SKILL.md` in this folder for general Nostr React/TypeScript patterns, library choices, relay strategy, Blossom, and NSite. This file covers decisions specific to this planner application.

---

## What This App Is

- React + TypeScript + Vite
- Personal planner — each user's data is their own, keyed by their Nostr pubkey
- Login via NIP-07 browser extension (nos2x, Alby, etc.) — no accounts, no server
- Deployed as an nsite so anyone can use it at their own npub address
- Backup via Blossom blob storage

---

## Event Kinds in Use (NIP-52)

NIP-52 is `draft` + `optional` but is the canonical and only existing calendar standard. Kinds verified via MCP tools and cross-checked against https://undocumented.nostrkinds.info/.

| Kind | Purpose | Key Required Tags |
|------|---------|-------------------|
| **31922** | All-day / multi-day event | `d`, `title`, `start` (YYYY-MM-DD) |
| **31923** | Timed event (with clock time) | `d`, `title`, `start` (unix seconds), `D` (day floor) |
| **31924** | Calendar collection | `d`, `title`, `a` refs to events |
| **31925** | RSVP to a calendar event | `d`, `a`, `status` |

Tag details worth remembering:
- `D` tag on 31923 = `Math.floor(unixSeconds / 86400)` — required by spec, enables efficient day-range queries. Use multiple `D` tags to span multi-day events.
- `start_tzid` / `end_tzid` = IANA timezone strings (e.g. `"America/New_York"`)
- `end` is exclusive — like a Python range end
- Recurring events: **not in spec** — generate individual event instances client-side
- RSVP `status` values: `accepted`, `declined`, `tentative`
- RSVP `fb` values: `free`, `busy` (omit if status is `declined`)

If NIP-52 evolves, re-verify kinds with MCP before making architecture changes.

---

## Before Adding Any New Event Kind

Follow the process in SKILL.md. In short: use `mcp__nostr__read_kind`, check https://undocumented.nostrkinds.info/, check NIPs index. Don't pick a number that's already taken.

---

## Backup Strategy

User's events already live on their Nostr relays. Blossom backup adds resilience against relay data loss:

1. Fetch all user's calendar events (kinds 31922, 31923, 31924)
2. Serialize to JSON
3. Upload blob to 2+ Blossom servers via `multiServerUpload()` → get `sha256`
4. Publish a replaceable Nostr event storing `sha256` + server list (research the right kind for this before implementing — use MCP + undocumented.nostrkinds.info)
5. **Restore:** fetch that replaceable event → get sha256 → fetch blob from any server → re-publish events to relays

---

## Login Flow

**Web/browser:**
1. Check `window.nostr` on load (NIP-07 extension)
2. If present: `getPublicKey()` → user is logged in
3. If absent: show option to install nos2x/Alby, or connect via NIP-46 remote signer

**Tauri standalone (desktop/mobile):**
1. Check `window.__TAURI_INTERNALS__` to detect Tauri environment
2. Offer: (a) enter nsec/hex private key (stored encrypted in OS keychain via plugin-store), or (b) NIP-46 remote signer connection
3. nsec input is only shown in the Tauri environment, never in the web build
4. All signing uses the `NostrSigner` interface (`src/lib/signer.ts`)

---

## Privacy-First Publishing (Critical Rule)

**Private events must NEVER be published as NIP-52 calendar kinds (31922, 31923, 31924).** Other Nostr clients index these kinds and would expose the user's schedule.

- **Private calendars (default):** Events are NIP-44 encrypted and published as `kind: 30078` (app data). The original NIP-52 kind is stored inside the encrypted payload. This makes events completely opaque to other clients and relays.
- **Public calendars (opt-in):** Only when the user explicitly marks a calendar as "Public" in settings are events published as plaintext NIP-52 kinds, visible to other Nostr clients.
- **No plaintext fallback:** If NIP-44 is unavailable, private events cannot be published at all. There is no "allow plaintext" override — the user must either use a signer with NIP-44 or publish to public calendars only.
- **All changes must apply to all platforms** (web, Tauri desktop, mobile) by default.

---

## Cross-Platform Parity (Critical Rule)

**NEVER make changes to only one platform without making equivalent changes to all platforms.** Web, Tauri desktop, and mobile must be kept as identical to each other as they can practically be. The only acceptable platform-specific divergences are:

- **Login method availability:** nsec input is Tauri-only (gated by `isTauri()`), NIP-07 extension is web-only (gated by `window.nostr`). NIP-46 remote signer works everywhere.
- **OS-level integrations:** Tauri plugin-store for encrypted keychain storage, native notifications via Tauri APIs vs. Web Push.

Everything else — UI, encryption, relay logic, backup, sharing, event handling — must be identical across platforms. When modifying any shared code, verify the change works on all platforms. When adding a new feature, implement it for all platforms in the same PR.

**Never leave feature gaps between platforms.** If a feature exists on web, it must also exist on desktop and mobile — and vice versa. Before considering any task complete, verify that all platforms have access to the same functionality. If a UI element is only visible at certain breakpoints (e.g. `hidden lg:block`), ensure an equivalent mobile-accessible path exists (e.g. a modal overlay triggered from the mobile header).

---

## NSite Deployment

```bash
npm run build
nsite-cli deploy ./dist
```

Each user accesses the app at `<their-npub>.nostr.hu`. Their planner data is isolated by pubkey — no cross-user access.

---

## Relay Approach (Start Simple)

1. Hardcode 3 reliable fallback relays (e.g. `wss://relay.damus.io`, `wss://relay.nostr.band`, `wss://nos.lol`)
2. On login, fetch user's NIP-65 relay list (kind 10002) and prefer those for reads/writes
3. Add outbox sophistication later if needed

---

## Dev Server

Always run the dev test server for planner from `/home/q4/planner/apps/planner` on port **8000**. If port 8000 is already in use, kill whatever is occupying it first — this app always owns port 8000.

```
lsof -ti:8000 | xargs -r kill -9; cd /home/q4/planner/apps/planner && npx vite --port 8000
```

---

## Backup (Source Code)

When the user says "backup", produce a zip of all source code so they can restore in case of catastrophic failure. Do NOT include `node_modules`, `dist`, or `.vite`.

```bash
cd /home/q4/planner && zip -r ~/planner-backup-$(date +%Y%m%d-%H%M%S).zip . -x "node_modules/*" "dist/*" ".vite/*" ".git/*" "apps/*/node_modules/*" "apps/*/dist/*"
```
