# Voice Gateway

Talk to your self-hosted [Hermes agent](https://hermes-agent.nousresearch.com/) by voice — push-to-talk or wake word, with **local-first** STT/TTS and optional cloud upgrades. No API keys required to get a first conversation going.

```
┌──────────────────────────────────────────────────────────────┐
│                    Voice Gateway (Desktop)                    │
│  React UI ──IPC── Electron Main ──audio/STT/TTS── Workers    │
└──────────────────────────────┬───────────────────────────────┘
                               │ WebSocket (Bearer-auth)
                               ▼
┌──────────────────────────────────────────────────────────────┐
│              hermes-voice-bridge (your server)                │
│      aiohttp WS server  ◄───►  Hermes Agent REST API          │
└──────────────────────────────────────────────────────────────┘
```

## Quick start

### 1. Install the bridge on your Hermes server (Linux)

```bash
curl -fsSL https://raw.githubusercontent.com/VivaldiCode/voice-gateway/main/server/install.sh | bash
```

The script is interactive: it prompts for the bridge port (default `8765`) and your local Hermes API URL (default `http://localhost:8000`). At the end it prints a one-line **pairing token** — keep it handy.

### 2. Install the desktop app

```bash
git clone https://github.com/VivaldiCode/voice-gateway.git
cd voice-gateway
npm install
npm run build:mac     # or build:linux / build:win
open release/*.dmg    # macOS
```

### 3. Pair

Open the app. The first-run wizard asks for:

1. the bridge URL (e.g. `ws://192.168.1.10:8765`)
2. the pairing token from step 1
3. how you want to talk: push-to-talk button or wake word

Then say "hello".

## Documentation

- [SETUP](docs/SETUP.md) — end-to-end walkthrough with screenshots.
- [PROTOCOL](docs/PROTOCOL.md) — the WebSocket message types.
- [ARCHITECTURE](docs/ARCHITECTURE.md) — why the code is shaped this way.
- [TROUBLESHOOTING](docs/TROUBLESHOOTING.md) — when something doesn't work.

## Local-first vs cloud

| Component | Local default            | Cloud upgrade            |
|-----------|--------------------------|--------------------------|
| STT       | whisper.cpp (`base` ggml) | OpenAI Whisper API       |
| TTS       | Piper (`en_US-lessac-medium`) | ElevenLabs (`eleven_turbo_v2_5`) |
| Wake word | openWakeWord (Python)    | —                        |

Cloud upgrades are opt-in: enabled in Definições once the user provides a key. The app never phones home without explicit consent.

## Development

```bash
npm run dev         # electron-vite dev server + hot reload
npm run typecheck   # tsc --noEmit on main + renderer
npm run lint        # eslint --max-warnings=0
npm test            # vitest (unit + integration)
npm run test:e2e    # playwright + electron
npm run build       # production build into out/
npm run build:mac   # → release/*.dmg
```

Server bridge:

```bash
cd server/hermes-voice-bridge
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
pytest                                # 13 tests
HERMES_VOICE_BRIDGE_CONFIG=dev-config.toml hermes-voice-bridge
```

## License

MIT.
