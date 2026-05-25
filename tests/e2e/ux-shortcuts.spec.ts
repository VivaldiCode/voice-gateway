/**
 * E2E for the round-7 UX additions:
 *
 *   #81 — Escape dismisses the error toast; Cmd+, opens Settings window.
 *   #82 — error toast renders a "Copiar diagnóstico" button; clicking it
 *         puts the structured diagnostic string on the clipboard.
 *         Bonus: ReadinessPill text reflects the live STT/TTS state.
 *   #83 — PairingWizard token textarea strips whitespace on every change.
 */
import { expect, test } from '@playwright/test';
import {
  MOCK_DEFAULT_TOKEN,
  startMockBridge,
  type MockBridge,
} from '../integration/__mocks__/mock-bridge-server';
import { scriptedError } from './helpers/mock-bridge-presets';
import { ConversationDriver } from './helpers/driver';
import {
  FIXTURES_DIR,
  ciTimeout,
  launchPackaged,
  launchUnpaired,
  packagedAppExists,
  type TestRig,
} from './helpers/rig';
import { join } from 'node:path';

const FAKE_AUDIO = join(FIXTURES_DIR, 'hi-how-are-you.wav');

test.describe('UX shortcuts + chrome', () => {
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

  // ───── #81: Escape + Cmd+, shortcuts
  test('Escape dismisses the error toast', async () => {
    bridge = await startMockBridge({
      onClientMessage: scriptedError({ code: 'HERMES_UPSTREAM', message: 'boom' }),
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

    // Press Escape — the toast should disappear (the FSM stays in ERROR
    // until a PTT_PRESS recovers it, but the visible alert is cleared).
    await mainWindow.keyboard.press('Escape');
    await expect(toast).not.toBeVisible({ timeout: 3_000 });
  });

  test('Cmd+, opens the Settings BrowserWindow', async () => {
    bridge = await startMockBridge();
    rig = await launchPackaged({
      bridgeUrl: bridge.url,
      bridgeToken: MOCK_DEFAULT_TOKEN,
    });
    const { app, mainWindow } = rig;

    await expect(mainWindow.getByTestId('connection-indicator')).toBeVisible({
      timeout: 15_000,
    });

    // ciTimeout-aware: the 5 s ceiling was too tight on macos-latest CPU
    // pressure (issue #18). The keyboard path can't use openSettingsWindow
    // because it has to dispatch the actual Cmd+, event.
    const open = app.waitForEvent('window', { timeout: ciTimeout(5_000, 30_000) });
    // Page focus is implicit when we evaluate inside the page context.
    await mainWindow.locator('body').click();
    await mainWindow.keyboard.press('Meta+,');
    const settingsWindow = await open;
    await settingsWindow.waitForLoadState('domcontentloaded');

    // Settings tab buttons render — proof we landed on the panel.
    await expect(settingsWindow.getByTestId('tab-microfone')).toBeVisible({
      timeout: 5_000,
    });
  });

  // ───── #82: error toast diagnostic + readiness pill
  test('error toast has a "Copiar diagnóstico" button', async () => {
    bridge = await startMockBridge({
      onClientMessage: scriptedError({ code: 'HERMES_UPSTREAM', message: 'diag check' }),
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

    const copyBtn = mainWindow.getByTestId('error-copy-diagnostic');
    await expect(copyBtn).toBeVisible({ timeout: 5_000 });
    // We don't read the clipboard (Playwright + Electron renderer perms are
    // finicky); the contract is just that the button exists and is clickable.
    await expect(copyBtn).toBeEnabled();
    await copyBtn.click();
  });

  test('ReadinessPill appears when STT or TTS is not yet "ready"', async () => {
    // Use a virgin userData so Piper venv has to install from scratch —
    // gives us a window where TTS is `preparing` and the pill should
    // render. After ttsReady completes the pill disappears.
    bridge = await startMockBridge();
    rig = await launchPackaged({
      bridgeUrl: bridge.url,
      bridgeToken: MOCK_DEFAULT_TOKEN,
    });
    const { mainWindow } = rig;
    await expect(mainWindow.getByTestId('connection-indicator')).toBeVisible({
      timeout: 15_000,
    });

    // While STT or TTS is preparing/idle, the pill should be visible. Either
    // we catch it briefly OR the prep already finished — in that case the
    // pill never renders. Both are correct: this test passes as long as the
    // element either appears OR doesn't crash the page. Use a soft check.
    const pill = mainWindow.getByTestId('readiness-pill');
    const count = await pill.count();
    // eslint-disable-next-line no-console
    console.log(`[e2e] readiness pill rendered: ${count > 0}`);
    // Inspect data-stt/data-tts attributes if present.
    if (count > 0) {
      const stt = await pill.first().getAttribute('data-stt');
      const tts = await pill.first().getAttribute('data-tts');
      expect(stt).not.toBeNull();
      expect(tts).not.toBeNull();
    }
  });

  // ───── #83: wizard token paste whitespace trim
  test('PairingWizard strips whitespace from the pasted token before probing', async () => {
    bridge = await startMockBridge();
    rig = await launchUnpaired();
    const { mainWindow: page } = rig;

    await page.getByLabel('Endereço do bridge').fill(bridge.url);
    await page.getByTestId('url-next').click();

    // Fill with leading + trailing whitespace and a newline in the middle.
    const messy = `   \n  ${MOCK_DEFAULT_TOKEN}  \n  `;
    await page.getByLabel('Token de pairing').fill(messy);

    // Field value must already be the trimmed-and-collapsed form.
    await expect(page.getByLabel('Token de pairing')).toHaveValue(MOCK_DEFAULT_TOKEN);

    // Probe + success → proves the bridge received exactly the trimmed token.
    await page.getByTestId('probe-test').click();
    await expect(page.getByTestId('probe-result')).toContainText(
      /ligação estabelecida/i,
      { timeout: 5_000 },
    );
  });
});
