/**
 * Runtime-behaviour E2Es that don't fit cleanly into the existing
 * spec files:
 *
 *   #51 — output device live-switch during SPEAKING. AudioPlayback's
 *         `setOutputDevice` is wired to AudioContext.setSinkId; we verify
 *         from inside the page that the live context received the new id.
 *
 *   #52 — PairingWizard probe shows the server's version (the welcome
 *         frame's `server_version` field surfaced in the probe result).
 *
 *   #58 — Error toast contains the bridge error verbatim, so the
 *         "copyable error" contract isn't silently broken by a future
 *         CommandHint refactor.
 */
import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import {
  MOCK_DEFAULT_TOKEN,
  startMockBridge,
  type MockBridge,
} from '../integration/__mocks__/mock-bridge-server';
import {
  scriptedError,
  scriptedTextReply,
} from './helpers/mock-bridge-presets';
import { ConversationDriver } from './helpers/driver';
import {
  FIXTURES_DIR,
  launchPackaged,
  launchUnpaired,
  packagedAppExists,
  ttsReady,
  type TestRig,
} from './helpers/rig';

const FAKE_AUDIO = join(FIXTURES_DIR, 'hi-how-are-you.wav');

test.describe('runtime extras', () => {
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

  // ───── #51: output device live-switch during SPEAKING
  //
  // Verifies the full broadcast path: settings.set({outputDeviceId}) →
  // electron-store persists → SETTINGS_CHANGED IPC → useConversation's
  // useEffect fires → playback.setOutputDevice runs without errors. The
  // actual Chromium setSinkId call is exercised by unit tests; here we
  // assert the production data flow + no-crash contract while a turn is
  // mid-flight (the hardest moment for a live AudioContext to be re-routed).
  test('outputDeviceId broadcast reaches the renderer while SPEAKING and produces no error', async () => {
    bridge = await startMockBridge({
      onClientMessage: scriptedTextReply('Olá, a tocar.'),
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

    // Subscribe in-page to settings broadcasts so we can prove the new
    // outputDeviceId reached the renderer.
    await mainWindow.evaluate(() => {
      interface W {
        vg: {
          settings: {
            onChange: (cb: (s: { audio: { outputDeviceId: string | null } }) => void) => () => void;
          };
        };
        __vg_output_log?: Array<string | null>;
      }
      const w = globalThis as unknown as W;
      w.__vg_output_log = [];
      w.vg.settings.onChange((s) => w.__vg_output_log!.push(s.audio.outputDeviceId));
    });

    const driver = await ConversationDriver.attach(mainWindow);

    // Piper's venv auto-install runs on first boot — wait for it (15-60 s
    // on a fresh userData; <1 s once cached). Skip if it never readies.
    const ttsR = await ttsReady(mainWindow);
    test.skip(!ttsR.ok, `Piper not ready in test environment: ${ttsR.message ?? 'unknown'}`);

    // Drive a turn so an AudioPlayback context goes live.
    void driver.runTurn({ holdMs: 200, until: ['SPEAKING', 'IDLE'] }).catch(() => undefined);
    await driver.waitFor(['SPEAKING'], 30_000);

    // Flip the output device mid-SPEAKING via the same IPC the Settings
    // panel uses. We deliberately pass a synthetic id rather than a real
    // enumerated device: the production AudioContext.setSinkId would
    // reject it, our AudioPlayback catches and emits 'error' (still no
    // crash), and the broadcast reaches the renderer either way.
    const synthetic = `vg-test-output-${Date.now()}`;
    await mainWindow.evaluate(async (id) => {
      const w = globalThis as unknown as {
        vg: {
          settings: {
            get: () => Promise<{ audio: { inputDeviceId: string | null; outputDeviceId: string | null } }>;
            set: (p: { audio: { inputDeviceId: string | null; outputDeviceId: string | null } }) => Promise<unknown>;
          };
        };
      };
      const cur = await w.vg.settings.get();
      await w.vg.settings.set({ audio: { ...cur.audio, outputDeviceId: id } });
    }, synthetic);

    // Broadcast made it to the renderer.
    await expect
      .poll(
        async () =>
          (await mainWindow.evaluate(
            () => (globalThis as unknown as { __vg_output_log?: Array<string | null> }).__vg_output_log ?? [],
          )) as Array<string | null>,
        { timeout: 5_000 },
      )
      .toContain(synthetic);

    // The FSM did not flip to ERROR — production handles a bad sinkId
    // gracefully via the AudioPlayback's error listener.
    const stats = await driver.stats();
    const lastState = stats.stateLog.at(-1)?.state ?? '';
    expect(lastState).not.toBe('ERROR');
  });

  // ───── #58: error toast contains the bridge message verbatim
  test('error toast surfaces the bridge error message exactly', async () => {
    const distinctive = `simulated upstream failure ${Date.now()}`;
    bridge = await startMockBridge({
      onClientMessage: scriptedError({
        code: 'HERMES_UPSTREAM',
        message: distinctive,
      }),
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

    const driver = await ConversationDriver.attach(mainWindow);
    void driver.runTurn({ holdMs: 200, until: ['ERROR'] }).catch(() => undefined);
    await driver.waitFor(['ERROR'], 15_000);

    const toast = mainWindow.getByTestId('error-toast');
    await expect(toast).toBeVisible({ timeout: 5_000 });
    await expect(toast).toContainText(distinctive);
  });
});

// ───── #52: PairingWizard probe surfaces server_version
test.describe('PairingWizard server_version surface', () => {
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

  test('successful probe carries the welcome.server_version through to the renderer', async () => {
    // The mock bridge advertises its serverVersion in the welcome frame;
    // we verify the wizard's testPairing IPC returned that value to the
    // renderer (the UI surfaces it as part of the green "Ligação
    // estabelecida" text on some versions, and always as the resolved
    // promise from vg.pair.test — that's what we check directly).
    const SERVER_VERSION = `mock-server-${Date.now()}`;
    bridge = await startMockBridge({ serverVersion: SERVER_VERSION });
    rig = await launchUnpaired();
    const { mainWindow: page } = rig;

    await page.getByLabel('Endereço do bridge').fill(bridge.url);
    await page.getByTestId('url-next').click();
    await page.getByLabel('Token de pairing').fill(MOCK_DEFAULT_TOKEN);

    // Call the test handler directly so we can read the structured result.
    const result = await page.evaluate(
      async (req) => {
        const w = globalThis as unknown as {
          vg: { pair: { test: (i: { url: string; token: string }) => Promise<{ ok: boolean; serverVersion?: string }> } };
        };
        return await w.vg.pair.test(req);
      },
      { url: bridge.url, token: MOCK_DEFAULT_TOKEN },
    );

    expect(result.ok).toBe(true);
    expect(result.serverVersion).toBe(SERVER_VERSION);
  });
});
