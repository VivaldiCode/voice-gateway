/**
 * Wake-word E2E. Uses the deterministic fake runner gated by
 * VG_WAKE_E2E_FAKE=1 so the test is independent of openwakeword /
 * sounddevice / whisper / real microphone presence.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  launchPackaged,
  openSettingsWindow,
  packagedAppExists,
  type TestRig,
} from './helpers/rig';

test.describe('wake-word — packaged app, deterministic fake runner', () => {
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

  async function setup(): Promise<Page> {
    rig = await launchPackaged({
      bridgeUrl: 'ws://127.0.0.1:9/ws',
      bridgeToken: 'fake-e2e-token-1234567890',
      activation: { mode: 'WAKE_WORD' },
      extraEnv: { VG_WAKE_E2E_FAKE: '1' },
    });
    const settings = await openSettingsWindow(rig);
    await settings.getByTestId('tab-ativacao').click();
    return settings;
  }

  test('openww mode: Testar agora fires the deterministic fake runner', async () => {
    const settings = await setup();
    await expect(settings.getByTestId('wake-test-button')).toBeVisible();
    await expect(settings.getByTestId('wake-test-status')).toContainText(/pronto/i);
    await settings.getByTestId('wake-test-button').click();
    await expect(settings.getByTestId('wake-test-status')).toContainText(
      /escuta|fala agora/i,
      { timeout: 5_000 },
    );
    await expect(settings.getByTestId('wake-test-status')).toContainText(/detectei/i, {
      timeout: 6_000,
    });
  });

  test('phrase mode: Testar agora streams transcript + fires', async () => {
    const settings = await setup();
    await settings.getByRole('button', { name: /frase personalizada/i }).click();
    await expect(settings.getByTestId('wake-phrase-input')).toHaveValue('hey hermes');
    await settings.getByTestId('wake-test-button').click();
    await expect(settings.getByTestId('wake-test-transcript')).toContainText(/ouvi:/i, {
      timeout: 6_000,
    });
    await expect(settings.getByTestId('wake-test-status')).toContainText(/detectei/i, {
      timeout: 6_000,
    });
  });

  test('switching the typed phrase resets the tester state', async () => {
    const settings = await setup();
    await settings.getByRole('button', { name: /frase personalizada/i }).click();
    await settings.getByTestId('wake-test-button').click();
    await expect(settings.getByTestId('wake-test-status')).toContainText(/detectei/i, {
      timeout: 6_000,
    });
    await settings.getByTestId('wake-phrase-input').fill('hey claude please');
    await expect(settings.getByTestId('wake-test-status')).toContainText(
      /pronto a testar/i,
      { timeout: 3_000 },
    );
  });
});
