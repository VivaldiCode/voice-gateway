<p align="center">
  <img src="https://raw.githubusercontent.com/VivaldiCode/voice-gateway/main/resources/icon.svg" alt="Voice Gateway" width="128" height="128" />
</p>

# Voice Gateway Wiki

Talk to your self-hosted [Hermes agent](https://hermes-agent.nousresearch.com/)
by voice — push-to-talk or wake word, with **local-first** STT/TTS and
optional cloud upgrades. No API keys required to get a first conversation
going.

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

## Where to start

- New to the project? Go to **[[Setup]]** — gets you to "olá Hermes" in
  under 5 minutes.
- Something broke? **[[Troubleshooting]]** has the common failure modes.
- Curious about the design? **[[Architecture]]** explains the module map and
  why the boundaries are where they are.
- Writing an alternative client or server? **[[Protocol]]** is the
  authoritative WebSocket spec.

## Local-first vs cloud

| Component | Local default                  | Cloud upgrade                       |
|-----------|--------------------------------|-------------------------------------|
| STT       | whisper.cpp (`base` ggml)      | OpenAI Whisper API                  |
| TTS       | Piper (`en_US-lessac-medium`)  | ElevenLabs (`eleven_turbo_v2_5`)    |
| Wake word | openWakeWord (Python)          | —                                   |

Cloud upgrades are opt-in: enabled in **Definições** once the user provides
a key. The app never phones home without explicit consent.

## Source

- Code: <https://github.com/VivaldiCode/voice-gateway>
- Bug tracker: <https://github.com/VivaldiCode/voice-gateway/issues>
- Releases: <https://github.com/VivaldiCode/voice-gateway/releases>
