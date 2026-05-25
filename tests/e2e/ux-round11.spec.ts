/**
 * E2E for the round-11 UX additions:
 *
 *   #121  Capture-elapsed counter renders while CAPTURING with ms attr.
 *   #122  Error toast now has a discoverable "Tentar de novo" button
 *         that drives the same dismiss + retry sequence as Cmd+R.
 *   #123  Settings → Conexão pre-flight check exercises pair.test()
 *         against the live pairing + surfaces ok/fail badge.
 *   #124  Cmd+S exports the transcript via TRANSCRIPT_EXPORT IPC
 *         (test bypasses the OS dialog via cancelDialog).
 *   #125  Settings → Avançado renders an Sobre section with version,
 *         bridge, schema, platform.
 *   #126  Transcript persists across an app restart (last 20 turns).
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MOCK_DEFAULT_TOKEN,
  startMockBridge,
  type MockBridge,
} from '../integration/__mocks__/mock-bridge-server';
import { scriptedTextReply } from './helpers/mock-bridge-presets';
import { ConversationDriver } from './helpers/driver';
import {
  FIXTURES_DIR,
  ciTimeout,
  launchPackaged,
  openSettingsWindow,
  packagedAppExists,
  type TestRig,
} from './helpers/rig';

const FAKE_AUDIO = join(FIXTURES_DIR, 'hi-how-are-you.wav');

test.describe('UX round-11 — capture timer, retry button, pre-flight, export, Sobre, persistence', () => {
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

  // ───── #121: capture-elapsed counter
  test('Main: capture-elapsed counter ticks during CAPTURING and disappears at IDLE', async () => {
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
    await expect(mainWindow.getByTestId('capture-elapsed')).toHaveCount(0);

    const driver = await ConversationDriver.attach(mainWindow);
    await driver.pressPtt();
    await driver.waitFor(['CAPTURING'], 5_000);

    const elapsed = mainWindow.getByTestId('capture-elapsed');
    await expect(elapsed).toBeVisible();
    // Sample twice with a small gap — the second sample should reflect at
    // least one 100 ms tick of growth.
    const first = Number(await elapsed.getAttribute('data-ms'));
    await mainWindow.waitForTimeout(300);
    const second = Number(await elapsed.getAttribute('data-ms'));
    expect(second).toBeGreaterThan(first);

    await driver.releasePtt();
    await driver.waitFor(['IDLE'], 10_000);
    await expect(mainWindow.getByTestId('capture-elapsed')).toHaveCount(0);
  });

  // ───── #122: "Tentar de novo" button on error toast
  test('Error toast: "Tentar de novo" button drives the retry path', async () => {
    bridge = await startMockBridge();
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
    await driver.pressPtt();
    await driver.waitFor(['CAPTURING'], 5_000);
    const conn = [...bridge.connections][0];
    if (!conn) throw new Error('no mock connection');
    conn.send(
      JSON.stringify({
        type: 'error',
        code: 'HERMES_UPSTREAM',
        message: 'simulated upstream failure',
      }),
    );
    await driver.releasePtt();
    await driver.waitFor(['ERROR'], 5_000);

    const retry = mainWindow.getByTestId('error-retry');
    await expect(retry).toBeVisible();
    await retry.click();

    // Error toast goes away; FSM leaves ERROR.
    await expect(mainWindow.getByTestId('error-toast')).toHaveCount(0, { timeout: 5_000 });
    const stateAfter = await mainWindow.evaluate(
      () => (globalThis as unknown as { __vg_state_log: string[] }).__vg_state_log?.at(-1),
    );
    expect(stateAfter, 'state log last value').not.toBe('ERROR');
  });

  // ───── #123: pre-flight check in Settings → Conexão
  test('Settings → Conexão: pre-flight test surfaces ok badge with server version', async () => {
    bridge = await startMockBridge();
    rig = await launchPackaged({
      bridgeUrl: bridge.url,
      bridgeToken: MOCK_DEFAULT_TOKEN,
    });
    const settings = await openSettingsWindow(rig);
    await settings.getByTestId('tab-conexao').click();
    const button = settings.getByTestId('conn-preflight');
    await expect(button).toBeVisible();
    await button.click();
    const result = settings.getByTestId('conn-preflight-result');
    await expect(result).toBeVisible({ timeout: 10_000 });
    await expect(result).toHaveAttribute('data-status', 'ok');
    await expect(result).toContainText(/mock|v|✓/i);
  });

  // ───── #124: Cmd+S export → TRANSCRIPT_EXPORT IPC
  test('Cmd+S triggers TRANSCRIPT_EXPORT and main writes the formatted text', async () => {
    // The renderer can't monkey-patch window.vg (contextBridge freezes it),
    // so we steer main with VG_E2E_EXPORT_TARGET instead — main skips the
    // OS Save dialog and writes straight to that path.
    const exportDir = await mkdtemp(join(tmpdir(), 'vg-e2e-export-'));
    const exportTarget = join(exportDir, 'transcript.txt');
    try {
      bridge = await startMockBridge({
        onClientMessage: scriptedTextReply('uma resposta'),
      });
      rig = await launchPackaged({
        bridgeUrl: bridge.url,
        bridgeToken: MOCK_DEFAULT_TOKEN,
        fakeAudioFile: FAKE_AUDIO,
        activation: { minAudioMs: 50 },
        extraEnv: {
          VG_E2E_FAKE_TRANSCRIPT: 'pergunta',
          VG_E2E_EXPORT_TARGET: exportTarget,
        },
      });
      const { mainWindow } = rig;
      await expect(mainWindow.getByTestId('connection-indicator')).toContainText(/ligado|ms/i, {
        timeout: 15_000,
      });
      const driver = await ConversationDriver.attach(mainWindow);
      await driver.runTurn({ holdMs: 200, until: ['IDLE'] });
      await expect(mainWindow.getByTestId('transcript-count')).toContainText(/2 mensagens/);

      // Focus the renderer + press Cmd+S — main writes the file because
      // VG_E2E_EXPORT_TARGET is set, no OS dialog opens.
      await mainWindow.locator('main').first().click();
      await mainWindow.keyboard.press('Meta+s');
      await expect
        .poll(
          () => {
            try {
              return readFileSync(exportTarget, 'utf-8');
            } catch {
              return '';
            }
          },
          { timeout: 5_000 },
        )
        .toMatch(/Tu:.*pergunta/);
      const content = readFileSync(exportTarget, 'utf-8');
      expect(content).toMatch(/Hermes:.*uma resposta/);
    } finally {
      await rm(exportDir, { recursive: true, force: true });
    }
  });

  // ───── #125: Settings → Avançado "Sobre" section
  test('Settings → Avançado: Sobre shows version + bridge + schema', async () => {
    bridge = await startMockBridge();
    rig = await launchPackaged({
      bridgeUrl: bridge.url,
      bridgeToken: MOCK_DEFAULT_TOKEN,
    });
    const settings = await openSettingsWindow(rig);
    await settings.getByTestId('tab-avancado').click();
    await expect(settings.getByTestId('about-section')).toBeVisible();
    await expect(settings.getByTestId('about-version')).toContainText(/0\.\d+/);
    await expect(settings.getByTestId('about-bridge')).toContainText(/ws:\/\//);
    await expect(settings.getByTestId('about-schema')).toContainText(/v\d+/);
  });

  // ───── #126: transcript persistence across an app restart
  test('Transcript survives app restart (last 20 turns)', async () => {
    bridge = await startMockBridge({
      onClientMessage: scriptedTextReply('resposta persistente'),
    });
    rig = await launchPackaged({
      bridgeUrl: bridge.url,
      bridgeToken: MOCK_DEFAULT_TOKEN,
      fakeAudioFile: FAKE_AUDIO,
      activation: { minAudioMs: 50 },
      extraEnv: { VG_E2E_FAKE_TRANSCRIPT: 'pergunta persistente' },
    });
    const { mainWindow } = rig;
    await expect(mainWindow.getByTestId('connection-indicator')).toContainText(/ligado|ms/i, {
      timeout: 15_000,
    });
    const driver = await ConversationDriver.attach(mainWindow);
    await driver.runTurn({ holdMs: 200, until: ['IDLE'] });
    await expect(mainWindow.getByTestId('transcript-count')).toContainText(/2 mensagens/);
    // Wait past the 600 ms debounce so the persistence write lands.
    await mainWindow.waitForTimeout(900);

    // Confirm the settings file on disk now contains the lines.
    const userData = rig.userData;
    const raw = JSON.parse(
      readFileSync(join(userData, 'voice-gateway-settings.json'), 'utf-8'),
    );
    const persisted = raw.settings.transcript.recent;
    expect(persisted.length).toBeGreaterThanOrEqual(2);
    expect(persisted.some((l: { role: string; text: string }) => l.role === 'user' && /pergunta/.test(l.text))).toBe(true);
    expect(persisted.some((l: { role: string; text: string }) => l.role === 'assistant' && /resposta/.test(l.text))).toBe(true);

    // Tear down + relaunch with the same userData to confirm the seed
    // path restores the transcript on next mount.
    await rig.app.close();
    // Patch the rig manually: reuse userData by writing the same settings
    // and launching a fresh app pointed at it.
    const { _electron: electron } = await import('@playwright/test');
    const next = await electron.launch({
      executablePath: (await import('./helpers/rig')).PACKAGED_EXEC,
      args: [`--user-data-dir=${userData}`, '--autoplay-policy=no-user-gesture-required'],
      env: { ...process.env, VG_E2E: '1' },
      // ciTimeout-aware: CI cold-boot was hitting the 30 s ceiling
      // intermittently (issue #18). Local stays snappy.
      timeout: ciTimeout(30_000, 60_000),
    });
    try {
      const win = await next.firstWindow({ timeout: ciTimeout(15_000, 45_000) });
      await win.waitForLoadState('domcontentloaded');
      await expect(win.getByTestId('transcript-count')).toContainText(/2 mensagens/, {
        timeout: 10_000,
      });
      // The seeded lines re-render.
      await expect(win.getByTestId('transcript-user').first()).toContainText('pergunta');
      await expect(win.getByTestId('transcript-assistant').first()).toContainText('resposta');
    } finally {
      await next.close();
    }
  });
});
