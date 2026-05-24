/**
 * PairingWizard UX contracts beyond the happy-path covered by
 * pairing.spec.ts:
 *
 *   #60 — back navigation between steps preserves the user's previous
 *         input. Token step's "Voltar" returns to URL step with the URL
 *         field still populated. Mode step's "Voltar" returns to Token
 *         step with the previously-validated state intact.
 *
 *   #61 — token field is a multi-line textarea with the `aria-label`
 *         "Token de pairing" — the contract assistive tech relies on.
 *         (Token is plain text by design — install.sh prints it in the
 *         banner and the user pastes it; masking would help nobody.)
 */
import { expect, test } from '@playwright/test';
import {
  MOCK_DEFAULT_TOKEN,
  startMockBridge,
  type MockBridge,
} from '../integration/__mocks__/mock-bridge-server';
import { launchUnpaired, packagedAppExists, type TestRig } from './helpers/rig';

test.describe('PairingWizard navigation + form contracts', () => {
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

  test('back navigation preserves the URL field across steps', async () => {
    bridge = await startMockBridge();
    rig = await launchUnpaired();
    const { mainWindow: page } = rig;

    await expect(page.getByRole('heading', { name: /onde está o teu hermes/i })).toBeVisible();

    // Step 1 → 2
    const urlField = page.getByLabel('Endereço do bridge');
    await urlField.fill(bridge.url);
    await page.getByTestId('url-next').click();
    await expect(page.getByLabel('Token de pairing')).toBeVisible();

    // Step 2 → back to 1, URL still there.
    await page.getByRole('button', { name: /voltar/i }).click();
    await expect(page.getByRole('heading', { name: /onde está o teu hermes/i })).toBeVisible();
    await expect(urlField).toHaveValue(bridge.url);

    // 1 → 2 again, then probe + 2 → 3.
    await page.getByTestId('url-next').click();
    await page.getByLabel('Token de pairing').fill(MOCK_DEFAULT_TOKEN);
    await page.getByTestId('probe-test').click();
    await expect(page.getByTestId('probe-result')).toContainText(
      /ligação estabelecida/i,
      { timeout: 5_000 },
    );
    await page.getByTestId('token-next').click();
    await expect(page.getByRole('heading', { name: /como queres falar/i })).toBeVisible();

    // Step 3 → back to 2: token field still populated.
    await page.getByRole('button', { name: /voltar/i }).click();
    await expect(page.getByLabel('Token de pairing')).toHaveValue(MOCK_DEFAULT_TOKEN);
  });

  test('token field is a multi-line textarea with the right aria-label', async () => {
    rig = await launchUnpaired();
    const { mainWindow: page } = rig;

    await page.getByLabel('Endereço do bridge').fill('ws://10.0.0.1:8765');
    await page.getByTestId('url-next').click();

    const token = page.getByLabel('Token de pairing');
    await expect(token).toBeVisible();
    // textarea, not input → tagName check.
    await expect(token).toHaveJSProperty('tagName', 'TEXTAREA');
    // 16-char tokens take one line; the bearer install.sh hands out is
    // 43+ chars — wrapping is essential so the user sees the full thing.
    await expect(token).toHaveAttribute('rows', /[1-9][0-9]?/);
    // Monospace so look-alikes (l vs 1) are distinguishable on paste.
    // getComputedStyle / Element are DOM types not in the Node tsconfig —
    // sidestep with an `unknown` window cast.
    const fontFamily = await token.evaluate((el) => {
      const w = globalThis as unknown as {
        getComputedStyle: (e: unknown) => { fontFamily: string };
      };
      return w.getComputedStyle(el).fontFamily;
    });
    expect(fontFamily.toLowerCase()).toMatch(/mono|courier|menlo|consolas/);
  });
});
