# Voice Gateway — Progress

Sessão iniciada em 2026-05-22.

## Phases

### Phase 0 — Scaffold ✅
- Electron 33 + Vite + React 18 + TS strict + Tailwind + Vitest + Playwright + ESLint/Prettier.
- `npm run dev` / `npm run build` / `npm test` / `npm run typecheck` / `npm run lint` todos verde.

### Phase 1 — Shared types + FSM ✅
- `src/shared/{constants,protocol,types,state-machine}.ts`.
- 46 testes vitest verde (28 FSM, 18 protocol).

### Phase 2 — Settings + PairingWizard ✅
- `electron-store` wrapper com deep-merge, defaults e schema versioning.
- IPC handlers `vg:settings:*`, `vg:pair:test`, `vg:pair:save` com mensagens de erro em PT.
- Zustand store + `useSettingsBootstrap` hook.
- `PairingWizard` 3-step (URL → token → modo) + ecrã "Pronto!".
- Mock bridge WS em `tests/integration/__mocks__/mock-bridge-server.ts`.
- 9 testes integration + 2 testes Playwright E2E verde.

### Phase 3 — WS client
Status: pending.

### Phase 4 — Audio capture + STT
Status: pending.

### Phase 5 — TTS + playback
Status: pending.

### Phase 6 — End-to-end PTT
Status: pending.

### Phase 7 — Wake word
Status: pending.

### Phase 8 — Server bridge + install.sh
Status: pending.

### Phase 9 — Documentation
Status: pending.

### Phase 10 — Quality gates
Status: pending.

## Decisões transversais
- **Build tool**: `electron-vite`. Preload tem de ser emitido como **CJS** (`.cjs`) porque com `sandbox:true` o renderer não consegue carregar preloads ESM.
- **Electron version**: 33.4.
- **React**: 18.3.
- **Logger**: `electron-log` no main, prefix `[VG]` no renderer.
- **Mock bridge**: rejeita tokens errados via `verifyClient` → HTTP 401 (assim o cliente recebe `unexpected-response` em vez de fechar silencioso).
- **Wizard lifecycle**: o wizard mantém-se montado até o utilizador clicar "Abrir Voice Gateway" — não dispensa automaticamente quando o pairing é gravado. Caso contrário, a atualização do `settings` substituiria o componente antes do ecrã "Pronto!".

## Issues / blockers
- O drive externo é HFS+ ou exFAT — gera ficheiros `._*` (resource forks) sempre que o macOS toca em ficheiros. Adicionado ao `.gitignore` e excluído do vitest. Limpos periodicamente com `find . -name '._*' -delete`.
