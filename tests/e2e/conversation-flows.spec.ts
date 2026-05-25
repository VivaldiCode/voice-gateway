/**
 * Behavioural E2E coverage for the conversation pipeline beyond the
 * happy-path turn in `audio-conversation.spec.ts`. None of these specs
 * depend on local whisper/piper — they drive the FSM via:
 *
 *   - injected transcripts (`vg.conversation` does not expose this, so we
 *     instead inject a fake STT via the existing test rig's
 *     `VG_E2E_FAKE_TRANSCRIPT` env var — see main/index.ts);
 *   - a scripted mock bridge that can reply with text, error, or refuse
 *     to respond depending on what the test needs.
 *
 * The added env-var hook means production code stays untouched: when
 * `VG_E2E_FAKE_TRANSCRIPT` is unset the orchestrator builds the real STT
 * adapter; when it's set, it builds a tiny in-process fake that always
 * returns the value of the var as the transcript.
 */
import { expect, test } from '@playwright/test';
import {
  MOCK_DEFAULT_TOKEN,
  startMockBridge,
  type MockBridge,
} from '../integration/__mocks__/mock-bridge-server';
import type { ServerMessage } from '../../src/shared/protocol';
import { join } from 'node:path';
import {
  FIXTURES_DIR,
  holdPtt,
  instrumentTtsCounter,
  launchPackaged,
  openSettingsWindow,
  packagedAppExists,
  readVgStats,
  waitForState,
  type TestRig,
} from './helpers/rig';

const FAKE_AUDIO = join(FIXTURES_DIR, 'hi-how-are-you.wav');

const FAKE_TRANSCRIPT = 'olá hermes responde sff';

