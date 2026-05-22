# Setup guide

End-to-end installation, from a fresh Hermes server to a working voice conversation. Target: under 5 minutes from start to first "olá Hermes" answer.

## Prerequisites

**Server (Linux):**
- `python3` ≥ 3.10 with the `venv` module (`apt install python3-venv` on Debian/Ubuntu)
- `systemd` (any mainstream distro from the last decade)
- The Hermes agent reachable on a local HTTP port (default `http://localhost:8000`)
- Root or sudo

**Desktop (macOS / Linux / Windows):**
- Node.js ≥ 22 (only required if you build from source)
- For wake-word mode: `python3` ≥ 3.10 with `openwakeword` and `sounddevice` (auto-installed by the desktop installer on first run, or `pip install -r resources/python/requirements.txt`)

## Step 1 — Install the bridge

On the Hermes server:

```bash
curl -fsSL https://raw.githubusercontent.com/<user>/voice-gateway/main/server/install.sh | bash
```

Or from a checkout:

```bash
git clone https://github.com/<user>/voice-gateway
sudo bash voice-gateway/server/install.sh
```

The script prints:

```
╔══════════════════════════════════════════════════════════════╗
║              PAIRING TOKEN — copy to the desktop app             ║
╚══════════════════════════════════════════════════════════════╝

  Bridge URL:  ws://192.168.1.10:8765
  Token:       0f-...your-base64url-token...
```

Copy both.

### Verifying the bridge

```bash
systemctl status hermes-voice-bridge
journalctl -fu hermes-voice-bridge
curl http://localhost:8765/healthz    # → {"ok": true, "version": "0.1.0"}
```

### Adjusting Hermes API shape

The bridge expects:

```
POST {hermes_base_url}/chat
body: {"text": "...", "session_id": "...", "stream": true}
response: streamed lines of {"delta": "..."} (optional SSE `data:` prefix)
```

If your Hermes is shaped differently, edit `/opt/hermes-voice-bridge/src/hermes_voice_bridge/hermes_adapter.py` and `systemctl restart hermes-voice-bridge`. The contract is "yield text deltas as an async iterator" — anything beyond that is yours to change.

## Step 2 — Install the desktop app

```bash
git clone https://github.com/<user>/voice-gateway
cd voice-gateway
npm install
npm run build:mac        # creates release/*.dmg
open release/*.dmg
```

(Or use the pre-built `.dmg` / `.AppImage` / `.exe` from the GitHub release page.)

## Step 3 — First run

Open Voice Gateway. The first-run wizard appears:

1. **Onde está o teu Hermes?** Paste the bridge URL.
2. **Cola o token de pairing** Paste the token, click **Testar ligação**. A green confirmation appears when the bridge accepts you.
3. **Como queres falar com o Hermes?**
   - **Botão para falar** — recommended. The mic only listens when you hold the on-screen button or press `Cmd+Shift+H` (`Ctrl+Shift+H` on Linux/Windows).
   - **Sempre à escuta** — passive listening with `openwakeword`. Pick a wake word: *Hey Jarvis*, *Alexa*, *Hey Mycroft*, *Hey Rhasspy*, or *Computer*.

Click **Pronto!** → **Abrir Voice Gateway**.

## Step 4 — Say something

Hold the call button (or press the hotkey), speak, release. The orb cycles: 🟢 listening → 🟡 thinking → 🟣 speaking → idle. The transcript appears in real time.

To **interrupt** the assistant mid-response (barge-in), just press the hotkey again — the playback stops and the mic re-opens.

## Wake-word mode

Wake word runs a separate Python process that owns the microphone permanently. The Voice Gateway icon in the system tray turns green when the detector is alive. Detection triggers the same "capture → STT → WS → response" pipeline as PTT.

If you see *"Não consegui iniciar o detector"*: install the requirements manually.

```bash
python3 -m pip install -r resources/python/requirements.txt
```

## Switching providers

In **Definições → Voz** you can swap Piper for ElevenLabs (paste an API key, pick a voice). In **Definições → Reconhecimento** you can swap whisper.cpp for the OpenAI Whisper API. Both are opt-in; the app keeps running 100% locally otherwise.
