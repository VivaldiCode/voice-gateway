# Renderer UI

A React 18 + TypeScript + Tailwind app rendered inside Electron's
sandboxed renderer process. It owns the visible surface of Voice
Gateway and the audio I/O (mic + speakers), and talks to the main
process exclusively through the
[[IPC-Layer|`window.vg` contextBridge surface]].

Entry points:

| File                                                                                                                                       | Purpose                                       |
|--------------------------------------------------------------------------------------------------------------------------------------------|-----------------------------------------------|
| [`main.tsx`](https://github.com/VivaldiCode/voice-gateway/blob/main/src/renderer/main.tsx)                                                | React root + global error boundary            |
| [`App.tsx`](https://github.com/VivaldiCode/voice-gateway/blob/main/src/renderer/App.tsx)                                                  | View router (main vs settings vs wizard)      |
| [`components/MainScreen.tsx`](https://github.com/VivaldiCode/voice-gateway/blob/main/src/renderer/components/MainScreen.tsx)              | Default chat surface                          |
| [`components/PairingWizard.tsx`](https://github.com/VivaldiCode/voice-gateway/blob/main/src/renderer/components/PairingWizard.tsx)        | First-run wizard                              |
| [`components/SettingsPanel.tsx`](https://github.com/VivaldiCode/voice-gateway/blob/main/src/renderer/components/SettingsPanel.tsx)        | Tabs: Voz, Microfone, Reconhecimento, Ativação, Conexão, Avançado |

## Two-window architecture

```mermaid
flowchart TB
    Main[Main window<br>BrowserWindow #1] -. ipcRenderer.send<br>open-window .-> SettingsWin[Settings window<br>BrowserWindow #2]
    Main --> Router[App.tsx<br>detectView]
    SettingsWin --> Router
    Router -- view=settings --> Panel[SettingsPanel]
    Router -- view=main && pairing --> Screen[MainScreen]
    Router -- view=main && !pairing --> Wizard[PairingWizard]
```

The `view` query parameter is set by `loadRendererInto(win, 'settings')`
in
[`src/main/index.ts`](https://github.com/VivaldiCode/voice-gateway/blob/main/src/main/index.ts).
A single `index.html` bundle serves both windows; the React tree
branches on `detectView()`.

## State management

We avoid a heavy global store. Two layers:

1. **Zustand for cross-component shared state** (settings snapshot,
   connection info). See
   [`store/app-store.ts`](https://github.com/VivaldiCode/voice-gateway/blob/main/src/renderer/store/app-store.ts).
2. **React hooks for view-local state** — `useConversation()`,
   `useSettings()`. Each owns its IPC subscriptions and cleans them up
   on unmount.

### `useConversation`

Source:
[`src/renderer/hooks/useConversation.ts`](https://github.com/VivaldiCode/voice-gateway/blob/main/src/renderer/hooks/useConversation.ts).

The hook that powers the whole call experience. Mounted once by
`MainScreen`. It:

1. Subscribes to FSM state, transcripts, response_text, tts_chunk,
   error, warning, connection status, hotkey, STT status.
2. Holds an `AudioPlayback` instance (created via `useMemo`).
3. Spins up a **fresh** `AudioCapture` on every `CAPTURING` entry
   (replacing the previous one is more bulletproof than reusing).
4. Calls `playback.beginUtterance()` when state → `SPEAKING`,
   `playback.endUtterance()` when state → `IDLE`/`LISTENING_WAKE`.
5. Returns the conversation API (`state`, `transcript`, `error`,
   `pressTalk`, `releaseTalk`, `cancel`, `bargeIn`).

```ts
useEffect(() => {
  if (state !== 'CAPTURING') {
    setLevel(0);
    return;
  }
  let cancelled = false;
  const cap = new AudioCapture();
  void cap.start({ deviceId: inputDeviceId ?? null }).then(() => {
    if (cancelled) { void cap.stop(); return; }
    cap.onFrame((frame) => {
      const copy = new ArrayBuffer(frame.byteLength);
      new Uint8Array(copy).set(new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength));
      window.vg.conversation.sendAudioFrame(copy);
    });
    cap.onLevel((rms) => { if (!cancelled) setLevel(rms); });
  }).catch((err) => {
    if (!cancelled) setError(`Não consegui aceder ao microfone: ${err.message}`);
  });
  return () => { cancelled = true; void cap.stop(); };
}, [state, inputDeviceId]);
```

The `cancelled` flag handles the press-then-release-fast race: if the
user releases PTT while `cap.start()` is still awaiting
`audioWorklet.addModule(...)`, the cleanup runs first and the
subsequent `.then()` callback bails out before attaching listeners to
a stopped capture. The audio-side mirror of this race is documented
in [[Audio-Pipeline#the-ptt-press-release-race]].

### `useSettings`

Source:
[`src/renderer/hooks/useSettings.ts`](https://github.com/VivaldiCode/voice-gateway/blob/main/src/renderer/hooks/useSettings.ts).

Two exported hooks:

- `useSettingsBootstrap()` — runs once at app start, fetches the
  current `Settings` and seeds the Zustand store, then subscribes to
  `vg:settings:changed` and keeps the store in sync.
- `useSettings()` — reads the snapshot from Zustand and exposes a
  typed `update(patch)` that calls `window.vg.settings.set(patch)`.

The Settings panel reads from this hook and writes through it; the
main process broadcasts back any deep-merged result so both windows
stay coherent.

## Components

### `Logo`

SVG-based wordmark + standalone glyph. Rendered in the header and on
the system tray icon. Source:
[`components/Logo.tsx`](https://github.com/VivaldiCode/voice-gateway/blob/main/src/renderer/components/Logo.tsx).

### `StateOrb`

The big circle in the middle that pulses based on FSM state:

| State          | Colour    | Animation                    |
|----------------|-----------|------------------------------|
| `IDLE`         | grey      | static                       |
| `LISTENING_WAKE` | grey + ring | slow pulse                 |
| `CAPTURING`    | green     | fast pulse, scaled by `level` |
| `STREAMING`    | yellow    | spinning                     |
| `THINKING`     | yellow    | spinning                     |
| `SPEAKING`     | purple    | wave animation               |
| `ERROR`        | red       | static                       |

`level` (RMS 0..1) comes from `useConversation` → `AudioCapture.onLevel`.

### `CallButton`

The round purple PTT button. Disabled when `connection.status !==
'connected'` OR (STT isn't ready AND we're not in ERROR — the carve-out
is the [[State-Machine#error-recovery-via-ptt|PTT-from-ERROR auto-recovery]]
path).

```ts
disabled={
  conv.connection.status !== 'connected' ||
  (conv.sttStatus.state !== 'ready' && conv.state !== 'ERROR')
}
```

Press/release map straight to `conv.pressTalk()` / `conv.releaseTalk()`,
which fire the IPC events that drive the [[Conversation-Orchestrator]].

### `TranscriptView`

Auto-scrolling transcript pane. Each turn shows the user's transcript
followed by the assistant's streaming reply. Empty turns (cancelled or
silent) are filtered out — `useConversation`'s response_text handler
skips empty deltas.

### `PairingWizard`

3-step flow:

1. **URL** → `window.vg.pair.test({ url, token: '' })` to validate the
   URL shape locally.
2. **Token + Test** → `window.vg.pair.test({ url, token })` opens a
   short-lived WS, expects `welcome`. On success, the button lights
   green. Errors map to friendly Portuguese (see
   [[IPC-Layer#pairing]]).
3. **Activation mode** → two cards (PTT / wake word). Selection just
   stages the choice; nothing is persisted until **Done!**.

On Done! it calls `window.vg.pair.save({...})` then sets pairing in
settings, which triggers the main process to `bootstrapConversation()`.

### `SettingsPanel`

A 6-tab single-window panel. Each tab is a controlled form that calls
`update({ … })` on change with a debounced flush (most settings persist
on blur, except booleans/selects which persist immediately).

| Tab            | Source                                                                                                                                            |
|----------------|---------------------------------------------------------------------------------------------------------------------------------------------------|
| Voz            | TTS provider switch, Piper voice picker, ElevenLabs key + catalogue, **voice-test textarea** (type a phrase, hit Reproduzir — uses `prepareTestText` from `shared/tts-test-text.ts` to sanitise + cap at 500 chars) |
| Microfone      | Input device dropdown, mic status pill (see [[macOS-Permissions#diagnostic-ui]]), live VU meter from `AudioCapture.onLevel`                       |
| Reconhecimento | STT provider switch, Whisper model size, language, OpenAI API key                                                                                 |
| Ativação       | PTT vs wake word, hotkey input, **Minimum audio length** slider (filters accidental taps)                                                         |
| Conexão        | Bridge URL + token (re-pair UI), shows current pairing status                                                                                     |
| Avançado       | "Factory reset" button (calls `window.vg.settings.reset()`)                                                                                       |

## Styling

Tailwind 3 with a small custom theme in
[`tailwind.config.cjs`](https://github.com/VivaldiCode/voice-gateway/blob/main/tailwind.config.cjs).
We use Tailwind utility classes throughout — no CSS Modules, no
styled-components.

The drag region for the frameless macOS window is opt-in via custom
classes in
[`styles/index.css`](https://github.com/VivaldiCode/voice-gateway/blob/main/src/renderer/styles/index.css):

```css
.vg-drag { -webkit-app-region: drag; }
.vg-no-drag { -webkit-app-region: no-drag; }
```

Combine them: any region marked `vg-drag` lets you drag the window;
any nested `vg-no-drag` (typically buttons) stays clickable.

## CSP

The renderer's HTML hardcodes a strict Content-Security-Policy:

```html
<meta http-equiv="Content-Security-Policy" content="
  default-src 'self';
  script-src 'self';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob:;
  media-src 'self' blob:;
  connect-src 'self';
" />
```

The `blob:` source on `media-src` is required by the audio-capture
worklet, which is loaded via `URL.createObjectURL(new Blob([source]))`
(see [[Audio-Pipeline#worklet-source-embedded-as-a-string]]).
`'unsafe-inline'` on `style-src` is needed because Tailwind's runtime
adds inline `<style>` tags.

## Stable visual test IDs

The E2E suite leans on a small set of `data-testid` attributes that
the renderer treats as **public contract**. Don't rename them without
updating the matching Playwright assertions — the suite (28 specs)
will fail loud.

| Test ID                       | Component        | What it surfaces                                   |
|-------------------------------|------------------|----------------------------------------------------|
| `call-button`                 | `CallButton`     | The PTT button; pointer events drive press/release |
| `state-orb`                   | `StateOrb`       | Wrapper div. Also carries `data-state="…"` (the live FSM state) for visual assertions |
| `transcript`                  | `TranscriptView` | The scroller container                             |
| `transcript-user` / `transcript-assistant` | (rows in TranscriptView) | One per turn; lets specs assert ordering + text |
| `connection-indicator`        | `MainScreen`     | "Ligado (N ms)" / "A ligar…" / "Sem ligação"       |
| `warning-toast` / `error-toast` | `MainScreen`   | The `CommandHint` banners. `warning-toast` auto-dismisses after 4 s |
| `tab-microfone` / `tab-voz` / `tab-ativacao` / `tab-avancado` etc. | `SettingsPanel` | One per tab in the Settings window |
| `mic-permission`              | `SettingsPanel`  | Carries `data-status="granted|denied|…"` for the macOS TCC pill |
| `mic-start-test` / `mic-stop-test` / `vu-meter` | Microfone tab | Live VU meter test ride |
| `output-device-select` / `output-test-button` | Microfone tab | Speaker picker + 440 Hz tone test |
| `tts-test-text` / `tts-test-button` / `tts-test-reset` / `tts-test-char-count` | Voz tab | Custom-text voice tester |
| `wake-phrase-input` / `wake-phrase-hint`     | Ativação tab     | Phrase mode input + validation hint |
| `wake-test-button` / `wake-test-stop` / `wake-test-status` / `wake-test-transcript` / `wake-tester` | Ativação tab | "Testar agora" panel for wake detection |
| `factory-reset` / `factory-reset-confirm`    | Avançado tab     | Two-step danger button |
| `url-next` / `token-next` / `probe-test` / `probe-result` / `finish-pairing` / `pairing-done` / `open-app` | `PairingWizard` | Step navigation + connection probe in the wizard |

### `state-orb`'s `data-state` attribute

In addition to the test ID, `StateOrb` exposes the **live FSM state**
as `data-state="IDLE" | "LISTENING_WAKE" | "CAPTURING" | "STREAMING" | "THINKING" | "SPEAKING" | "ERROR"`.
This is the visual contract for any styling test that wants to assert
"the orb turned green during capture" without screenshot comparison.

Note: the attribute reflects whatever the React tree re-rendered to,
which can race past STREAMING/THINKING faster than a 50 ms poll. If
you want to assert every transition was visited, read
`window.__vg_state_log` (populated by the rig's
`instrumentTtsCounter`) — that's event-driven and never misses.

## Testing

UI is exercised by Playwright at
[`tests/e2e/`](https://github.com/VivaldiCode/voice-gateway/tree/main/tests/e2e)
(launches the packaged app, drives the pairing wizard, presses the
call button, asserts the FSM state transitions). See
[[Testing-Guide#the-e2e-rig]] for the full setup.

Component unit tests live next to their components when sane (small
pure components like `Logo`, `Button`) and otherwise are folded into
the integration suite.
