# Troubleshooting

## Pairing fails

**"O token não foi aceite. Verifica se o copiaste sem espaços."**
The bridge returned HTTP 401. Re-copy the token from the bottom of the `install.sh` banner — terminal soft-wraps sometimes split it across lines. Or `sudo cat /etc/hermes-voice-bridge/config.toml` on the server and copy from there.

**"Não consegui ligar. O endereço está certo e o serviço está a correr?"**
Likely `ECONNREFUSED`. Check on the server:

```bash
systemctl status hermes-voice-bridge
curl http://localhost:8765/healthz       # should print {"ok": true, ...}
```

If the service is dead, look at `journalctl -u hermes-voice-bridge -n 80`.

**"O certificado do servidor não é de confiança."**
You're connecting via `wss://` to a server with a self-signed cert. Either use `ws://` (only safe on a trusted LAN) or get a proper certificate.

## "Whisper local ainda não está instalado"

The `whisper.cpp` binary isn't on disk. You have two options:

1. **Easiest**: open Definições → Reconhecimento and switch to "OpenAI Whisper API". Paste your API key.
2. **Local install**: build [whisper.cpp](https://github.com/ggerganov/whisper.cpp) and put the resulting `main` binary at `<userData>/whisper/bin/whisper`. The model file `ggml-base.bin` will auto-download from Hugging Face on first run.

(`<userData>` is `~/Library/Application Support/Voice Gateway` on macOS, `~/.config/Voice Gateway/` on Linux, `%APPDATA%\Voice Gateway\` on Windows.)

## "Piper local não está instalado"

Same idea as Whisper. Easiest fix: switch to ElevenLabs in Definições → Voz. For local: install [piper](https://github.com/rhasspy/piper) and drop the binary + a voice (`.onnx` + `.onnx.json`) into `<userData>/piper/`.

## Wake word doesn't trigger

**Status says "Não consegui iniciar o detector"**: the Python runner couldn't import its deps. Install them:

```bash
python3 -m pip install -r resources/python/requirements.txt
```

(or in a venv if you prefer). Then toggle the activation mode off and back to Wake Word in Definições.

**Detector starts but never triggers**: lower the threshold in `wake_word_runner.py` (default `0.5`) or try a different model — *Hey Jarvis* trains better than *Computer*.

## Audio is choppy / out of sync

- The renderer's audio worklet downsamples to 16 kHz with a simple linear interpolator. If you see distortion, try unchecking *autoGainControl* in your OS sound settings.
- TTS playback for ElevenLabs decodes the full MP3 once the stream ends. For low-latency TTS, prefer Piper (PCM streaming).
- A high latency indicator in the header (>300 ms) usually means Wi-Fi packet loss between the desktop and the bridge. Hard-wire the server if you can.

## Hotkey doesn't work

- Default is `Cmd+Shift+H` (macOS) / `Ctrl+Shift+H` (Linux/Windows). If another app already owns that combo Electron silently fails to register — the main-process log shows `[VG] global hotkey already in use`. Change the binding in Definições → Ativação.
- On macOS, the first time you press the hotkey the system prompts for "Input Monitoring" permission. Grant it once.

## Settings got into a weird state

```bash
# macOS
rm -rf "~/Library/Application Support/Voice Gateway"
# Linux
rm -rf ~/.config/Voice\ Gateway
# Windows
rd /s /q "%APPDATA%\Voice Gateway"
```

Then relaunch. The pairing wizard appears again.

## "WebSocket reconnect" loops in the log

`[VG] hermes reconnect in 500 ms (attempt 1)` is normal once or twice after the laptop wakes from sleep. If it goes past attempt 6 you're hitting the cap (~16 s between tries) and the server is genuinely down. Same triage as the pairing failure above.

## Filing bugs

Logs live at:

- macOS: `~/Library/Logs/Voice Gateway/main.log`
- Linux: `~/.config/Voice Gateway/logs/main.log`
- Windows: `%APPDATA%\Voice Gateway\logs\main.log`

When opening an issue please include the last ~100 lines.
