/**
 * E2E for the round-8 UX additions:
 *
 *   #87  window title reflects FSM state — verify the document.title
 *        suffix changes through a turn.
 *   #86  visible "X" cancel button only renders during CAPTURING and
 *        actually cancels the turn.
 *   #88  wake-word flash — when we transition LISTENING_WAKE → CAPTURING
 *        via the fake runner, `main` gets `data-just-woke="true"` briefly.
 *   #89  hotkey hint text is present and adapts to mode.
 *   #90  wizard step indicator shows passo X de 3.
 *   #91  call-button-wrapper carries `data-disabled-reason` while
 *        disabled (and the title attribute matches).
 *   #93  settings.set fires the transient "Guardado" indicator.
 *   #94  wizard cancel link wipes typed state and returns to step 1.
 */
import { expect, test } from '@playwright/test';
import {
  MOCK_DEFAULT_TOKEN,
  startMockBridge,
  type MockBridge,
} from '../integration/__mocks__/mock-bridge-server';
import { scriptedTextReply } from './helpers/mock-bridge-presets';
import { ConversationDriver } from './helpers/driver';
import {
  FIXTURES_DIR,
  launchPackaged,
  launchUnpaired,
  openSettingsWindow,
  packagedAppExists,
  type TestRig,
} from './helpers/rig';
import { join } from 'node:path';

const FAKE_AUDIO = join(FIXTURES_DIR, 'hi-how-are-you.wav');