test.describe('conversation flows — packaged app', () => {
  let rig: TestRig | null = null;
  let bridge: MockBridge | null = null;

  test.beforeAll(() => {
    if (!packagedAppExists()) {
      test.skip(true, 'Packaged app missing. Run `npm run build:mac` first.');
    }
  });

  test.afterEach(async () => {
    await rig?.dispose();
    rig = null;
    await bridge?.close();
    bridge = null;
  });

  // ───── #21: short capture is silently filtered → warning, no STT, no Hermes
  test('short PTT tap surfaces a warning, never reaches the bridge', async () => {
    let bridgeTranscripts = 0;
    bridge = await startMockBridge({
      onClientMessage: (raw) => {
        const m = raw as { type?: string; final?: boolean };
        if (m.type === 'transcript' && m.final) bridgeTranscripts += 1;
      },
    });
    rig = await launchPackaged({
      bridgeUrl: bridge.url,
      bridgeToken: MOCK_DEFAULT_TOKEN,
      // Force a strict minimum so anything under 500 ms is rejected.
      activation: { minAudioMs: 500 },
      // Fake transcript → would normally produce a turn, but minAudioMs
      // filters first so the STT is never invoked.
      extraEnv: { VG_E2E_FAKE_TRANSCRIPT: 'should never reach bridge' },
    });
    const { mainWindow } = rig;

    await expect(mainWindow.getByTestId('call-button')).toBeVisible({ timeout: 15_000 });
    await instrumentTtsCounter(mainWindow);

    // Press for ~80 ms — well under the 500 ms threshold.
    await holdPtt(mainWindow, 80);

    // Warning event must arrive within a couple of seconds.
    await expect
      .poll(async () => (await readVgStats(mainWindow)).warnings.length, { timeout: 5_000 })
      .toBeGreaterThan(0);

    const stats = await readVgStats(mainWindow);
    expect(stats.warnings.join('|')).toMatch(/curt[ao]|short|premido/i);
    expect(stats.errors).toHaveLength(0);
    expect(bridgeTranscripts).toBe(0);

    // App must return to IDLE — no stuck SPEAKING / THINKING.
    await waitForState(mainWindow, ['IDLE'], { timeoutMs: 5_000 });
  });

  // ───── #20: barge-in mid-utterance
  test('barge-in during SPEAKING starts a new turn', async () => {
    // Issue #30 (user-approved Option B): barge-in requires reaching
    // SPEAKING first; the FSM transition is dropped on headless macOS.
    // Spec passes on dev macOS in non-headless mode.
    test.skip(
      process.env['VG_E2E_HEADLESS'] === '1',
      'see issue #30 — headless macOS state-pipeline race',
    );
    bridge = await startMockBridge({
      onClientMessage: (raw, send) => {
        const m = raw as { type?: string; turn_id?: string; text?: string; final?: boolean };
        if (m.type === 'end_turn' && typeof m.turn_id === 'string') {
          send({ type: 'thinking', turn_id: m.turn_id } as ServerMessage);
          send({
            type: 'response_text',
            turn_id: m.turn_id,
            text: 'a very long reply that takes a while to synthesise...',
            final: true,
          } as ServerMessage);
          send({ type: 'response_end', turn_id: m.turn_id } as ServerMessage);
        }
      },
    });
    rig = await launchPackaged({
      bridgeUrl: bridge.url,
      bridgeToken: MOCK_DEFAULT_TOKEN,
      activation: { minAudioMs: 50 },
      // Renderer needs SOMETHING to capture so PCM frames reach main and
      // the orchestrator clears the minAudioMs gate. Real STT isn't run —
      // VG_E2E_FAKE_TRANSCRIPT replaces the adapter — but the audio flow
      // still has to be alive.
      fakeAudioFile: FAKE_AUDIO,
      extraEnv: { VG_E2E_FAKE_TRANSCRIPT: FAKE_TRANSCRIPT },
    });
    const { mainWindow } = rig;
    await expect(mainWindow.getByTestId('connection-indicator')).toContainText(/ligado|ms/i, {
      timeout: 15_000,
    });
    await instrumentTtsCounter(mainWindow);

    // Turn 1: press → release → wait until SPEAKING is entered.
    await holdPtt(mainWindow, 200);
    await expect
      .poll(
        async () =>
          (await readVgStats(mainWindow)).stateLog.map((s) => s.state).includes('SPEAKING'),
        { timeout: 10_000 },
      )
      .toBe(true);

    const turnsBefore = new Set(
      (await readVgStats(mainWindow)).stateLog
        .map((s) => s.turnId)
        .filter((t): t is string => !!t),
    );

    // Barge-in: press the call button while still SPEAKING. The orchestrator
    // should dispatch USER_INTERRUPT(barge_in) → state goes CAPTURING with a
    // fresh turn id.
    await mainWindow.getByTestId('call-button').dispatchEvent('pointerdown');
    await mainWindow.waitForTimeout(200);

    await expect
      .poll(
        async () =>
          (await readVgStats(mainWindow)).stateLog.at(-1)?.state ?? '',
        { timeout: 5_000 },
      )
      .toBe('CAPTURING');

    const after = await readVgStats(mainWindow);
    const newTurnIds = after.stateLog
      .map((s) => s.turnId)
      .filter((t): t is string => !!t)
      .filter((t) => !turnsBefore.has(t));
    expect(newTurnIds.length).toBeGreaterThan(0);

    // Release to clean up.
    await mainWindow.getByTestId('call-button').dispatchEvent('pointerup');
  });

  // ───── #22: ERROR → PTT auto-recovery
  test('bridge error puts the FSM in ERROR; PTT recovers to CAPTURING', async () => {
    // Issue #30 (user-approved Option B): the bridge-error frame fires on
    // the mock bridge but the renderer's state log records IDLE rather
    // than ERROR — the transition is dropped in transit on headless macOS
    // CI. Spec passes on dev macOS in non-headless mode.
    test.skip(
      process.env['VG_E2E_HEADLESS'] === '1',
      'see issue #30 — headless macOS state-pipeline race',
    );
    bridge = await startMockBridge({
      onClientMessage: (raw, send) => {
        const m = raw as { type?: string; turn_id?: string };
        if (m.type === 'end_turn' && typeof m.turn_id === 'string') {
          send({
            type: 'error',
            code: 'HERMES_UPSTREAM',
            message: 'simulated upstream failure',
            turn_id: m.turn_id,
          } as ServerMessage);
        }
      },
    });
    rig = await launchPackaged({
      bridgeUrl: bridge.url,
      bridgeToken: MOCK_DEFAULT_TOKEN,
      activation: { minAudioMs: 50 },
      // Renderer needs SOMETHING to capture so PCM frames reach main and
      // the orchestrator clears the minAudioMs gate. Real STT isn't run —
      // VG_E2E_FAKE_TRANSCRIPT replaces the adapter — but the audio flow
      // still has to be alive.
      fakeAudioFile: FAKE_AUDIO,
      extraEnv: { VG_E2E_FAKE_TRANSCRIPT: FAKE_TRANSCRIPT },
    });
    const { mainWindow } = rig;
    await expect(mainWindow.getByTestId('connection-indicator')).toContainText(/ligado|ms/i, {
      timeout: 15_000,
    });
    await instrumentTtsCounter(mainWindow);

    // Turn 1: press → release → expect ERROR.
    await holdPtt(mainWindow, 200);
    await waitForState(mainWindow, ['ERROR'], { timeoutMs: 10_000 });

    const errs = (await readVgStats(mainWindow)).errors;
    expect(errs.join('|')).toMatch(/HERMES_UPSTREAM|simulated/i);

    // Auto-recovery: a single PTT click from ERROR jumps to CAPTURING.
    await mainWindow.getByTestId('call-button').dispatchEvent('pointerdown');
    await waitForState(mainWindow, ['CAPTURING'], { timeoutMs: 3_000 });
    await mainWindow.getByTestId('call-button').dispatchEvent('pointerup');
  });

  // ───── #23: two sequential turns
  test('two consecutive turns both complete with distinct turn ids', async () => {
    bridge = await startMockBridge({
      onClientMessage: (raw, send) => {
        const m = raw as { type?: string; turn_id?: string };
        if (m.type === 'end_turn' && typeof m.turn_id === 'string') {
          send({ type: 'thinking', turn_id: m.turn_id } as ServerMessage);
          send({
            type: 'response_text',
            turn_id: m.turn_id,
            text: `reply for ${m.turn_id}`,
            final: true,
          } as ServerMessage);
          send({ type: 'response_end', turn_id: m.turn_id } as ServerMessage);
        }
      },
    });
    rig = await launchPackaged({
      bridgeUrl: bridge.url,
      bridgeToken: MOCK_DEFAULT_TOKEN,
      activation: { minAudioMs: 50 },
      // Renderer needs SOMETHING to capture so PCM frames reach main and
      // the orchestrator clears the minAudioMs gate. Real STT isn't run —
      // VG_E2E_FAKE_TRANSCRIPT replaces the adapter — but the audio flow
      // still has to be alive.
      fakeAudioFile: FAKE_AUDIO,
      extraEnv: { VG_E2E_FAKE_TRANSCRIPT: FAKE_TRANSCRIPT },
    });
    const { mainWindow } = rig;
    await expect(mainWindow.getByTestId('connection-indicator')).toContainText(/ligado|ms/i, {
      timeout: 15_000,
    });
    await instrumentTtsCounter(mainWindow);

    // Turn 1
    await holdPtt(mainWindow, 200);
    await expect
      .poll(
        async () =>
          (await readVgStats(mainWindow)).stateLog.at(-1)?.state ?? '',
        { timeout: 15_000 },
      )
      .toMatch(/IDLE|SPEAKING/);
    // Wait for SPEAKING to fully drain back to IDLE.
    await expect
      .poll(
        async () =>
          (await readVgStats(mainWindow)).stateLog.at(-1)?.state ?? '',
        { timeout: 20_000 },
      )
      .toBe('IDLE');

    const log1 = (await readVgStats(mainWindow)).stateLog;
    const turnsAfter1 = new Set(log1.map((s) => s.turnId).filter((t): t is string => !!t));
    expect(turnsAfter1.size).toBeGreaterThan(0);

    // Turn 2
    await holdPtt(mainWindow, 200);
    await expect
      .poll(
        async () =>
          (await readVgStats(mainWindow)).stateLog.at(-1)?.state ?? '',
        { timeout: 20_000 },
      )
      .toBe('IDLE');

    const log2 = (await readVgStats(mainWindow)).stateLog;
    const turnsAfter2 = new Set(log2.map((s) => s.turnId).filter((t): t is string => !!t));
    const newTurns = [...turnsAfter2].filter((t) => !turnsAfter1.has(t));
    expect(newTurns.length).toBeGreaterThan(0);

    // Both responses should appear in the transcript pane.
    const transcript = await mainWindow.locator('[data-testid="transcript"]').textContent();
    expect(transcript ?? '').toMatch(/reply for/);
  });

  // ───── #24: settings live-update across windows
  test('settings change in one window is broadcast to the other', async () => {
    bridge = await startMockBridge();
    rig = await launchPackaged({
      bridgeUrl: bridge.url,
      bridgeToken: MOCK_DEFAULT_TOKEN,
    });
    const { mainWindow } = rig;

    // Install a listener on the MAIN window that records every
    // settings.onChange payload's minAudioMs.
    await mainWindow.evaluate(() => {
      interface W {
        vg: {
          settings: { onChange: (cb: (s: { activation: { minAudioMs: number } }) => void) => () => void };
        };
        __vg_settings_log?: number[];
      }
      const w = globalThis as unknown as W;
      w.__vg_settings_log = [];
      w.vg.settings.onChange((s) => w.__vg_settings_log!.push(s.activation.minAudioMs));
    });

    // Open the dedicated Settings window via the shared helper so the
    // ciTimeout-aware 30 s ceiling protects us under macos-latest CPU
    // pressure (issue #18) — the inline 5 s timeout this used to have
    // was empirically too tight on CI cold-boot.
    const settingsWin = await openSettingsWindow(rig);

    await settingsWin.evaluate(async () => {
      const w = globalThis as unknown as {
        vg: {
          settings: {
            get: () => Promise<{ activation: { minAudioMs: number } }>;
            set: (
              p: { activation: { minAudioMs: number } },
            ) => Promise<{ activation: { minAudioMs: number } }>;
          };
        };
      };
      const cur = await w.vg.settings.get();
      await w.vg.settings.set({ activation: { ...cur.activation, minAudioMs: 777 } });
    });

    await expect
      .poll(
        async () =>
          await mainWindow.evaluate(
            () =>
              (globalThis as unknown as { __vg_settings_log?: number[] }).__vg_settings_log ?? [],
          ),
        { timeout: 5_000 },
      )
      .toContain(777);
  });
});
