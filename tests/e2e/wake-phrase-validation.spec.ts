/**
 * E2E for the wake-word phrase validation UI surface (#64).
 *
 * Settings → Ativação → "Frase personalizada" mode renders:
 *   - a text input populated from settings.activation.wakePhrase
 *   - a yellow `data-testid="wake-phrase-hint"` when validateWakePhrase()
 *     rejects the current input
 *   - a Testar button (data-testid="wake-test-button") that's DISABLED
 *     while the phrase is invalid, ENABLED otherwise.
 *
 * The matcher rules (MIN_WAKE_PHRASE_CHARS, single-short-word rejection)
 * are already unit-tested in tests/unit/wake-phrase.test.ts; this spec
 * just pins the UI surface that surfaces them.
 */
import { expect, test } from '@playwright/test';
import {
  MOCK_DEFAULT_TOKEN,
  startMockBridge,
  type MockBridge,
} from '../integration/__mocks__/mock-bridge-server';
import {
  launchPackaged,
  openSettingsWindow,
  packagedAppExists,
  type TestRig,
} from './helpers/rig';

test.describe('wake-word phrase validation (Ativação tab)', () => {
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

  test('invalid phrase shows hint + disables Testar; valid phrase enables it', async () => {
    bridge = await startMockBridge();
    rig = await launchPackaged({
      bridgeUrl: bridge.url,
      bridgeToken: MOCK_DEFAULT_TOKEN,
      activation: { mode: 'WAKE_WORD' },
    });
    const settings = await openSettingsWindow(rig);
    await settings.getByTestId('tab-ativacao').click();

    // Default seeded settings put us in openww mode. Switch to phrase.
    await settings.getByRole('button', { name: /frase personalizada/i }).click();

    const input = settings.getByTestId('wake-phrase-input');
    await expect(input).toBeVisible();

    // Default phrase "hey hermes" is valid → no hint, button enabled.
    await expect(settings.getByTestId('wake-phrase-hint')).toHaveCount(0);
    await expect(settings.getByTestId('wake-test-button')).toBeEnabled();

    // Empty → hint appears, button disabled.
    await input.fill('');
    await expect(settings.getByTestId('wake-phrase-hint')).toBeVisible();
    await expect(settings.getByTestId('wake-test-button')).toBeDisabled();

    // Too short — "ab" normalises to 2 chars (< MIN_WAKE_PHRASE_CHARS=3).
    await input.fill('ab');
    await expect(settings.getByTestId('wake-phrase-hint')).toBeVisible();
    await expect(settings.getByTestId('wake-phrase-hint')).toContainText(/curt[ao]|m[íi]nimo/i);
    await expect(settings.getByTestId('wake-test-button')).toBeDisabled();

    // Single short word (3 chars, < 5) — also rejected.
    await input.fill('olá');
    await expect(settings.getByTestId('wake-phrase-hint')).toBeVisible();
    await expect(settings.getByTestId('wake-phrase-hint')).toContainText(/simples|duas/i);
    await expect(settings.getByTestId('wake-test-button')).toBeDisabled();

    // Valid: two-word phrase.
    await input.fill('hey hermes');
    await expect(settings.getByTestId('wake-phrase-hint')).toHaveCount(0);
    await expect(settings.getByTestId('wake-test-button')).toBeEnabled();

    // Valid: single long word (≥5 chars).
    await input.fill('computer');
    await expect(settings.getByTestId('wake-phrase-hint')).toHaveCount(0);
    await expect(settings.getByTestId('wake-test-button')).toBeEnabled();
  });
});
