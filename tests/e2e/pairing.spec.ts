/**
 * Pairing wizard E2E. Uses the shared rig's `launchUnpaired` so the app
 * boots without a saved pairing and lands on step 1 of the wizard.
 *
 * Requires `npm run build:mac` — the rig drives the packaged .app. A
 * fresh clone without a build skips cleanly.
 */
import { expect, test } from '@playwright/test';
import {
  MOCK_DEFAULT_TOKEN,
  startMockBridge,
  type MockBridge,
} from '../integration/__mocks__/mock-bridge-server';
import { launchUnpaired, packagedAppExists, type TestRig } from './helpers/rig';

test.describe('PairingWizard E2E', () => {
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

  test('first run walks all three steps and lands on main screen', async () => {
    bridge = await startMockBridge();
    rig = await launchUnpaired();
    const { mainWindow: page } = rig;

    await expect(page.getByRole('heading', { name: /onde está o teu hermes/i })).toBeVisible();
    await page.getByLabel('Endereço do bridge').fill(bridge.url);
    await page.getByTestId('url-next').click();

    await page.getByLabel('Token de pairing').fill(MOCK_DEFAULT_TOKEN);
    await page.getByTestId('probe-test').click();
    await expect(page.getByTestId('probe-result')).toContainText(
      /ligação estabelecida/i,
      { timeout: 5_000 },
    );

    await page.getByTestId('token-next').click();
    await expect(page.getByRole('heading', { name: /como queres falar/i })).toBeVisible();
    await page.getByTestId('finish-pairing').click();

    await expect(page.getByTestId('pairing-done')).toBeVisible({ timeout: 5_000 });
    await page.getByTestId('open-app').click();
    await expect(page.getByTestId('call-button')).toBeVisible();
    await expect(page.getByTestId('connection-indicator')).toContainText(
      /ligado|sem ligação/i,
    );
  });

  test('shows a friendly error on bad token', async () => {
    bridge = await startMockBridge();
    rig = await launchUnpaired();
    const { mainWindow: page } = rig;

    await page.getByLabel('Endereço do bridge').fill(bridge.url);
    await page.getByTestId('url-next').click();

    await page.getByLabel('Token de pairing').fill('wrong-token-aaaaaaaaaaaa');
    await page.getByTestId('probe-test').click();
    await expect(page.getByTestId('probe-result')).toContainText(
      /token|ligar|servidor/i,
      { timeout: 5_000 },
    );
    await expect(page.getByTestId('token-next')).toBeDisabled();
  });
});
