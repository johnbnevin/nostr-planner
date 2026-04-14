# Nostr Planner

[![CI](https://github.com/nostr-planner/nostr-planner/actions/workflows/ci.yml/badge.svg)](https://github.com/nostr-planner/nostr-planner/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A personal calendar and planner built on the [Nostr](https://nostr.com) protocol. No accounts, no servers — your data lives on your own Nostr relays, owned entirely by your keys.

## Features

- **Month, week, and day calendar views** with timed and all-day events
- **Daily habits tracker** and to-do lists
- **Shared calendars** with end-to-end encryption (AES-256-GCM key envelopes via NIP-44)
- **Recurring events** (daily, weekly, monthly, yearly) with iCal RRULE interop
- **iCal import/export** and CalDAV feed for Google Calendar / Apple Calendar / Outlook
- **Blossom backup** — encrypted blob backup to resilient storage servers
- **Push notifications and daily digest emails** via the optional daemon
- **Cross-platform** — web, desktop (Windows/macOS/Linux), and mobile (iOS/Android) via Tauri v2
- **PWA-ready** service worker for offline use
- **NIP-59 gift-wrap** support for metadata-blind publishing
- **Searchable encryption** — blind HMAC tokens enable relay-side filtering without decryption

## How It Works

All calendar data is stored as Nostr events on your relays:

| Kind | Purpose |
|------|---------|
| 31922 | All-day / multi-day event (NIP-52) |
| 31923 | Timed event with clock time (NIP-52) |
| 31924 | Calendar collection (NIP-52) |
| 31925 | Event RSVP (NIP-52) |
| 30078 | App-specific data (habits, lists, sharing keys, backups) |

Events are signed with your Nostr key. Private events are NIP-44 encrypted and published as kind 30078 — invisible to other calendar clients. Public events use standard NIP-52 kinds for interop.

## Repository Structure

```
nostr-planner/
├── apps/
│   ├── planner/          # React + Vite + Tauri app (web + desktop + mobile)
│   │   ├── src/
│   │   │   ├── components/   # React UI components
│   │   │   ├── contexts/     # State management (NostrContext, CalendarContext, etc.)
│   │   │   ├── hooks/        # Custom hooks (auto-backup, digest, notifications)
│   │   │   └── lib/          # Pure logic — crypto, relay, parsing (no React)
│   │   └── src-tauri/        # Rust/Tauri native bindings
│   └── daemon/           # Digest email, push notification, and CalDAV server (Node.js)
├── ARCHITECTURE.md       # Technical deep-dive — data flow, encryption layers, module map
├── CONTRIBUTING.md       # Development workflow and code style
├── SECURITY.md           # Vulnerability disclosure process
├── CODE_OF_CONDUCT.md
├── LICENSE
└── turbo.json
```

## Getting Started

### Prerequisites

- Node.js 20+
- [Rust toolchain](https://rustup.rs/) (for Tauri desktop/mobile builds only)
- A Nostr key (browser extension for web, or enter your nsec in the desktop app)

### Web Development

```bash
git clone https://github.com/<your-org>/nostr-planner
cd nostr-planner
npm install
npm run dev         # starts at http://localhost:8000
```

### Desktop Development (Tauri)

```bash
cd apps/planner
npm run dev:tauri   # opens native window
```

### Mobile (Tauri)

```bash
cd apps/planner
npx tauri ios init      # one-time setup (requires Xcode)
npx tauri android init  # one-time setup (requires Android SDK)
npm run tauri ios dev
npm run tauri android dev
```

### Daemon (Optional)

The daemon handles push notifications, daily digest emails, and CalDAV feeds. See [`apps/daemon/README.md`](apps/daemon/README.md) for full setup.

```bash
cd apps/daemon
cp .env.example .env   # fill in BOT_NSEC, SMTP, VAPID keys
npm run dev
```

## Login

**Web:** Install a NIP-07 browser extension ([nos2x](https://github.com/fiatjaf/nos2x), [Alby](https://getalby.com), or [Amber](https://github.com/greenart7c3/Amber)) and click "Login with Nostr Extension".

**Desktop/Mobile (Tauri):** Enter your `nsec` private key (encrypted with NIP-49 before storage) or connect via NIP-46 remote signer (scan QR with Amber, Nsec.app, etc.).

## Security

- Private keys are encrypted at rest with NIP-49 (scrypt + XChaCha20-Poly1305)
- Private events are NIP-44 encrypted — never published as plaintext calendar kinds
- Event signatures are verified on every relay response
- CSP enforced in the Tauri webview
- Shared calendar keys use AES-256-GCM with key rotation on member removal
- Key material is zeroed in memory on logout

See [SECURITY.md](SECURITY.md) for vulnerability disclosure.

## Debugging

Enable debug logging in the browser console:

```js
localStorage.setItem("planner-debug", "true")
```

All logs use `[module]` prefixes (`[relay]`, `[calendar]`, `[nostr]`, `[settings]`, etc.) for easy filtering. Debug mode adds timing information and detailed state snapshots. Disable with:

```js
localStorage.removeItem("planner-debug")
```

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full technical reference — data flow diagrams, encryption layers, module map, NIP-65 outbox model, and console logging conventions.

## Deployment (NSite)

Anyone can deploy their own instance to their Nostr identity address:

```bash
cd apps/planner
npm run deploy          # builds and deploys via nsite-cli
```

Your planner is then available at `<your-npub>.nostr.hu` (or any NSite-compatible host).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development workflow, code style, and PR guidelines.

## License

MIT — see [LICENSE](LICENSE).