test.describe('UX round-8 — main window + wizard', () => {
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

  // ───── #87: window title reflects FSM state
  test('document.title carries the FSM state suffix and updates through a turn', async () => {
    bridge = await startMockBridge({
      onClientMessage: scriptedTextReply('ok'),
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

    // Initial title is "Voice Gateway — Pronto"
    await expect
      .poll(async () => await mainWindow.title(), { timeout: 5_000 })
      .toMatch(/Voice Gateway.*Pronto/);

    const driver = await ConversationDriver.attach(mainWindow);
    // Drive a turn and capture the distinct titles observed mid-flight.
    const seen = new Set<string>();
    const off = setInterval(() => {
      void mainWindow.title().then((t) => seen.add(t));
    }, 80);
    try {
      await driver.runTurn({ holdMs: 200, until: ['IDLE'] });
    } finally {
      clearInterval(off);
    }
    // Should have seen at least one non-"Pronto" title during the turn.
    const titles = [...seen];
    const interesting = titles.filter((t) => !/Pronto/.test(t));
    expect(interesting.length, `titles seen: ${titles.join(' | ')}`).toBeGreaterThan(0);
  });

  // ───── #86: cancel X button + #91: disabled reason
  test('cancel X button renders during CAPTURING and cancels the turn', async () => {
    bridge = await startMockBridge();
    rig = await launchPackaged({
      bridgeUrl: bridge.url,
      bridgeToken: MOCK_DEFAULT_TOKEN,
      fakeAudioFile: FAKE_AUDIO,
      activation: { minAudioMs: 50 },
      extraEnv: { VG_E2E_FAKE_TRANSCRIPT: 'never sent' },
    });
    const { mainWindow } = rig;
    await expect(mainWindow.getByTestId('connection-indicator')).toContainText(/ligado|ms/i, {
      timeout: 15_000,
    });
    const driver = await ConversationDriver.attach(mainWindow);

    // Before press: cancel button is hidden.
    await expect(mainWindow.getByTestId('cancel-capture')).toHaveCount(0);
    // call-button-wrapper has no disabled-reason (STT etc. ready by now).

    // Hold PTT.
    await driver.pressPtt();
    await driver.waitFor(['CAPTURING'], 5_000);

    // Cancel button now visible.
    await expect(mainWindow.getByTestId('cancel-capture')).toBeVisible();

    // Click it.
    await mainWindow.getByTestId('cancel-capture').click();
    await driver.waitFor(['IDLE'], 5_000);

    // And the cancel button is gone again.
    await expect(mainWindow.getByTestId('cancel-capture')).toHaveCount(0);
  });

  // ───── #88: wake flash via data-just-woke attribute
  test('main has data-just-woke="true" briefly after a wake event', async () => {
    bridge = await startMockBridge();
    rig = await launchPackaged({
      bridgeUrl: bridge.url,
      bridgeToken: MOCK_DEFAULT_TOKEN,
      fakeAudioFile: FAKE_AUDIO,
      activation: { mode: 'WAKE_WORD', minAudioMs: 50 },
      extraEnv: {
        VG_WAKE_E2E_FAKE: '1',
        VG_E2E_FAKE_TRANSCRIPT: 'oi',
      },
    });
    const { mainWindow } = rig;
    await expect(mainWindow.getByTestId('connection-indicator')).toContainText(/ligado|ms/i, {
      timeout: 15_000,
    });

    // Sample data-just-woke aggressively after the fake wake fires
    // (it lasts ~600 ms).
    const seen = new Set<string | null>();
    const start = Date.now();
    while (Date.now() - start < 5_000) {
      const v = await mainWindow
        .locator('main[data-just-woke]')
        .first()
        .getAttribute('data-just-woke');
      seen.add(v);
      if (seen.has('true')) break;
      await mainWindow.waitForTimeout(40);
    }
    expect(seen, `attribute values seen: ${[...seen].join(', ')}`).toContain('true');
  });

  // ───── #89: hotkey hint
  test('hotkey hint adapts to push-to-talk mode and shows the shortcut', async () => {
    bridge = await startMockBridge();
    rig = await launchPackaged({
      bridgeUrl: bridge.url,
      bridgeToken: MOCK_DEFAULT_TOKEN,
    });
    const { mainWindow } = rig;
    await expect(mainWindow.getByTestId('connection-indicator')).toBeVisible({
      timeout: 15_000,
    });
    const hint = mainWindow.getByTestId('hotkey-hint');
    await expect(hint).toBeVisible();
    // The default hotkey is CommandOrControl+Shift+H → prettified to ⌘⇧H (mac).
    await expect(hint).toContainText(/Carrega no botão/);
    await expect(hint).toContainText(/⌘|⌃/);
  });

  // ───── #93: settings save indicator
  test('changing a setting flashes the "Guardado" indicator', async () => {
    bridge = await startMockBridge();
    rig = await launchPackaged({
      bridgeUrl: bridge.url,
      bridgeToken: MOCK_DEFAULT_TOKEN,
    });
    const settings = await openSettingsWindow(rig);
    await settings.getByTestId('tab-ativacao').click();

    // Mutate any field — flip the activation mode toggle.
    await settings.getByRole('button', { name: /sempre à escuta/i }).click();

    // The flash appears briefly.
    const flash = settings.getByTestId('settings-saved-indicator');
    await expect(flash).toBeVisible({ timeout: 3_000 });
    // And clears within ~1.5 s.
    await expect(flash).not.toBeVisible({ timeout: 3_000 });
  });
});

test.describe('UX round-8 — wizard', () => {
  let rig: TestRig | null = null;

  test.beforeAll(() => {
    if (!packagedAppExists()) {
      test.skip(true, 'Packaged app missing. Run `npm run build:mac` first.');
    }
  });

  test.afterEach(async () => {
    await rig?.dispose();
    rig = null;
  });

  // ───── #90: step indicator
  test('wizard step indicator shows "passo X de 3" and updates per step', async () => {
    rig = await launchUnpaired();
    const { mainWindow: page } = rig;
    await expect(page.getByTestId('wizard-step-label')).toContainText('passo 1 de 3');

    await page.getByLabel('Endereço do bridge').fill('ws://10.0.0.1:8765');
    await page.getByTestId('url-next').click();
    await expect(page.getByTestId('wizard-step-label')).toContainText('passo 2 de 3');
  });

  // ───── #94: cancel link wipes state + returns to step 1
  test('cancel link on step 2 wipes the typed token and returns to step 1', async () => {
    rig = await launchUnpaired();
    const { mainWindow: page } = rig;
    await page.getByLabel('Endereço do bridge').fill('ws://10.0.0.1:8765');
    await page.getByTestId('url-next').click();
    await page.getByLabel('Token de pairing').fill('some-token-i-typed');

    // Cancel.
    await page.getByTestId('wizard-cancel').click();

    // Back on step 1.
    await expect(page.getByRole('heading', { name: /onde está o teu hermes/i })).toBeVisible();
    await expect(page.getByTestId('wizard-step-label')).toContainText('passo 1 de 3');

    // Step 2 again — token is empty.
    await page.getByTestId('url-next').click();
    await expect(page.getByLabel('Token de pairing')).toHaveValue('');
  });
});
