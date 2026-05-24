/**
 * Settings tabs beyond the audio surfaces already covered by
 * settings-audio.spec.ts. Each test exercises one tab's persistence path
 * via the same `vg.settings.get` / `set` API the panel itself uses.
 *
 *   #53 — STT language change persists.
 *   #54 — Voz tab: Piper voice picker is populated with PIPER_VOICES.
 *   #55 — Reconhecimento tab: OpenAI key field accepts + persists.
 *   #56 — Conexão tab: Re-emparelhar clears pairing AND the main window
 *         re-enters the wizard (regression-protects the App.tsx fix).
 */
import { expect, test, type Page } from '@playwright/test';
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

test.describe('Settings — deep tabs', () => {
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

  async function setup(): Promise<{ settings: Page; main: Page }> {
    bridge = await startMockBridge();
    rig = await launchPackaged({
      bridgeUrl: bridge.url,
      bridgeToken: MOCK_DEFAULT_TOKEN,
    });
    const settings = await openSettingsWindow(rig);
    return { settings, main: rig.mainWindow };
  }

  // ───── #53: STT language persists
  test('Reconhecimento → Idioma change persists across IPC', async () => {
    const { settings, main } = await setup();
    await settings.getByTestId('tab-reconhecimento').click();

    // Default in seeded settings is 'auto'. Flip to 'pt'.
    const langSelect = settings.getByRole('combobox').filter({ hasText: /detetar|português|english/i });
    await expect(langSelect).toBeVisible();
    await langSelect.selectOption('pt');

    // Verify via the main window's vg.settings.get (the panel writes,
    // main process broadcasts back).
    await expect
      .poll(
        async () =>
          await main.evaluate(async () => {
            const w = globalThis as unknown as {
              vg: { settings: { get: () => Promise<{ stt: { language: string } }> } };
            };
            return (await w.vg.settings.get()).stt.language;
          }),
        { timeout: 3_000 },
      )
      .toBe('pt');
  });

  // ───── #54: Voz tab Piper voice picker is populated
  test('Voz → Piper voice picker lists the known voices', async () => {
    const { settings } = await setup();
    await settings.getByTestId('tab-voz').click();

    // Default seeded provider is piper_local → the "Voz Piper" select
    // is rendered. The dropdown has no test-id; locate by the option
    // values from the shared PIPER_VOICES catalogue.
    await expect(
      settings.locator('option[value="en_US-lessac-medium"]'),
    ).toHaveCount(1);
    // At least one Portuguese voice is in the catalogue too.
    const ptCount = await settings.locator('option[value*="pt_"]').count();
    expect(ptCount, 'expected at least one pt_* voice in the catalogue').toBeGreaterThanOrEqual(1);
  });

  // ───── #55: OpenAI key persists via Reconhecimento tab
  test('Reconhecimento → switch to openai_whisper persists the new provider', async () => {
    const { settings, main } = await setup();
    await settings.getByTestId('tab-reconhecimento').click();

    // ProviderToggle exposes the OpenAI option as a button labelled
    // "OpenAI Whisper API". Click it.
    await settings.getByRole('button', { name: /openai whisper api/i }).click();

    // Type a fake API key (no real network call — just persistence).
    const keyInput = settings.getByLabel('Chave API OpenAI');
    await expect(keyInput).toBeVisible();
    await keyInput.fill('sk-fake-test-key-1234567890');
    // The persist runs on blur.
    await keyInput.blur();

    await expect
      .poll(
        async () =>
          await main.evaluate(async () => {
            const w = globalThis as unknown as {
              vg: {
                settings: {
                  get: () => Promise<{
                    stt: { provider: string; openai: { apiKey: string } };
                  }>;
                };
              };
            };
            const s = await w.vg.settings.get();
            return { provider: s.stt.provider, apiKey: s.stt.openai.apiKey };
          }),
        { timeout: 3_000 },
      )
      .toEqual({ provider: 'openai_whisper', apiKey: 'sk-fake-test-key-1234567890' });
  });

  // ───── #56: Conexão → Re-emparelhar surfaces the wizard
  test('Conexão → Re-emparelhar clears pairing AND main re-enters the wizard', async () => {
    const { settings, main } = await setup();
    await settings.getByTestId('tab-conexao').click();

    // Re-emparelhar button has no test ID; locate by text.
    await settings.getByRole('button', { name: /re-emparelhar agora/i }).click();

    // The settings window closes itself; the main window should now show
    // the wizard step-1 heading (regression-protects App.tsx's re-evaluation
    // of `wizardActive` whenever pairing transitions to null).
    await expect(
      main.getByRole('heading', { name: /onde está o teu hermes/i }),
    ).toBeVisible({ timeout: 8_000 });
  });
});
