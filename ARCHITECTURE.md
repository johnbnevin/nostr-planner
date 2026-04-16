# Architecture

Technical reference for contributors. Covers data flow, encryption layers, module responsibilities, and protocol decisions.

## Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        User's Device                                │
│                                                                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │  Login    │  │ Calendar │  │  Tasks   │  │    Settings       │  │
│  │  Screen   │  │  Views   │  │  Panel   │  │    Panel          │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └───────┬───────────┘  │
│       │              │             │                │               │
│  ┌────▼──────────────▼─────────────▼────────────────▼───────────┐  │
│  │                    React Context Layer                        │  │
│  │  NostrContext  CalendarContext  TasksContext  SettingsContext  │  │
│  └────────────────────────┬─────────────────────────────────────┘  │
│                           │                                        │
│  ┌────────────────────────▼─────────────────────────────────────┐  │
│  │                     Library Layer                             │  │
│  │  relay.ts  crypto.ts  sharing.ts  nostr.ts  signer.ts  ...  │  │
│  └────────────────────────┬─────────────────────────────────────┘  │
│                           │                                        │
│  ┌────────────────────────▼─────────────────────────────────────┐  │
│  │                     Signer Layer                              │  │
│  │  Nip07Signer (browser)  LocalSigner (Tauri)  Nip46Signer    │  │
│  └──────────────────────────────────────────────────────────────┘  │
└───────────────────────────────┬─────────────────────────────────────┘
                                │ WebSocket (wss://)
                                ▼
                    ┌───────────────────────┐
                    │    Nostr Relays        │
                    │  (user's NIP-65 list)  │
                    └───────────────────────┘
```

## Module Map

### Contexts (state management)

| Context | File | Responsibility |
|---------|------|----------------|
| `NostrContext` | `contexts/NostrContext.tsx` | Login/logout, signer management, pubkey, relay list, NIP-65 parsing, event signing + publishing |
| `CalendarContext` | `contexts/CalendarContext.tsx` | Calendar collections, events, shared keys, encryption/decryption, CRUD operations, invite handling |
| `TasksContext` | `contexts/TasksContext.tsx` | Daily habits, task lists, completions (kind 30078 app-data) |
| `SettingsContext` | `contexts/SettingsContext.tsx` | User preferences, encryption toggle, notification settings, digest config |

### Library (pure logic, no React)

| Module | File | Responsibility |
|--------|------|----------------|
| `relay` | `lib/relay.ts` | NPool management, NIP-65 outbox routing, query with signature verification, publish with retry |
| `nostr` | `lib/nostr.ts` | Event kind constants, d-tag constants, NIP-52 tag builders/parsers, recurrence expansion, RRULE conversion |
| `crypto` | `lib/crypto.ts` | NIP-44 encrypt/decrypt for private events, encrypted event detection |
| `sharing` | `lib/sharing.ts` | AES-256-GCM key management, key envelopes, member lists, invite payloads, NIP-05 lookup |
| `signer` | `lib/signer.ts` | `NostrSigner` interface, `Nip07Signer` implementation |
| `localSigner` | `lib/localSigner.ts` | In-memory signing with NIP-49 encrypted storage |
| `nip46Signer` | `lib/nip46Signer.ts` | NIP-46 remote signer (Amber, Nsec.app) |
| `backup` | `lib/backup.ts` | Blossom blob backup/restore with SHA-256 verification |
| `ical` | `lib/ical.ts` | iCal import/export with RRULE support |
| `platform` | `lib/platform.ts` | Tauri vs. browser detection |

## Data Flow

### Publishing an Event

```
User creates event in EventModal
       │
       ▼
CalendarContext.signAndPublish()
       │
       ├── shouldEncrypt?
       │    ├── Shared calendar? → encryptEventWithSharedKey() [AES-256-GCM]
       │    └── Private calendar? → encryptEvent() [NIP-44 to self]
       │         → Published as kind 30078 (opaque to other clients)
       │
       ├── Public calendar? → Published as kind 31922/31923 (visible to other NIP-52 clients)
       │
       ▼
NostrContext.signEvent() → signer.signEvent()
       │
       ▼
NostrContext.publishEvent() → publishToRelays() [retry up to 3x]
       │
       ▼
NPool → write relays (NIP-65 outbox model)
```

### Loading Events

```
CalendarContext.doRefresh()
       │
       ├── 1. loadSharedKeysFromNostr() [fetch AES key envelopes, cached 5min TTL]
       │
       ├── 2. queryEvents() from relays (parallel: plaintext kinds + kind 30078 + kind 5 deletions)
       │       │
       │       └── verifyEvent() on every response (drop invalid signatures)
       │
       ├── 3. Filter out non-calendar app-data (tasks, digest, sharing, backup)
       │
       ├── 4. Remove deleted events (kind 5 + localStorage set)
       │
       ├── 5. Decrypt calendars (first pass — unblocks UI)
       │
       └── 6. Decrypt events (second pass — parallel, batches of 20)
               │
               ├── AES-GCM? → decryptEventWithSharedKey()
               ├── NIP-44?  → decryptEvent() [to self]
               └── Plaintext? → parseCalendarEvent() directly
               │
               └── Track decryptionErrors → show warning banner in Header
```

## Encryption Layers

### Layer 1: Private Events (NIP-44)

Every private calendar event is encrypted to the user's own pubkey using NIP-44 (ChaCha20-Poly1305). The encrypted payload is published as `kind: 30078` instead of the real NIP-52 kind. The real kind, tags, and content are inside the encrypted envelope.

**Why kind 30078?** Other Nostr clients index kinds 31922-31925. Publishing encrypted content under those kinds would expose metadata (event existence, timing, d-tags). Kind 30078 is generic app-data — other clients ignore it.

### Layer 2: Shared Calendars (AES-256-GCM)

Shared calendars use a symmetric AES-256-GCM key per calendar. All members hold the same key and can encrypt/decrypt events independently.

Key distribution:
1. Owner generates a random AES-256-GCM key via `crypto.subtle.generateKey()`
2. Owner encrypts the key to each member's pubkey via NIP-44 and publishes as a key envelope (`kind: 30078`, d-tag: `planner-share-{calDTag}-{memberPubkey}`)
3. Owner stores their own copy of the key encrypted to self (`planner-cal-key-{calDTag}`)
4. Member list encrypted to self (`planner-cal-members-{calDTag}`)

Key rotation on member removal:
1. Revoke old key envelope (kind 5 deletion)
2. Generate new AES key
3. Re-encrypt all events on the calendar with the new key
4. Redistribute new key to remaining members

### Layer 3: Key Storage (NIP-49)

In Tauri builds, the user's Nostr private key is encrypted with a password using NIP-49:
- Key derivation: scrypt (log2 N = 16)
- Encryption: XChaCha20-Poly1305
- Storage format: bech32-encoded `ncryptsec1...` string
- Stored in Tauri's plugin-store JSON file (not the OS keychain, but encrypted at rest)

## Relay Strategy (NIP-65 Outbox)

On login, the user's `kind: 10002` relay list is fetched. Tags are parsed into read and write sets:

| Tag | Read | Write |
|-----|------|-------|
| `["r", "wss://relay.example.com"]` | Yes | Yes |
| `["r", "wss://relay.example.com", "read"]` | Yes | No |
| `["r", "wss://relay.example.com", "write"]` | No | Yes |

Queries are routed to read relays (up to 5). Publishes go to write relays (up to 5). Fallback relays are always merged in.

## NIP-52 Calendar Event Kinds

| Kind | Type | Key Tags | Privacy |
|------|------|----------|---------|
| 31922 | All-day event | `d`, `title`, `start` (YYYY-MM-DD) | Public or encrypted as 30078 |
| 31923 | Timed event | `d`, `title`, `start` (unix), `D` (day floor) | Public or encrypted as 30078 |
| 31924 | Calendar collection | `d`, `title`, `a` (event refs) | Public or encrypted as 30078 |
| 31925 | RSVP | `d`, `a`, `status` | Not yet implemented |
| 30078 | App-data (catch-all) | `d` (prefixed) | Always encrypted |

## Console Logging

All logs use `[module]` prefix convention for grepability:

```
[relay]        — Connection, query, publish operations
[calendar]     — Event loading, encryption, CRUD
[tasks]        — Habit/todo loading and saving
[backup]       — Blossom upload/download, integrity checks
[auto-restore] — Login-time backup restoration
[auto-backup]  — Periodic background backup
[digest]       — Digest config/data publishing
[daemon]       — Main process lifecycle
[registry]     — User registry in daemon
[push]         — Web Push notification delivery
[caldav]       — iCal feed server
```

Enable debug logging: `localStorage.setItem("planner-debug", "true")`

## Directory Structure

```
planner/
├── apps/
│   ├── planner/              # React + Vite + Tauri app
│   │   ├── src/
│   │   │   ├── components/   # React UI components
│   │   │   ├── contexts/     # React context providers (state management)
│   │   │   ├── hooks/        # Custom React hooks (auto-backup, digest, notifications)
│   │   │   └── lib/          # Pure logic (no React dependencies)
│   │   ├── src-tauri/        # Rust Tauri configuration and native code
│   │   └── public/           # Static assets, service worker, PWA manifest
│   └── daemon/               # Node.js digest/push/CalDAV service
│       └── src/
├── ARCHITECTURE.md            # This file
├── CONTRIBUTING.md            # Development workflow and guidelines
├── SECURITY.md                # Vulnerability disclosure process
└── README.md                  # Project overview and quick start
```
