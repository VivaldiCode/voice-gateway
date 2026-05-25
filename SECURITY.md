# Security Policy

Thank you for taking the time to make Voice Gateway safer. We treat
security reports as the highest-priority class of issue in the project.

## Reporting a vulnerability

**Please do not open a public GitHub issue.** Use one of these channels
so we can triage before the world sees the details:

1. **GitHub Security Advisories (preferred)** —
   <https://github.com/VivaldiCode/voice-gateway/security/advisories/new>
   This creates a private advisory we can collaborate on, and lets us
   request a CVE if the issue warrants one.
2. **Email** — file an issue with the subject `[security]` requesting
   contact via a private channel; a maintainer will reply with a
   secure address.

Please include:
- A description of the issue + impact
- Reproduction steps (or a proof-of-concept commit on a fork)
- The affected version (`git describe --always` from your checkout, or
  the DMG version string from `About → Sobre`)
- Whether you've notified anyone else (so we can co-ordinate disclosure)

We aim to acknowledge reports within **3 working days** and ship a fix
or mitigation within **30 days** for high-severity issues. Lower
severities follow a best-effort timeline aligned with the normal
release cadence.

## Supported versions

We currently support **the latest released minor** on `main`. Older
minors are not patched — if you're on an older build, please update.

| Version       | Supported          |
| ------------- | ------------------ |
| latest minor  | :white_check_mark: |
| older minors  | :x:                |

## Scope

In scope for security reports:

- **Renderer-side issues** — XSS via untrusted server transcripts,
  prototype pollution through IPC payloads, context-isolation bypass
- **IPC privilege escalation** — renderer → main reaching APIs it
  shouldn't have (file system, child_process, shell), or preload
  leaking unsafe globals into `window`
- **Bridge auth bypass** — token validation flaws in
  `server/hermes-voice-bridge/`, replay attacks against the WS handshake,
  CSRF via WS upgrade headers
- **Adapter input handling** — STT / TTS adapters mishandling untrusted
  audio (oversized buffers, format-confusion crashes)
- **Supply chain** — dependency confusion in npm or pip packages,
  malicious post-install scripts, compromised GitHub Actions
- **Packaged-app code signing** — DMG tampering, autoUpdater feed
  spoofing (once auto-update lands), notarization bypass
- **Settings persistence** — bridge token leaking into log files,
  electron-store readable by other apps

Out of scope (won't be treated as security issues, but bug reports
still welcome):

- **DoS via user-supplied audio** — feeding 10 minutes of silence,
  overflowing the local VAD ring buffer
- **Social-engineering** — convincing a user to paste a malicious bridge URL
- **Local-attacker-with-root** — anything that requires already
  controlling the user's machine
- **Crashes that need physical access to the device** (e.g. unplugging
  the USB mic mid-capture)
- **Third-party Hermes server vulnerabilities** — report those to the
  Hermes upstream

## What we do on our side

Documented because supply-chain transparency matters:

- **CodeQL** code scanning runs on every PR + weekly against `main`
  (`security-extended` query pack for both TypeScript and Python).
- **Dependabot** monitors `npm`, `pip`, and `github-actions`
  ecosystems weekly; security updates fast-track via separate PRs.
- **Dependency Review** action blocks PRs that introduce
  high-severity vulnerable dependencies.
- **npm audit + signatures** verify installed packages were signed
  by their authors (provenance checking) on every CI run.
- **pip-audit** flags vulnerable Python deps in the bridge.
- **GitHub Actions** are pinned to commit SHAs (not floating tags)
  to mitigate the "compromised tag re-points" attack class. Dependabot
  bumps the SHAs as the actions ship new releases.
- **Secret scanning** with push protection blocks committed secrets
  before they reach `origin`.
- **Branch protection** on `main` requires the full CI matrix to be
  green before merge (issue #21).

## Acknowledgements

We'll credit reporters in the release notes (and the advisory) by
default. If you'd prefer to stay anonymous, just say so in the report.
