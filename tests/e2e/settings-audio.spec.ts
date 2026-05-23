/**
 * E2E coverage for the Settings panel's audio surfaces:
 *
 *   1. Microfone → "Saída de áudio" — the new speaker selector. Renders the
 *      list of audiooutput devices, lets the user click "Testar saída",
 *      ends without surfacing an error.
 *
 *   2. Voz → "Testa a voz" — the custom-text TTS test added earlier. Types
 *      a phrase, clicks "Reproduzir", and confirms the renderer received
 *      at least one chunk on the AUDIO_TEST_TTS_CHUNK channel.
 *
 * Both tests run against the packaged app with a mock bridge (the
 * paneless TTS test doesn't need the bridge, but the panel itself needs
 * `vg.tts.test` to be wired through main).
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

test.describe('Settings — audio surfaces', () => {
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

  async function setup(): Promise<Page> {
    bridge = await startMockBridge();
    rig = await launchPackaged({
      bridgeUrl: bridge.url,
      bridgeToken: MOCK_DEFAULT_TOKEN,
    });
    return openSettingsWindow(rig);
  }

  test('Microfone → Saída de áudio: list populates and Testar saída completes', async () => {
    const settings = await setup();
    await settings.getByTestId('tab-microfone').click();

    const select = settings.getByTestId('output-device-select');
    await expect(select).toBeVisible();
    // Must always have the "Predefinido do sistema" option, even before
    // mic permission is granted.
    await expect(select).toContainText(/predefinido do sistema/i);

    // Counter for how many distinct output device options enumerated.
    const optionCount = await select.locator('option').count();
    // eslint-disable-next-line no-console
    console.log(`[e2e] output devices listed: ${optionCount}`);
    // At least the system default (1), often more.
    expect(optionCount).toBeGreaterThanOrEqual(1);

    const testBtn = settings.getByTestId('output-test-button');
    await expect(testBtn).toBeVisible();
    await expect(testBtn).toBeEnabled();
    await testBtn.click();

    // Button label flips to "A reproduzir…" while a tone is playing, then
    // back. Wait for the disabled-while-playing state to release.
    await expect(testBtn).toBeEnabled({ timeout: 5_000 });
    // No mic-test-error pill should have appeared.
    await expect(settings.getByTestId('mic-test-error')).toHaveCount(0);
  });

  test('Voz → Testa a voz: custom text reaches AudioPlayback via test chunk channel', async () => {
    const settings = await setup();
    await settings.getByTestId('tab-voz').click();

    // Instrument the renderer to count AUDIO_TEST_TTS_CHUNK frames.
    await settings.evaluate(() => {
      interface W {
        vg: {
          tts: {
            onTestChunk: (
              cb: (c: { seq: number; format: string; data: string; done?: boolean }) => void,
            ) => () => void;
          };
        };
        __vg_test_chunks?: number;
        __vg_test_bytes?: number;
        __vg_test_done?: boolean;
      }
      const w = globalThis as unknown as W;
      w.__vg_test_chunks = 0;
      w.__vg_test_bytes = 0;
      w.__vg_test_done = false;
      w.vg.tts.onTestChunk((c) => {
        if (c.done) {
          w.__vg_test_done = true;
          return;
        }
        w.__vg_test_chunks = (w.__vg_test_chunks ?? 0) + 1;
        w.__vg_test_bytes = (w.__vg_test_bytes ?? 0) + atob(c.data).length;
      });
    });

    // Type a short test phrase. The default placeholder + maxlength is wired
    // through `prepareTestText`, so anything <= 240 chars works.
    const textArea = settings.getByTestId('tts-test-text');
    await expect(textArea).toBeVisible();
    await textArea.fill('Olá, isto é um teste rápido.');

    const playBtn = settings.getByTestId('tts-test-button');
    await expect(playBtn).toBeEnabled();
    await playBtn.click();

    // Wait for at least one chunk on the test channel. Skip cleanly if
    // Piper isn't installed — `vg.tts.test` returns { ok: false } in that
    // case and we surface it as a test.skip rather than a hard failure.
    try {
      await expect
        .poll(
          async () =>
            await settings.evaluate(
              () => (globalThis as unknown as { __vg_test_chunks?: number }).__vg_test_chunks ?? 0,
            ),
          { timeout: 30_000 },
        )
        .toBeGreaterThan(0);
    } catch (err) {
      // If we got zero chunks, the TTS adapter likely surfaced an error in
      // the UI's hint banner — check for it and skip with that message.
      const hintText = await settings
        .locator('text=/Piper|whisper|venv|pip/i')
        .first()
        .textContent()
        .catch(() => null);
      if (hintText) {
        test.skip(true, `Piper not ready in test environment: ${hintText.trim()}`);
      }
      throw err;
    }

    const stats = await settings.evaluate(() => ({
      chunks: (globalThis as unknown as { __vg_test_chunks?: number }).__vg_test_chunks ?? 0,
      bytes: (globalThis as unknown as { __vg_test_bytes?: number }).__vg_test_bytes ?? 0,
      done: (globalThis as unknown as { __vg_test_done?: boolean }).__vg_test_done ?? false,
    }));
    // eslint-disable-next-line no-console
    console.log('[e2e] tts test chunks:', stats);
    expect(stats.chunks).toBeGreaterThan(0);
    expect(stats.bytes).toBeGreaterThan(1_000);
  });
});
