import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MOCK_DEFAULT_TOKEN, startMockBridge, type MockBridge } from '../integration/__mocks__/mock-bridge-server';

const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const MAIN_ENTRY = join(ROOT, 'out/main/index.js');

async function launchApp(userData: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userData}`],
    cwd: ROOT,
    env: { ...process.env, ELECTRON_DISABLE_GPU: '1' },
  });
  const page = await app.firstWindow();
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      // eslint-disable-next-line no-console
      console.log(`[renderer ${msg.type()}] ${msg.text()}`);
    }
  });
  page.on('pageerror', (err) => {
    // eslint-disable-next-line no-console
    console.log(`[renderer pageerror] ${err.message}`);
  });
  return { app, page };
}

test.describe('PairingWizard E2E', () => {
  let bridge: MockBridge;
  let userData: string;

  test.beforeEach(async () => {
    bridge = await startMockBridge();
    userData = await mkdtemp(join(tmpdir(), 'vg-e2e-'));
  });

  test.afterEach(async () => {
    await bridge.close();
    await rm(userData, { recursive: true, force: true });
  });

  test('first run walks all three steps and lands on main screen', async () => {
    const { app, page } = await launchApp(userData);
    try {
      await expect(page.getByRole('heading', { name: /onde está o teu hermes/i })).toBeVisible();

      await page.getByLabel('Endereço do bridge').fill(bridge.url);
      await page.getByTestId('url-next').click();

      await page.getByLabel('Token de pairing').fill(MOCK_DEFAULT_TOKEN);
      await page.getByTestId('probe-test').click();
      await expect(page.getByTestId('probe-result')).toContainText(/ligação estabelecida/i, {
        timeout: 5_000,
      });

      await page.getByTestId('token-next').click();

      await expect(page.getByRole('heading', { name: /como queres falar/i })).toBeVisible();
      await page.getByTestId('finish-pairing').click();

      await expect(page.getByTestId('pairing-done')).toBeVisible({ timeout: 5_000 });
      await page.getByTestId('open-app').click();
      await expect(page.getByTestId('call-button')).toBeVisible();
      await expect(page.getByTestId('connection-indicator')).toContainText(/ligado|sem ligação/i);
    } finally {
      await app.close();
    }
  });

  test('shows a friendly error on bad token', async () => {
    const { app, page } = await launchApp(userData);
    try {
      await page.getByLabel('Endereço do bridge').fill(bridge.url);
      await page.getByTestId('url-next').click();

      await page.getByLabel('Token de pairing').fill('wrong-token-aaaaaaaaaaaa');
      await page.getByTestId('probe-test').click();
      await expect(page.getByTestId('probe-result')).toContainText(/token|ligar|servidor/i, {
        timeout: 5_000,
      });
      // "Continuar" must remain disabled until probe succeeds.
      await expect(page.getByTestId('token-next')).toBeDisabled();
    } finally {
      await app.close();
    }
  });
});
