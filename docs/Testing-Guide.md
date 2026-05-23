# Testing Guide

Three layers, each fast and focused:

| Layer        | Runner                       | What it covers                                            | Where                                    |
|--------------|------------------------------|-----------------------------------------------------------|------------------------------------------|
| Unit         | `vitest` (`tests/unit/`)     | Pure functions: FSM, protocol parser, URL utils           | `tests/unit/*.test.ts`                   |
| Integration  | `vitest` (`tests/integration/`) | Services with fakes for I/O — HermesClient, STT, TTS, orchestrator | `tests/integration/*.test.ts`     |
| Bridge       | `pytest`                     | Python bridge `/ws` handshake, auth, SSE parsing          | `server/hermes-voice-bridge/tests/`      |
| E2E          | `@playwright/test`           | Packaged app, mic permission flow, pairing wizard, PTT    | `tests/e2e/*.spec.ts`                    |

Run the full TS suite:

```bash
npm test                  # vitest run (unit + integration)
npm run test:e2e          # Playwright (slow)
```

Run a single file:

```bash
npm test -- tests/unit/state-machine.test.ts
```

## Unit tests

Lightweight, no Electron. Imports the pure modules from
`src/shared/` and asserts directly.

### `state-machine.test.ts`

Drives the
[[State-Machine|FSM reducer]] through every transition listed in the
diagram. 28 cases as of writing, covering:

- Initial state per activation mode.
- Every valid transition (PTT_PRESS, PTT_RELEASE, WAKE_DETECTED, …).
- Every invalid event-in-state returns the **same context reference**
  (the orchestrator uses `===` to skip emit).
