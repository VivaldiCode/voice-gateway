# Troubleshooting

Common symptoms and what they mean. For each, there's a "what to check"
list and a pointer to the wiki page that explains the underlying
machinery in detail.

## Pairing fails

### "O token não foi aceite. Verifica se o copiaste sem espaços."

The bridge returned HTTP 401. Re-copy the token from the bottom of the
`install.sh` banner — terminal soft-wraps sometimes split it across
lines. Or `sudo cat /etc/hermes-voice-bridge/config.toml` on the
server and copy from there.

### "Não consegui ligar. O endereço está certo e o serviço está a correr?"

Likely `ECONNREFUSED`. Check on the server:

```bash
systemctl status hermes-voice-bridge
curl http://localhost:8765/healthz       # → {"ok": true, ...}
```

If the service is dead, look at `journalctl -u hermes-voice-bridge -n 80`.

### "O servidor respondeu mas não há um bridge nesse endereço."

You typed the wrong path (HTTP 404). The bridge mounts WS on `/ws`
only. The client auto-appends `/ws` if missing (see
[[WebSocket-Client#url-normalisation]]) — this message means the URL
**plus** the auto-`/ws` still 404s.

### "O certificado do servidor não é de confiança."

You're connecting via `wss://` to a server with a self-signed cert.
Either use `ws://` (only safe on a trusted LAN) or get a proper
certificate.

## "Whisper local ainda não está instalado"

The `whisper.cpp` binary isn't on disk. You have three options:

1. **Easiest**: open Definições → Reconhecimento and switch to
   "OpenAI Whisper API". Paste your API key.
2. **Homebrew (macOS)**: `brew install whisper-cpp`. The app will
   auto-detect it on PATH at next startup.
3. **From source**: build
   [whisper.cpp](https://github.com/ggerganov/whisper.cpp) and put the
   resulting `whisper-cli` (formerly `main`) binary at
   `<userData>/whisper/bin/whisper`. The model file `ggml-base.bin`
   auto-downloads from Hugging Face on first use.

(`<userData>` is `~/Library/Application Support/Voice Gateway` on
macOS, `~/.config/Voice Gateway/` on Linux, `%APPDATA%\Voice Gateway\`
on Windows.)

See [[Speech-To-Text#whisper-local-whispercpp]] for the binary
discovery order.

## "Piper local não está instalado"

The default `autoInstall: true` config means the app should create a
Python venv at `<userData>/piper/venv` on first use. If that fails:

1. **Easiest**: switch to ElevenLabs in Definições → Voz. Paste an
   API key.
2. **Manual**: `pip3 install --user piper-tts` in a terminal, then
   restart the app.

See [[Text-To-Speech#auto-install-the-venv-dance]] for what should
happen on first run.

## Text appears but no audio

The most common cause is the bridge sending `response_end`
synchronously with `response_text final=true`. The orchestrator
holds the FSM in `SPEAKING` while local TTS is synthesising and
defers the `response_end` dispatch until TTS emits its own `end`
event — see
[[Conversation-Orchestrator#the-response_end-race]] for details.

If you still see no audio after that:

1. **Confirm Piper is producing chunks.** Open
   `~/Library/Logs/Voice Gateway/main.log` and look for
   `[VG] piper:` debug lines (sample-output) immediately after
   `response_text final=true`.
2. **Confirm chunks reach the renderer.** Open DevTools (Cmd+Option+I)
   on the main window, watch the console for "tts_chunk" logs.
3. **Confirm AudioContext is running.** In DevTools console:
   ```js
   document.querySelector('audio')  // null is expected — we use AudioBufferSourceNode
   // Better:
   getAudioContextState()           // exposed by AudioPlayback in debug builds
   ```
4. **The AudioContext is suspended.** Chromium's autoplay policy
   suspends contexts that aren't created during a user gesture. Make
   sure you clicked the PTT button (don't just press the global
   hotkey for the very first turn — the gesture has to be inside the
   page).

## "hermes returned 401: Invalid API key"

Your bridge is talking to a Hermes that requires an API key, but you
didn't set one in the install. Edit
`/etc/hermes-voice-bridge/config.toml`:

```toml
[hermes]
api_key = "sk-..."
```

then `sudo systemctl restart hermes-voice-bridge`. The desktop will
reconnect automatically.

## Bridge round-trip test times out

```
Error: bridge round-trip timed out after 90000 ms — trace: welcome, thinking
```

This means the bridge accepted the request, sent `thinking`, but
Hermes never produced text within 90 s. Two real causes:

1. **Hermes is slow on cold start.** Some models take 30–60 s to
   warm up after `systemctl restart hermes`. Wait a minute, retry.
2. **Hermes returned 200 but with an empty body.** Check
   `journalctl -fu hermes-voice-bridge` — you'll see one of:
   ```
   hermes responded 200 (Content-Type=text/event-stream)
   hermes stream done — 0 delta(s), 0 chars total
   hermes non-stream fallback OK — N chars
   ```
   The third line means the fallback path saved you. If you see
   "non-stream fallback parsed but no message content" the model is
   genuinely producing nothing — check the agent's own log.

Override the timeout for very-slow setups:

```bash
VG_BRIDGE_TIMEOUT_MS=180000 \
VG_BRIDGE_URL=ws://… VG_BRIDGE_TOKEN=… \
npm test -- tests/integration/bridge-text-roundtrip.test.ts
```

## Wake word doesn't trigger

### Status says "Não consegui iniciar o detector"

The Python runner couldn't import its dependencies. Install them:

```bash
python3 -m pip install -r resources/python/requirements.txt
```

(or in a venv if you prefer). Then toggle the activation mode off and
back to Wake Word in Definições.

### Detector starts but never triggers

Lower the threshold in
[`wake_word_runner.py`](https://github.com/VivaldiCode/voice-gateway/blob/main/resources/python/wake_word_runner.py)
(default `0.5`) or try a different model — "Hey Jarvis" trains better
than "Computer".

See [[Wake-Word-Detection]] for the JSON line protocol.

## Audio is choppy / out of sync

- The renderer's audio worklet downsamples to 16 kHz with a simple
  linear interpolator (see [[Audio-Pipeline#capture]]). If you see
  distortion, try unchecking *autoGainControl* in your OS sound
  settings.
- TTS playback for ElevenLabs decodes the full MP3 once the stream
  ends. For low-latency TTS, prefer Piper (PCM streaming).
- A high latency indicator in the header (>300 ms) usually means
  Wi-Fi packet loss between the desktop and the bridge. Hard-wire the
  server if you can.

## Microphone permission

### "Não consegui aceder ao microfone: Failed to construct 'AudioWorkletNode'"

You hit the PTT-release race documented in
[[Audio-Pipeline#the-ptt-press-release-race]]. Should be fixed in the
shipping version; if you see it on the latest, file an issue with
the log line preceding the error (likely shows a fast
press → release pattern).

### "Permissão de microfone negada"

System Settings → Privacy → Microphone → toggle Voice Gateway on. If
the toggle is missing entirely, the app's bundle signature is broken —
see [[macOS-Permissions]] for the full triage.

### Permission was granted but now the prompt comes back every launch

The bundle's Designated Requirement changed (rebuild signed differently).
Run `codesign -dr- "/Applications/Voice Gateway.app"` — the identifier
should print as `dev.voicegateway.app`. If it says `Electron`, the
post-build re-sign didn't happen — see
[[Build-And-Packaging#macos-code-signing]].

## Hotkey doesn't work

- Default is `Cmd+Shift+H` (macOS) / `Ctrl+Shift+H` (Linux/Windows). If
  another app already owns that combo, Electron silently fails to
  register — the main-process log shows
  `[VG] global hotkey already in use`. Change the binding in
  Definições → Ativação.
- On macOS, the first time you press the hotkey the system prompts
  for "Input Monitoring" permission. Grant it once.

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

The Settings panel also has an **Avançado → Factory reset** button
that does the same thing without leaving the app.

## "WebSocket reconnect" loops in the log

`[VG] hermes reconnect in 500 ms (attempt 1)` is normal once or twice
after the laptop wakes from sleep. If it goes past attempt 6 you're
hitting the cap (~16 s between tries) and the server is genuinely
down. Same triage as the pairing failure above.

See [[WebSocket-Client#reconnect-backoff]] for the full ladder.

## Build fails fast with MODULE_NOT_FOUND inside node_modules

Symptom: `npm run build:mac` aborts after `electron-vite build` finishes
with something like:

```
Error: Cannot find module '/.../node_modules/builder-util/node_modules/fs-extra/lib/index.js'.
Please verify that the package.json has a valid "main" entry
  code: 'MODULE_NOT_FOUND',
  requestPath: 'fs-extra'
```

The `package.json` referenced in the error is usually present — only
one or two files inside the package have vanished. The root cause is
typically the repo living on an external volume whose filesystem
(exFAT, MS-DOS) doesn't preserve POSIX metadata reliably; individual
nested files drop out without the surrounding tree being broken. APFS
volumes don't exhibit this.

### What to do

The `tools/build-doctor.cjs` pre-flight (wired into `build:mac`,
`build:linux`, `build:win`) detects the most commonly affected paths
and prints the exact recovery command — usually:

```bash
rm -rf node_modules/<pkg>/node_modules/<dep>
npm install
```

…which takes ~10 s and avoids the alternative (`rm -rf node_modules &&
npm ci`) that can need >10 min and several GB of free disk.

### If the doctor passes but the build still fails this way

You hit a path the doctor doesn't know about yet. Two steps:

1. Read the failing path out of the error message.
2. Add it to `CRITICAL_FILES` in
   [`tools/build-doctor.cjs`](https://github.com/VivaldiCode/voice-gateway/blob/main/tools/build-doctor.cjs)
   in the same PR that documents the new failure mode.

See [[Build-And-Packaging#build-doctor-pre-flight]] for the rationale.

## Filing bugs

Logs live at:

- macOS: `~/Library/Logs/Voice Gateway/main.log`
- Linux: `~/.config/Voice Gateway/logs/main.log`
- Windows: `%APPDATA%\Voice Gateway\logs\main.log`

When opening an issue please include the last ~100 lines plus the
output of:

```bash
codesign -dv "/Applications/Voice Gateway.app"   # macOS only
systemctl status hermes-voice-bridge             # on the server
journalctl -u hermes-voice-bridge -n 40
```

File issues at
<https://github.com/VivaldiCode/voice-gateway/issues>.
