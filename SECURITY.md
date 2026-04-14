# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Nostr Planner, **please do not open a public issue.**

Instead, report it privately:

1. **GitHub Security Advisories** (preferred): Use the "Report a vulnerability" button on the repository's Security tab.
2. **Nostr DM**: Send an encrypted NIP-44 DM to the maintainer's pubkey (see the repo description).

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if you have one)

We will acknowledge receipt within 48 hours and aim to release a fix within 7 days for critical issues.

## Scope

The following are in scope:

- **Private key handling** — storage, memory management, leakage vectors
- **Encryption** — NIP-44, AES-256-GCM, NIP-49 implementation flaws
- **Event integrity** — signature verification bypasses, event injection
- **Content Security Policy** — XSS, script injection in the Tauri webview
- **Relay trust** — malicious relay responses, event tampering
- **Shared calendar security** — key distribution, member revocation, key rotation
- **Backup integrity** — hash verification, tampered restore

## Out of Scope

- Relay-side issues (report to the relay operator)
- Browser extension vulnerabilities (report to the extension maintainer)
- Social engineering attacks
- Denial of service against public relays

## Security Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full encryption and key management design.

Key security properties:
- Private keys are never stored in plaintext (NIP-49 scrypt + XChaCha20-Poly1305)
- Private calendar events are NIP-44 encrypted; never published as plaintext NIP-52 kinds
- Event signatures are verified on every relay response
- CSP is enforced in the Tauri webview
- Shared calendar keys use AES-256-GCM with per-message random IVs
- Key material is zeroed in memory on logout (best-effort in JavaScript)
