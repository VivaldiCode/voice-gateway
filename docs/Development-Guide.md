# Development Guide

A focused contributor's manual: how to get a working dev environment,
which scripts do what, and the conventions that keep the codebase
predictable.

## Prerequisites

- **Node.js ≥ 22** — for ESM main bundle + `node:test`-style globals.
- **npm 10+** — bundled with Node 22.
- **Python 3.10+** — for the wake-word runner (only required if you
  enable wake-word mode in dev).
- **macOS 12+ (recommended)** — for testing the microphone permission
  flow. Linux works for everything except TCC-specific code paths.

A working Hermes bridge somewhere is optional — many integration tests
inject fakes.

## Clone + install

```bash
git clone https://github.com/VivaldiCode/voice-gateway
cd voice-gateway
npm install
```

The post-install rebuilds native modules (none required today, but the
pipeline is in place).

## Day-to-day scripts

| Command                | What it does                                              |
|------------------------|-----------------------------------------------------------|
| `npm run dev`          | electron-vite dev: HMR on the renderer, main restarts on TS change. |
| `npm test`             | vitest run — all unit + integration tests, no E2E.        |
| `npm run lint`         | ESLint over `src/` and `tests/`.                          |
| `npm run typecheck`    | `tsc --noEmit` — full TS strict check.                    |
| `npm run build`        | `electron-vite build && electron-builder` — current host's target. |
| `npm run build:mac`    | macOS arm64 `.dmg`.                                       |
| `npm run build:linux`  | `AppImage`.                                               |
| `npm run build:win`    | `nsis` installer.                                         |
| `npm run test:e2e`     | Playwright against the **packaged** app — needs `build:mac` first. |

The CI gate is `npm run lint && npm run typecheck && npm test`. Failing
any of those should block a PR.

## Repo conventions

### Directory boundaries

```
src/
├── shared/        # ESM-only, no Node deps. Importable from any process.
├── main/          # Node-only. Owns services + IPC handlers + windows.
├── preload/       # CommonJS. Tiny: just exposes vg.* via contextBridge.
└── renderer/      # Sandboxed React. No node-fs, no node-child_process.
```

If you find yourself reaching for `node:fs` in the renderer, you're
going the wrong way — move the logic to main and expose it via IPC.

### Import paths

Use the path aliases set up in
[`tsconfig.json`](https://github.com/VivaldiCode/voice-gateway/blob/main/tsconfig.json):

| Alias          | Resolves to        |
|----------------|--------------------|
| `@shared/*`    | `src/shared/*`     |
| `@main/*`      | `src/main/*`       |
| `@preload/*`   | `src/preload/*`    |
| `@renderer/*`  | `src/renderer/*`   |

Relative imports within a folder are fine. Crossing folder boundaries
should always use the alias — makes refactors trivial.

### TypeScript

- `strict: true` is on. Don't add `// @ts-ignore` — fix the type.
- Prefer `interface` for object shapes, `type` for unions and tuples.
- Avoid `any`. Use `unknown` and a type guard when validating
  external data.
- Explicitly type all exported functions' return types (eslint will
  remind you).

### Error handling

The project distinguishes three error tiers:

1. **Fatal pipeline error** — dispatched as the FSM `ERROR` event,
   emitted to the renderer over `vg:conv:error`. UI shows red orb.
   Examples: STT failed, WS auth failed, Hermes 401.
2. **Recoverable hint** — emitted as a `warning` event (orchestrator
   has dedicated `warning` channel). UI flashes a toast, FSM stays
   usable. Example: capture too short.
3. **Programmer error** — `throw new Error(...)` with a useful
   message. Surfaces in dev console; should never reach a user.

Always prefer Portuguese for messages the user will see directly.
Internal log strings (`log.info('[VG] xyz')`) stay in English.

### Logging

- `electron-log/main` in main, with file transport at `info` level and
  console at `debug`.
- Prefix every log message with `[VG]` for grep-ability.
- Settings and TTS/STT lifecycle changes log INFO; per-chunk activity
  logs DEBUG.

Log files on macOS: `~/Library/Logs/Voice Gateway/main.log`.

## Adding a feature

### "I want to add an STT provider"

1. Implement [`SttAdapter`](https://github.com/VivaldiCode/voice-gateway/blob/main/src/main/services/stt-service.ts).
2. Extend `SttProvider` in
   [`src/shared/types.ts`](https://github.com/VivaldiCode/voice-gateway/blob/main/src/shared/types.ts).
3. Wire `createSttAdapter()`.
4. Add a card in **Reconhecimento** in
   [`SettingsPanel.tsx`](https://github.com/VivaldiCode/voice-gateway/blob/main/src/renderer/components/SettingsPanel.tsx).
5. Add tests in
   [`tests/integration/stt-service.test.ts`](https://github.com/VivaldiCode/voice-gateway/blob/main/tests/integration/stt-service.test.ts).

See [[Speech-To-Text#adding-a-new-stt-provider]] for the full
checklist.

### "I want to add a protocol message"

1. Add the discriminant to `ClientMessage` or `ServerMessage` in
   [`src/shared/protocol.ts`](https://github.com/VivaldiCode/voice-gateway/blob/main/src/shared/protocol.ts).
2. Update the matching `parseClientMessage` / `parseServerMessage`
   case.
3. Bump the version note in [[Protocol]] and document the new event.
4. Wire emission in the bridge (`server.py`) and consumption in
   `HermesClient` + `Orchestrator`.
5. Add round-trip tests in `tests/unit/protocol.test.ts`.

### "I want to change FSM behaviour"

1. Edit
   [`src/shared/state-machine.ts`](https://github.com/VivaldiCode/voice-gateway/blob/main/src/shared/state-machine.ts).
2. **Always** add at least one case to `tests/unit/state-machine.test.ts`
   covering the new transition AND the invalid-event-stays-same-ref
   contract for it.
3. Update the diagram in
   [[State-Machine]] — the diagram is the source of truth users will
   read.

## Releasing

We don't tag automatically. To cut a release:

```bash
# 1. Bump CLIENT_VERSION in src/shared/constants.ts AND
#    server/hermes-voice-bridge/src/hermes_voice_bridge/__init__.py
# 2. Update CHANGELOG.md
git commit -am "release: 0.2.0"
git tag v0.2.0
git push --tags

npm test
npm run build:mac

gh release create v0.2.0 release/*.dmg --generate-notes
```

The bridge isn't packaged separately — users get the new version on
next `install.sh` run (the script is idempotent and auto-upgrades the
PyPI package).

## Style nits we actually care about

- Comments explain **why**, not what. The diff already shows the what.
- Multi-line strings use template literals; never `\n` concatenation.
- One `console.error`-equivalent per fatal path — duplicates clutter
  the log.
- Imports ordered: node built-ins, third-party, `@shared`/`@main`/
  etc, relative. ESLint enforces this.
- Tests use Vitest's `it('asserts X', () => …)` not `test('X', …)` for
  consistency with the rest of the suite.

## Help, things are broken

Sequence to try, in order:

1. `rm -rf node_modules dist out release && npm install`
2. `npm run typecheck && npm run lint && npm test`
3. Check `~/Library/Logs/Voice Gateway/main.log` — every fatal path
   logs there.
4. [[Troubleshooting]] — covers user-visible symptoms.
5. Open an issue on the
   [tracker](https://github.com/VivaldiCode/voice-gateway/issues).
