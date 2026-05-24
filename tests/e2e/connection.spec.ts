/**
 * WebSocket connection lifecycle + pairing wizard input validation.
 *
 *   #31 — reconnect: indicator shows green, bridge dies, indicator turns
 *         away from green, bridge restarts on the same port, indicator
 *         goes green again. Exercises HermesClient's exponential backoff
 *         + welcome-on-reconnect.
 *
 *   #36 — pairing wizard rejects URLs that don't start with ws:// or
 *         wss://; the Continuar button stays disabled.
 */
import { expect, test } from '@playwright/test';
import { createServer } from 'node:net';
import {
  MOCK_DEFAULT_TOKEN,
  startMockBridge,
  type MockBridge,
} from '../integration/__mocks__/mock-bridge-server';
import {
  launchPackaged,
  launchUnpaired,
  packagedAppExists,
  type TestRig,
} from './helpers/rig';

/**
 * Grab a free TCP port by opening a 0-port server and immediately closing
 * it. The kernel hands the same port back when we re-bind (small race,
 * but good enough for serial tests).
 */
async function reserveFreePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
  const addr = srv.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  const port = addr.port;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

test.describe('connection lifecycle', () => {
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

  test('reconnects after bridge restart on the same port', async () => {
    // The bridge gets a fixed port so we can stop and restart it.
    const port = await reserveFreePort();
    bridge = await startMockBridge({ port });
    rig = await launchPackaged({
      bridgeUrl: `ws://127.0.0.1:${port}`,
      bridgeToken: MOCK_DEFAULT_TOKEN,
    });
    const { mainWindow } = rig;

    // Wait for the initial connection to land.
    await expect(mainWindow.getByTestId('connection-indicator')).toContainText(
      /ligado|ms/i,
      { timeout: 15_000 },
    );

    // Bring the bridge down. The app's heartbeat will eventually notice (a
    // pong won't arrive within 5 s) AND the socket close will fire
    // immediately, scheduling a reconnect.
    await bridge.close();
    bridge = null;
    await expect(mainWindow.getByTestId('connection-indicator')).toContainText(
      /sem ligação|a ligar/i,
      { timeout: 20_000 },
    );

    // Restart the bridge on the SAME port — the reconnect loop's next
    // attempt should land. Backoff caps at 30 s; we wait up to 35 s to be
    // safe.
    bridge = await startMockBridge({ port });
    await expect(mainWindow.getByTestId('connection-indicator')).toContainText(
      /ligado|ms/i,
      { timeout: 35_000 },
    );
  });
});

test.describe('PairingWizard input validation', () => {
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

  test('rejects URLs without ws:// or wss:// prefix', async () => {
    rig = await launchUnpaired();
    const { mainWindow: page } = rig;

    await expect(page.getByRole('heading', { name: /onde está o teu hermes/i })).toBeVisible();

    // Plain HTTP URL.
    await page.getByLabel('Endereço do bridge').fill('http://10.0.0.1:8765/ws');
    await expect(page.getByTestId('url-next')).toBeDisabled();

    // No scheme at all.
    await page.getByLabel('Endereço do bridge').fill('10.0.0.1:8765');
    await expect(page.getByTestId('url-next')).toBeDisabled();

    // Garbage.
    await page.getByLabel('Endereço do bridge').fill('not-a-url');
    await expect(page.getByTestId('url-next')).toBeDisabled();

    // Recover with a valid ws:// URL.
    await page.getByLabel('Endereço do bridge').fill('ws://10.0.0.1:8765');
    await expect(page.getByTestId('url-next')).toBeEnabled();
  });
});
