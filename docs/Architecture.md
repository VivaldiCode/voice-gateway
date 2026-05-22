# Architecture

## High-level

```
┌──────────────────────────────────────────────────────────────────────┐
│                       Voice Gateway desktop app                       │
│  ┌──────────────┐  ┌────────────────┐  ┌───────────────────────────┐ │
│  │  Renderer    │  │  Main process  │  │  Spawned children          │ │
│  │  (React 18)  │  │  (Electron)    │  │  • python wake-word         │ │
│  │              │  │                │  │  • whisper.cpp (STT)        │ │
│  │  - StateOrb  │  │  - Settings    │  │  • piper (TTS)              │ │
│  │  - Wizard    │  │  - IPC bridge  │  └───────────────────────────┘ │
│  │  - useConv.. │◄►│  - WS client   │                                │
│  │  - audio I/O │  │  - FSM driver  │                                │
│  └──────────────┘  └────────┬───────┘                                │
└─────────────────────────────┼────────────────────────────────────────┘
                              │   WebSocket (Bearer-auth)
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│                         hermes-voice-bridge                           │
│  aiohttp WS server ◄───► HermesAdapter ◄───► your Hermes HTTP API     │
└──────────────────────────────────────────────────────────────────────┘
```

## Why these boundaries

- **Audio I/O in the renderer.** Microphone capture and Web Audio playback live in the renderer process because that's where `navigator.mediaDevices` and `AudioContext` live. The renderer streams frames to the main process via IPC as `ArrayBuffer`.
- **Pipeline state in the main process.** The `ConversationOrchestrator` owns the FSM, the `HermesClient`, the STT adapter, and the TTS adapter. This is the single source of truth for conversation state. The renderer is a view layer that subscribes to state events.
- **Heavy native bits as child processes.** whisper.cpp, piper, and openwakeword run as subprocesses behind small adapter interfaces. The main process pipes audio through them. This isolates native crashes from the Electron event loop, and makes each adapter trivially swappable / mockable.
- **Server bridge for the agent.** The desktop app never talks to Hermes directly. The bridge enforces auth and adapts whatever Hermes' real HTTP shape happens to be, so the protocol stays stable as Hermes evolves.

## Module map

```
src/
├── shared/           # ← imported by main, preload, renderer; no Node deps
│   ├── constants.ts        # IPC channels, audio rates, error codes
│   ├── protocol.ts         # WS message types + parsers + capability negotiation
│   ├── types.ts            # Settings, PairingInfo, ConnectionInfo, …
│   └── state-machine.ts    # pure FSM reducer (28 tests)
│
├── main/
│   ├── index.ts            # boot, window, hotkey, tray, pipeline wiring
│   ├── ipc-handlers.ts     # settings + pair-test/save handlers
│   ├── tray.ts             # menu bar / system tray
│   ├── global-shortcut.ts  # hotkey registration
│   └── services/
│       ├── settings-store.ts          # electron-store + deep-merge
│       ├── hermes-client.ts           # WS client (reconnect, heartbeat)
│       ├── stt-service.ts             # SttAdapter + Whisper + OpenAI
│       ├── tts-service.ts             # TtsAdapter + Piper + ElevenLabs
│       ├── wake-word-service.ts       # spawn supervisor for python runner
│       └── conversation-orchestrator.ts # FSM driver, glue
│
├── preload/
│   └── index.ts (compiled to index.cjs)  # contextBridge surface
│
└── renderer/
    ├── App.tsx
    ├── components/   # Wizard, MainScreen, StateOrb, CallButton, TranscriptView
    ├── hooks/        # useSettings, useConversation
    ├── lib/          # audio-capture.ts (AudioWorklet), audio-playback.ts
    └── store/        # Zustand
```

## Process-boundary cheat sheet

| Action                                  | Process                |
|-----------------------------------------|------------------------|
| Microphone capture / playback           | Renderer (Web Audio)   |
| Conversation FSM                        | Main                   |
| WebSocket to bridge                     | Main                   |
| STT (whisper.cpp or OpenAI API)         | Main                   |
| TTS (Piper or ElevenLabs)               | Main                   |
| Wake word (openwakeword)                | Spawned Python child   |
| Global hotkey                           | Main                   |
| Tray                                    | Main                   |
| settings.json storage                   | Main (electron-store)  |
| UI / state subscriptions                | Renderer (Zustand)     |

## Sandboxing notes

The preload script is compiled to **CommonJS** (`index.cjs`) — Electron with `sandbox: true` cannot load ESM preloads, and we use `contextIsolation: true` so the renderer only sees the explicit `window.vg` API surface.

The renderer's HTML CSP allows `ws:`, `wss:`, and `https:` for `connect-src` (the bridge URL is user-chosen) but blocks inline scripts entirely.

## Testability principles

1. The FSM is **pure** — same `(ctx, event, env)` always produces the same next context. 28 vitest cases pin its transitions.
2. External I/O lives behind adapter interfaces (`SttAdapter`, `TtsAdapter`, `wsFactory`, `spawnImpl`). Tests inject fakes. No mocking framework required.
3. The mock bridge in `tests/integration/__mocks__/mock-bridge-server.ts` is the same shape as the real bridge and is used by both vitest integration tests and Playwright E2E.
4. The renderer is decoupled from electron via `window.vg`. Components can be exercised by Playwright against the real Electron build (`tests/e2e/`).

## Why electron-vite (vs. vite-plugin-electron)

`electron-vite` natively understands the main/preload/renderer split, can run all three in one dev process with hot reload, and outputs the right module formats for each (ESM for main, **CJS for preload**, ESM bundle for renderer). It also wires the `ELECTRON_RENDERER_URL` env var so the main process knows whether to load a dev URL or a built `index.html`.
