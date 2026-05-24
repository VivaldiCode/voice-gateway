/**
 * UI surface E2Es: things the user sees that aren't just IPC payloads.
 *
 *   #44 — warning toast appears, persists, then auto-dismisses after the
 *         4 s window in useConversation.
 *
 *   #45 — StateOrb's `data-state` attribute cycles through the FSM
 *         states during a turn. Establishes a stable visual contract for
 *         future styling tests.
 */
import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import {
  MOCK_DEFAULT_TOKEN,
  startMockBridge,
  type MockBridge,
} from '../integration/__mocks__/mock-bridge-server';
import { scriptedTextReply } from './helpers/mock-bridge-presets';
import {
  FIXTURES_DIR,
  holdPtt,
  instrumentTtsCounter,
  launchPackaged,
  packagedAppExists,
  readVgStats,
  waitForState,
  type TestRig,
} from './helpers/rig';

const FAKE_AUDIO = join(FIXTURES_DIR, 'hi-how-are-you.wav');

test.describe('visual states', () => {
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

  // ───── #44: warning toast lifecycle
  test('warning toast renders and auto-dismisses after 4 s', async () => {
    bridge = await startMockBridge();
    rig = await launchPackaged({
      bridgeUrl: bridge.url,
      bridgeToken: MOCK_DEFAULT_TOKEN,
      fakeAudioFile: FAKE_AUDIO,
      // High threshold so a brief PTT tap reliably triggers a warning.
      activation: { minAudioMs: 1500 },
      extraEnv: { VG_E2E_FAKE_TRANSCRIPT: 'never sent' },
    });
    const { mainWindow } = rig;
    await expect(mainWindow.getByTestId('connection-indicator')).toContainText(/ligado|ms/i, {
      timeout: 15_000,
    });

    // Trigger the short-capture warning.
    await holdPtt(mainWindow, 100);

    const toast = mainWindow.getByTestId('warning-toast');
    await expect(toast).toBeVisible({ timeout: 5_000 });
    await expect(toast).toContainText(/curt[ao]|premido/i);

    // useConversation clears after 4 000 ms — wait a touch more.
    await expect(toast).not.toBeVisible({ timeout: 6_000 });
  });

  // ───── #45: StateOrb data-state attribute reflects FSM
  test('StateOrb data-state cycles through CAPTURING/THINKING/SPEAKING/IDLE during a turn', async () => {
    bridge = await startMockBridge({
      onClientMessage: scriptedTextReply('a small reply'),
    });
    rig = await launchPackaged({
      bridgeUrl: bridge.url,
      bridgeToken: MOCK_DEFAULT_TOKEN,
      fakeAudioFile: FAKE_AUDIO,
      activation: { minAudioMs: 50 },
      extraEnv: { VG_E2E_FAKE_TRANSCRIPT: 'oi' },
    });
    const { mainWindow } = rig;
    await expect(mainWindow.getByTestId('connection-indicator')).toContainText(/ligado|ms/i, {
      timeout: 15_000,
    });
    await instrumentTtsCounter(mainWindow);

    const orb = mainWindow.getByTestId('state-orb');
    await expect(orb).toHaveAttribute('data-state', 'IDLE');

    // Drive the turn. Polling the DOM attribute every 50 ms is too coarse
    // to catch STREAMING/THINKING which the renderer races through in a
    // handful of frames. Use the event-driven state log from
    // `instrumentTtsCounter` instead — it records every IPC `state` payload
    // the renderer received, so no transition can be missed.
    await holdPtt(mainWindow, 200);
    await waitForState(mainWindow, ['IDLE'], { timeoutMs: 20_000 });

    // After the turn the orb attribute should be back at IDLE.
    await expect(orb).toHaveAttribute('data-state', 'IDLE');

    const seen = new Set(
      (await readVgStats(mainWindow)).stateLog.map((s) => s.state),
    );
    // We must have seen IDLE (initial), CAPTURING (during press), THINKING
    // (after STT) and at least one of SPEAKING / IDLE on the way back.
    expect([...seen].sort(), `visited: ${[...seen].join(', ')}`).toEqual(
      expect.arrayContaining(['IDLE', 'CAPTURING', 'THINKING']),
    );
  });
});
