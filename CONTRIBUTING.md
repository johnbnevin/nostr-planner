# Contributing to Nostr Planner

Thanks for your interest in contributing! This project is built on Nostr, a decentralized protocol, and contributions of all kinds are welcome.

## Getting Started

1. **Fork** the repository and clone your fork
2. **Install dependencies:** `npm install` from the repo root
3. **Start the dev server:** `npm run dev` (web at `http://localhost:8000`)
4. Make your changes, then open a pull request

## Repository Structure

```
apps/planner/   — React + Vite frontend + Tauri desktop/mobile wrapper
apps/daemon/    — Node.js daemon for push notifications and digest emails
```

See [README.md](README.md) for the full overview and setup instructions.

## Development Workflow

### Web

```bash
npm run dev              # start web dev server
npm run typecheck        # run TypeScript checks across all packages
npm run build            # production web build
```

### Desktop (Tauri)

```bash
cd apps/planner
npm run dev:tauri        # open Tauri dev window
npm run build:tauri      # package desktop app
```

## Code Style

- **TypeScript strict mode** is enforced — no `any`, no unused variables
- **Tailwind CSS** for all styling — no CSS files unless strictly necessary
- Keep components focused; extract logic to hooks or `lib/` utilities
- Follow the existing patterns for Nostr event publishing (`lib/relay.ts`, `lib/nostr.ts`)

## Nostr Protocol

Before working on any feature that involves new Nostr event kinds:

1. Check the [NIPs repository](https://github.com/nostr-protocol/nips) for existing specs
2. Search [undocumented.nostrkinds.info](https://undocumented.nostrkinds.info/) for unofficial kinds
3. Don't pick a kind number that's already in use

The app uses NIP-52 calendar events (kinds 31922–31925) and kind 30078 for app-specific data.

## Adding New Features

- **New calendar views or UI components** → `apps/planner/src/components/`
- **State management** → `apps/planner/src/contexts/`
- **Nostr utilities or event parsing** → `apps/planner/src/lib/`
- **Daemon features** (email, push) → `apps/daemon/src/`

## Pull Request Guidelines

- Keep PRs focused — one feature or fix per PR
- Write a clear description explaining *why* the change is needed
- Ensure `npm run typecheck` passes before opening a PR
- If you're adding UI, include a screenshot or short description of the behavior

## Reporting Issues

Use GitHub Issues. Please include:
- What you expected to happen
- What actually happened
- Steps to reproduce
- Browser/OS/version info

## Security

If you find a security vulnerability, please **do not** open a public issue. Instead, contact the maintainers privately via Nostr DM or email.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
