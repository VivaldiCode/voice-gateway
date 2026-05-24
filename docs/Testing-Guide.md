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

## The E2E rig

Every Playwright spec talks to the **packaged** `.app` (not the dev
build) so we exercise the exact entitlements, signature, and
extra-resources layout a user installs. Almost everything they need is
in
[`tests/e2e/helpers/rig.ts`](https://github.com/VivaldiCode/voice-gateway/blob/main/tests/e2e/helpers/rig.ts).

### Anatomy of a typical spec

```ts
import { expect, test } from '@playwright/test';
import { MOCK_DEFAULT_TOKEN, startMockBridge } from '../integration/__mocks__/mock-bridge-server';
import { scriptedTextReply } from './helpers/mock-bridge-presets';
import { launchPackaged, packagedAppExists, type TestRig } from './helpers/rig';

test.describe('my new behaviour', () => {
  let rig: TestRig | null = null;

  test.beforeAll(() => {
    if (!packagedAppExists()) test.skip(true, 'run `npm run build:mac` first');
  });

  test.afterEach(async () => { await rig?.dispose(); rig = null; });

  test('does the thing', async () => {
    const bridge = await startMockBridge({
      onClientMessage: scriptedTextReply('hello from the mock'),
    });
    rig = await launchPackaged({
      bridgeUrl: bridge.url,
      bridgeToken: MOCK_DEFAULT_TOKEN,
    });
    // ... drive the UI via rig.mainWindow, assert what you need
    await bridge.close();
  });
});
```

`rig.dispose()` is idempotent and tears down both the Electron process
and the temp `userData` directory.

### What `launchPackaged` does for you

1. `mkdtemp` a fresh `userData` so tests don't see each other's state.
2. `writeSeedSettings(...)` — pre-populates electron-store with a valid
   pairing pointing at your mock bridge, so the app skips the wizard
   and lands on the main screen.
3. `electron.launch({...})` with sane defaults:
   - `--autoplay-policy=no-user-gesture-required` so `AudioContext` can
     start synthesising without a real click;
   - `--use-fake-device-for-media-stream` +
     `--use-file-for-fake-audio-capture=<wav>` if you pass
     `fakeAudioFile`. Chromium loops the WAV through every
     `getUserMedia` call.
4. Console forwarding (errors + warnings) onto the Playwright stdout.
   Set `VG_E2E_VERBOSE=1` to also forward `info`/`debug` and the
   main-process stderr — useful when a connection silently fails.

### `launchUnpaired`

For the PairingWizard specs — same as `launchPackaged` but without
seeding a `pairing`. The app boots straight to step 1 of the wizard.

### `openSettingsWindow(rig)`

Triggers the same IPC the gear icon uses and returns the freshly-opened
`BrowserWindow` `Page`, with the same log forwarding installed.

### `instrumentTtsCounter(page)` + `readVgStats(page)`

Subscribes (in-page) to `vg.conversation.onTtsChunk`,
`onResponseText`, `onState`, `onWarning`, `onError` and stashes them on
`window.__vg_*`. `readVgStats` returns the accumulated counts so
assertions like `expect.poll(() => readVgStats(page).chunks)` work.

### Mock-bridge presets

[`tests/e2e/helpers/mock-bridge-presets.ts`](https://github.com/VivaldiCode/voice-gateway/blob/main/tests/e2e/helpers/mock-bridge-presets.ts)
ships the common `onClientMessage` recipes:

| Preset                 | Behaviour                                                    |
|------------------------|--------------------------------------------------------------|
| `captureTranscripts(sink)` | Push every final transcript into the array.              |
| `scriptedTextReply(text)`  | On `end_turn`: thinking → response_text(final) → response_end. |
| `scriptedError({code,message})` | On `end_turn`: send an `error` frame. Used by the auto-recovery spec. |
| `sendServerAudio(ws, {…})` | One-shot helper for the binary-after-header audio path.   |
| `composeBridge(a, b, …)`   | Stack handlers — observe AND script.                      |

### Skipping STT cleanly: `VG_E2E_FAKE_TRANSCRIPT`

The behaviour specs that test the orchestrator pipeline (cancel,
barge-in, error recovery, multi-turn, …) don't want to depend on a
working whisper.cpp install. Set
`extraEnv: { VG_E2E_FAKE_TRANSCRIPT: 'olá' }` and the main process
swaps in a tiny in-process fake STT adapter that always returns the
env var as the transcript. Production code stays untouched when the
var isn't set; the branch lives in
[`src/main/index.ts → bootstrapConversation`](https://github.com/VivaldiCode/voice-gateway/blob/main/src/main/index.ts).

### Skipping the real wake-word runner: `VG_WAKE_E2E_FAKE`

Same idea for the wake-word path. With `VG_WAKE_E2E_FAKE=1`, main
spawns
[`resources/python/fake_wake_runner.py`](https://github.com/VivaldiCode/voice-gateway/blob/main/resources/python/fake_wake_runner.py)
instead of `wake_word_runner.py`. The fake speaks the same JSON
stdout protocol but emits `ready → wake` on a fixed timeline without
touching the microphone or any model.

### Fake-audio fixtures

Pre-recorded WAVs live in `tests/e2e/fixtures/`:

| File                  | Content                       | Use                           |
|-----------------------|-------------------------------|-------------------------------|
| `hi-how-are-you.wav`  | "HI! How are you today?"      | audio-conversation full turn  |
| `wake-phrase.wav`     | "hey hermes wake up please"   | reserved for future wake spec |

Recipe to regenerate on macOS:

```bash
say -v Samantha -o /tmp/x.aiff "HI! How are you today?"
afconvert /tmp/x.aiff -d LEI16 -c 1 -r 16000 -f WAVE tests/e2e/fixtures/hi-how-are-you.wav
```

Format: mono PCM16 @ 16 kHz, which is what `whisper-cli` expects.

### What the suite currently covers (43 specs)

```
tests/e2e/
├── audio-conversation.spec.ts          real-audio full turn (fake mic → whisper → bridge → Piper)
├── connection.spec.ts                  WS reconnect, wizard URL validation (2)
├── conversation-advanced.spec.ts       wake→full turn, MP3 server audio,
│                                       transcript rendering, re-pair mid-session (4)
├── conversation-extras.spec.ts         cancel, persistence, provider swap,
│                                       server PCM audio, factory reset (5)
├── conversation-flows.spec.ts          short tap, barge-in, error recovery,
│                                       multi-turn, settings broadcast (5)
├── mic-capture.spec.ts                 getUserMedia probe, real-mic RMS (2)
├── pairing.spec.ts                     wizard happy path, friendly error (2)
├── runtime-extras.spec.ts              output-device live-switch, error-toast
│                                       contents, wizard server_version (3)
├── runtime-protocol.spec.ts            error frame, audio backpressure (50 chunks),
│                                       capability negotiation, hotkey persist,
│                                       wake-event safety from non-rest states (5)
├── settings-audio.spec.ts              speaker selector, custom-text TTS test (2)
├── settings-deep.spec.ts               STT language, Piper voices, OpenAI key,
│                                       Re-emparelhar wizard surface (4)
├── visual-states.spec.ts               warning toast lifecycle, StateOrb attr (2)
├── wake-phrase-validation.spec.ts      validation hint + Testar enable/disable (1)
├── wake-word.spec.ts                   openww + phrase + tester reset (3)
└── wizard-nav.spec.ts                  back navigation preserves URL/token,
                                        token field is multi-line monospace (2)
```

43 specs totalling ~3 minutes for a full local run. The real-audio one
is the only slow case (~20 s — STT + Piper warmup); everything else is
<3 s each thanks to the fake STT / fake wake runner / mock bridge stack.

### `VG_E2E_TMPDIR` — relocate per-test userData to a roomier disk

The rig allocates a fresh `mkdtemp(userData)` per spec — on macOS the
default `os.tmpdir()` is `/var/folders/...` on the system volume. A
full 43-spec Playwright run plus electron-builder's DMG staging burns
through ~3-5 GB of system tmp; on low-disk systems this kills the run.

Set `VG_E2E_TMPDIR=/Volumes/<roomy-disk>/.vg-e2e` and the rig will
allocate userData directories there instead (with a fallback to
`os.tmpdir()` if the override isn't writable). Falls back silently —
no harm in setting it always.

### Shared spec helpers

[`tests/e2e/helpers/rig.ts`](https://github.com/VivaldiCode/voice-gateway/blob/main/tests/e2e/helpers/rig.ts)
ships these in addition to launch helpers:

| Helper                   | Purpose                                                        |
|--------------------------|----------------------------------------------------------------|
| `holdPtt(page, ms)`      | Press → hold → release the call button via pointer events.     |
| `waitForState(page, [s])`| Poll `__vg_state_log` for one of the desired FSM states; throws an actionable error on timeout. |
| `instrumentTtsCounter`   | Subscribe in-page to TTS / state / warning / error events.     |
| `readVgStats(page)`      | Snapshot the accumulated counters + event log.                 |
| `sttReady(page)`         | Ask main if Whisper is wired (skip cleanly otherwise).         |
| `ttsReady(page)`         | Same, for Piper. Blocks while the venv auto-install runs on a fresh `userData`. |

[`tests/e2e/helpers/driver.ts`](https://github.com/VivaldiCode/voice-gateway/blob/main/tests/e2e/helpers/driver.ts)
exposes a fluent `ConversationDriver`:

```ts
const driver = await ConversationDriver.attach(rig.mainWindow);
await ttsReady(rig.mainWindow); // skip if Piper isn't installed
const stats = await driver.runTurn({ holdMs: 200, until: ['IDLE'] });
expect(stats.chunks).toBeGreaterThan(0);
```

`driver` is just sugar over `holdPtt` + `waitForState` + `readVgStats`,
but turns each spec body into a sequence of intent rather than
orchestration plumbing. Use `driver.pressPtt()` / `releasePtt()` for
barge-in / interrupt tests.

### Settings-store migration tests

[`tests/integration/settings-store.test.ts`](https://github.com/VivaldiCode/voice-gateway/blob/main/tests/integration/settings-store.test.ts)
covers the on-disk persistence + schema-migration path:

- v1 → v2 migration adds the new `wakeMode` + `wakePhrase` fields with
  defaults while keeping every other user-set field intact.
- v2 files round-trip untouched.
- `set()` writes survive a store re-creation against the same `cwd`.
- `reset()` wipes pairing and reverts `schemaVersion`.
- `onChange` listeners unregister cleanly.

The store gained a `createSettingsStore({ cwd })` option so tests can
point it at a `mkdtemp()` directory without spinning up Electron.

### When a spec fails

Playwright's
[`playwright.config.ts`](https://github.com/VivaldiCode/voice-gateway/blob/main/playwright.config.ts)
defaults to `trace: 'retain-on-failure'`, `screenshot: 'only-on-failure'`,
`video: 'retain-on-failure'`. After a failed local run:

```bash
ls test-results/
# pick the failing test's directory, then:
npx playwright show-trace test-results/<dir>/trace.zip
```

The trace viewer shows every network call, IPC payload, and DOM state
at each step — usually enough to spot the broken assumption.
