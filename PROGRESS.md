# Voice Gateway — Progress

Sessão iniciada em 2026-05-22.

## Phases

### Phase 0 — Scaffold ✅
- Electron 33 + Vite + React 18 + TS strict + Tailwind + Vitest + Playwright + ESLint/Prettier.
- `npm run dev` / `npm run build` / `npm test` / `npm run typecheck` / `npm run lint` todos verde.

### Phase 1 — Shared types + FSM ✅
- `src/shared/{constants,protocol,types,state-machine}.ts`.
- 46 testes vitest (28 FSM, 18 protocol).

### Phase 2 — Settings + PairingWizard ✅
- `electron-store` wrapper com deep-merge, defaults e schema versioning.
- IPC handlers `vg:settings:*`, `vg:pair:test`, `vg:pair:save` com mensagens de erro em PT.
- Zustand store + `useSettingsBootstrap` hook.
- `PairingWizard` 3-step (URL → token → modo) + ecrã "Pronto!".
- Mock bridge WS em `tests/integration/__mocks__/mock-bridge-server.ts`.
- 9 testes integration + 2 testes Playwright E2E.

### Phase 3 — WS client ✅
- `HermesClient` EventEmitter com reconnect exponencial, heartbeat ping/pong, capability negotiation, audio binário emparelhado com header JSON.
- 11 testes integration (handshake, status, auth reject, reconnect, sticky disconnect, audio, errors).

### Phase 4 — Audio capture + STT ✅
- `SttAdapter` + `OpenAIWhisperAdapter` (fetch) + `WhisperLocalAdapter` (spawn whisper.cpp via stdin WAV).
- `AudioCapture` no renderer: AudioWorklet → mono PCM16 16k em frames de 20ms.
- 11 testes integration.

### Phase 5 — TTS + playback ✅
- `TtsAdapter` + `PiperAdapter` (spawn → PCM16 22.05k) + `ElevenLabsAdapter` (streaming MP3 com abort para barge-in).
- `AudioPlayback` no renderer: scheduling PCM sample-accurate + decode MP3 em bloco.
- 9 testes integration.

### Phase 6 — End-to-end PTT ✅
- `ConversationOrchestrator` que junta FSM + WS + STT + TTS + audio buffering por turno.
- UI: `StateOrb`, `CallButton`, `TranscriptView`, `MainScreen`, `useConversation` hook.
- Tray (show/hide/quit) + global hotkey.
- 9 testes orchestrator + E2E atualizado.

### Phase 7 — Wake word ✅
- `resources/python/wake_word_runner.py` — openwakeword + sounddevice, JSON-line stdout.
- `WakeWordService` no main que faz spawn e re-emite eventos tipados.
- Integrado no main: liga/desliga conforme `settings.activation.mode`.
- 5 testes vitest.

### Phase 8 — Server bridge + install.sh ✅
- `server/hermes-voice-bridge/` — aiohttp WS server, Bearer auth com compare constant-time, hermes_adapter com parser SSE tolerante.
- 13 testes pytest verde.
- systemd unit hardened + `install.sh` idempotente + `uninstall.sh`.

### Phase 9 — Docs ✅
- `README.md`, `docs/SETUP.md`, `docs/PROTOCOL.md`, `docs/ARCHITECTURE.md`, `docs/TROUBLESHOOTING.md` com conteúdo real.

### Phase 10 — Quality gates
Status: in progress.

## Decisões transversais
- **electron-vite** com preload emitido como **CJS** (`.cjs`) — sandbox:true não carrega preloads ESM.
- **Electron 33.4**, **React 18.3**, **TypeScript strict + noUncheckedIndexedAccess**.
- **Adapter pattern** para tudo o que é externo (STT/TTS/wake) — facilita mocks e troca de provider sem mexer na orquestração.
- **Mock bridge**: rejeita tokens errados via `verifyClient` → HTTP 401 (cliente recebe `unexpected-response` em vez de `close` silencioso).
- **Wizard lifecycle**: mantém-se montado até "Abrir Voice Gateway" — não dispensa quando o pairing é gravado.
- **Bridge install.sh**: idempotente; preserva o token em re-install (lendo do `config.toml` existente).
- **FSM order na barge-in**: dispatch antes do `tts.stop()` para um `'end'` síncrono do TTS não saltar fora de SPEAKING.

## Issues / blockers encontrados e resolvidos
- Drive externo gera resource forks `._*`. Adicionado ao `.gitignore`, vitest exclude, limpeza periódica.
- `nodejs-whisper` evitado (postinstall pesado). `WhisperLocalAdapter` espera binário em `userData/whisper/bin/whisper`; auto-download do modelo na primeira preparação.
- pyenv local tinha `.pth` files binários (PyTorch). Tests Python correram com `/opt/homebrew/bin/python3.13`.
- pytest precisava `pytest-aiohttp` para a fixture `aiohttp_client`. Adicionado às dev deps.

## Conhecidos por preencher / runtime que requer hardware
- Whisper.cpp e Piper não são bundled — a app vive com cloud até o utilizador instalar localmente (ou nós escrevermos um "voice install" automático). Adaptadores devolvem erro em português a apontar para Definições.
- Captura de mic e playback Web Audio são puramente UI-driven; não testados end-to-end com mic real nesta sessão.
