# Voice Gateway — Progress

Sessão iniciada em 2026-05-22.

## Phases

### Phase 0 — Scaffold
Status: in progress.

### Phase 1 — Shared types + FSM
Status: pending.

### Phase 2 — Settings + PairingWizard
Status: pending.

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
- **Build tool**: `electron-vite` (mais limpo que `vite-plugin-electron` para projectos main+preload+renderer).
- **Electron version**: 33.x (estável em Jan 2026, suporta Node 20+).
- **React**: 18.3 (não 19 — ecosystem ainda em transição em Jan 2026, especialmente shadcn).
- **Node native modules**: evitados quando possível para simplificar packaging cross-platform.
- **Logger**: `electron-log` no main, prefix `[VG]` no renderer.

## Issues / blockers
(nenhum por enquanto)