- `RESET` from ERROR clears all transient fields.
- `PTT_PRESS` from ERROR is the auto-recovery path.
- Mode switches honoured only in quiet states.
- Turn IDs increment across consecutive turns via the
  [[State-Machine#determinism-the-reducerenv|deterministic test ID env]].

A typical case:

```ts
it('PTT_PRESS from IDLE creates a new turn', () => {
  const env = makeEnv();    // returns 'turn-1', 'turn-2', ...
  const ctx = initialContext('PUSH_TO_TALK');
  const next = reduce(ctx, { type: 'PTT_PRESS' }, env);
  expect(next.state).toBe('CAPTURING');
  expect(next.turnId).toBe('turn-1');
});
```

### `protocol.test.ts`

Round-trips every message shape through `parseClientMessage` /
`parseServerMessage`. Asserts:

- valid payloads parse back to the original;
- missing required fields return `null` (no exceptions);
- forward-compatibility: extra fields are ignored;
- the binary-after-header pairing on the WS layer.

### `url-utils.test.ts`

`normalizeBridgeUrl` covers the user-typed URL space:

| Input                          | Normalized                       | `pathWasAdded` |
|--------------------------------|----------------------------------|----------------|
| `ws://host:8765`               | `ws://host:8765/ws`              | true           |
| `ws://host:8765/`              | `ws://host:8765/ws`              | true           |
| `ws://host:8765/ws`            | `ws://host:8765/ws`              | false          |
| `wss://host:8765/ws/`          | `wss://host:8765/ws`             | false          |

Also rejects invalid schemes (`http://`, `tcp://`).

## Integration tests

Vitest with fakes for every external dependency. No real network, no
real audio, no Electron — they run in 200 ms each.

### `hermes-client.test.ts`

Drives `HermesClient` against a fake WebSocket (`tests/integration/__mocks__/fake-ws.ts`).
Asserts:

- hello/welcome handshake.
- Reconnect backoff: attempt N delay is correct, no reconnect on
  explicit disconnect.
- Pong timeout terminates the socket and reconnects.
- Binary-after-header pairing.
- Status emission semantics (connecting → connected → error).

Timers are injected so the heartbeat can be stepped without
`vi.useFakeTimers()`:

```ts
const setT = vi.fn(setTimeout) as any;
const client = new HermesClient({ setTimeout: setT, ... });
```

### `conversation-orchestrator.test.ts`

The orchestrator is wired against fakes for the WS client, STT, TTS.
Each test drives a sequence of events and asserts on:

- emitted events (`state`, `transcript_final`, `response_text`, `tts_chunk`),
- FSM state at each step,
- buffer clearing on cancel,
- barge-in doesn't race SPEAKING → CAPTURING.

This is the regression net for [[Conversation-Orchestrator]] changes.

### `stt-service.test.ts` & `tts-service.test.ts`

Use a fake `spawn` to simulate subprocess behaviour:

```ts
const spawnImpl = vi.fn((bin, args, opts) => {
  const proc = new FakeChildProcess();
  setTimeout(() => proc.stdout.emit('data', Buffer.from('hello\n')), 10);
  setTimeout(() => proc.emit('close', 0), 20);
  return proc;
});
const adapter = new WhisperLocalAdapter({ spawnImpl, ... });
const result = await adapter.transcribe({ pcm: buf, language: 'en' });
expect(result.text).toBe('hello');
```

Same pattern for ElevenLabs streaming via `fetchImpl: vi.fn()`.

### `settings-store.test.ts`

Tests `electron-store` against a temp directory:

```ts
beforeEach(() => {
  app.setPath('userData', mkdtempSync(...));
});
```

Asserts defaults, deep merge, migration, listener add/remove.

### `pair-test.test.ts`

`testPairing()` against fake WebSocket responses — exercises the
friendly-error mapping for every failure mode (401, 404, ECONNREFUSED,
ENOTFOUND, certificate errors, timeout).

### `bridge-text-roundtrip.test.ts` — **live**

This one talks to a **real** running bridge. It's `describe.skip`'d
unless both `VG_BRIDGE_URL` and `VG_BRIDGE_TOKEN` are set:

```bash
VG_BRIDGE_URL=ws://10.0.19.1:8765/ws \
VG_BRIDGE_TOKEN=kug4fJKR... \
npm test -- tests/integration/bridge-text-roundtrip.test.ts
```

The test sends the literal text "oi" as a final transcript and waits
for at least one non-empty `response_text` delta back. Times out at
90 s by default — override with `VG_BRIDGE_TIMEOUT_MS=120000` if your
Hermes is slow.

Use this when:

- You change the bridge protocol — confirms desktop ↔ bridge ↔ Hermes
  is still end-to-end intact.
- A user reports "no response" — gives you a deterministic reproducer
  outside the desktop UI.

## Python bridge tests

Pytest, from inside the bridge's venv:

```bash
cd server/hermes-voice-bridge
source venv/bin/activate
pytest -q
```

Coverage:

- `/ws` upgrade with valid + invalid Bearer tokens.
- The hello/welcome handshake shape.
- `_run_turn` dispatching against a fake adapter that yields chosen
  deltas (with and without final).
- The non-stream fallback when the streaming adapter yields zero.
- `_iter_sse_deltas` boundary cases (split across TCP chunks, missing
  trailing newline, `[DONE]` sentinel).

## E2E (Playwright)

Slow but high-confidence. Launches the **packaged** `.app` and drives
the real UI:

```bash
npm run build:mac          # produce release/*.dmg
npm run test:e2e
```

Currently covers:

- Pairing wizard happy path (uses an in-process fake bridge for
  predictable responses).
- PTT button click → `CAPTURING` orb → release → `THINKING` → either
  empty-transcript IDLE recovery or full reply playback.
- Settings panel opens in a separate BrowserWindow, edits persist.

The Playwright launcher uses `_electron.launch({ executablePath: appPath })`
so the test boots the **same** signed bundle a user installs — catching
afterPack hook regressions (missing Info.plist key would surface as a
mic-permission timeout here).

## CI strategy (planned)

The test pyramid is sized to fit a free GitHub Actions tier:

| Job          | Matrix                              | Time      |
|--------------|-------------------------------------|-----------|
| Unit + integration | `ubuntu-latest`, Node 22       | <30 s     |
| Bridge       | `ubuntu-latest`, Python 3.10/3.11   | <20 s     |
| E2E (smoke)  | `macos-latest`, Node 22             | ~3 min    |
| Build artefacts | matrix of macos/linux/windows    | ~5 min    |

A full live round-trip is *not* part of CI — it requires a Hermes
instance and a real network. It lives in `tests/integration/` for
on-demand use only.

## Adding a test for a new feature

1. **Pure logic** (no Electron, no IO) → `tests/unit/`. Vitest. Be
   strict about purity — if you find yourself mocking modules, you're
   in the wrong layer.
2. **Service with IO** → `tests/integration/` with the dependency
   injected as an option. Mirror the pattern in `hermes-client.test.ts`
   (fake WS) or `stt-service.test.ts` (fake spawn).
3. **End-to-end visible-to-user behaviour** → `tests/e2e/`. Don't be
   shy about adding here for important flows; the slow runtime is
   worth catching whole-system regressions.

The full suite must stay green before merging — `npm test` is the
gatekeeper.
