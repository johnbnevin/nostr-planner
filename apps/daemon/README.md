# Planner Daemon

Optional background service for Nostr Planner. Sends daily digest emails and real-time push notifications. Also serves an iCal feed for CalDAV sync.

The daemon is **not required** for the planner to work. All core functionality (calendar, tasks, sharing) runs entirely in the browser or Tauri app.

## What It Does

1. **Digest Emails** — Watches for user digest configuration events on Nostr relays. At each user's configured time, builds an HTML email summarizing their day (events, todos, habits) and sends it via SMTP.

2. **Push Notifications** — Subscribes to users' push configuration events. Sends Web Push notifications before upcoming events start.

3. **CalDAV/iCal Feed** — Serves public calendar events as `.ics` files that Google Calendar, Apple Calendar, and Outlook can subscribe to.

## Architecture

```
User's Planner App                  Daemon
┌─────────────────┐    Nostr     ┌──────────────────┐
│  Publish digest  │────relay────│  Subscribe to     │
│  config/data as  │             │  kind 30078 events│
│  kind 30078      │             │  tagged to bot    │
└─────────────────┘             └────────┬─────────┘
                                         │
                              ┌──────────┼──────────┐
                              │          │          │
                          ┌───▼───┐  ┌──▼──┐  ┌───▼────┐
                          │ SMTP  │  │Push │  │CalDAV  │
                          │ Email │  │API  │  │ Feed   │
                          └───────┘  └─────┘  └────────┘
```

Events are encrypted with NIP-44 to the daemon's bot pubkey. The daemon decrypts them to read digest data, push subscriptions, and configuration.

## Setup

```bash
# 1. Install dependencies (from monorepo root)
npm install

# 2. Copy and fill in the environment file
cp .env.example .env
# Edit .env — at minimum set BOT_NSEC and SMTP credentials

# 3. Run in development
npm run dev

# 4. Build for production
npm run build
node dist/index.js
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BOT_NSEC` | Yes | — | Daemon's Nostr private key (nsec1... or hex) |
| `SMTP_HOST` | Yes | smtp.resend.com | SMTP server hostname |
| `SMTP_PORT` | No | 587 | SMTP server port |
| `SMTP_USER` | Yes | — | SMTP username |
| `SMTP_PASS` | Yes | — | SMTP password |
| `FROM_EMAIL` | No | digest@example.com | Sender address for digest emails |
| `VAPID_PUBLIC_KEY` | No | — | Web Push VAPID public key |
| `VAPID_PRIVATE_KEY` | No | — | Web Push VAPID private key |
| `VAPID_EMAIL` | No | — | VAPID contact email |
| `CHECK_INTERVAL_MINS` | No | 15 | Digest check interval (minutes) |
| `MAX_STALE_HOURS` | No | 36 | Max hours before re-sending digest |
| `PUSH_CHECK_INTERVAL_SECS` | No | 60 | Push notification check interval (seconds) |
| `CALDAV_PORT` | No | 0 (disabled) | Port for iCal feed server |

## CalDAV / iCal Feed

When `CALDAV_PORT` is set, the daemon serves public calendar events as iCal feeds:

```
http://localhost:8080/cal/{npub}.ics
```

Subscribe to this URL in Google Calendar, Apple Calendar, or Outlook. Only **public** events (kinds 31922, 31923) are exposed. Private/encrypted events are never included.

## Nostr Events

The daemon watches for these `kind: 30078` app-data events:

| d-tag prefix | Purpose |
|-------------|---------|
| `planner-digest-config-{pubkey}` | User's email, timezone, preferred digest time |
| `planner-digest-data-{pubkey}` | Today's events, todos, habits (encrypted) |
| `planner-push-sub-{pubkey}` | Web Push subscription endpoint + keys |

All events are NIP-44 encrypted to the daemon's bot pubkey.
