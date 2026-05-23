/**
 * Wake-word E2E.
 *
 * Verifies the full UI plumbing for the "Testar agora" button in Settings
 * → Ativação. To make the test deterministic — and independent of whether
 * openwakeword, sounddevice or whisper.cpp happen to be installed on the
 * CI/dev machine — the main process is launched with
 * `VG_WAKE_E2E_FAKE=1`, which swaps the production runner for
 * `resources/python/fake_wake_runner.py` (deterministic JSON-line output,
 * no audio, no models).
 *
 * What we exercise:
 *   - settings rendered for both wake modes (openww + phrase)
 *   - the test runner is spawned with the right args (verified via the
 *     ready event arriving in the renderer)
 *   - the renderer surfaces 'À escuta — fala agora!' on ready
 *   - the renderer surfaces '✅ Detectei!' when wake fires
 *
 * What we DO NOT exercise here:
 *   - real openwakeword model inference (covered by manual install + wiki)
 *   - real whisper streaming (covered by audio-conversation.spec.ts)
 *   - sounddevice mic capture (no headless way to do this)
 */
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const PACKAGED_EXEC = join(
  ROOT,
  'release/mac-arm64/Voice Gateway.app/Contents/MacOS/Voice Gateway',
);

interface TestRig {
  app: ElectronApplication;
  mainWindow: Page;
  settingsWindow: Page;
  userData: string;
}

async function seedSettings(userData: string): Promise<void> {
  const settingsFile = join(userData, 'voice-gateway-settings.json');
  await mkdir(userData, { recursive: true });
  await writeFile(
    settingsFile,
    JSON.stringify({
      settings: {
        // Pre-paired to a dead port — we don't need a live bridge for the
        // wake-test button, only the local IPC.
        pairing: { url: 'ws://127.0.0.1:9/ws', token: 'fake-e2e-token-1234567890' },
        activation: {
          mode: 'WAKE_WORD',
          wakeWord: 'hey_jarvis',
          wakeMode: 'openww',
          wakePhrase: 'hey hermes',
          globalHotkey: 'CommandOrControl+Shift+H',
          vadThreshold: 0.5,
          vadSilenceMs: 800,
          minAudioMs: 300,
        },
        stt: {
          provider: 'whisper_local',
          language: 'auto',
          whisperLocal: { model: 'base' },
          openai: { apiKey: '', model: 'whisper-1' },
        },
        tts: {
          provider: 'piper_local',
          piper: { modelId: 'en_US-lessac-medium' },
          elevenlabs: { apiKey: '', voiceId: '', modelId: 'eleven_turbo_v2_5' },
        },
        audio: { inputDeviceId: null, outputDeviceId: null },
        ui: { language: 'pt', theme: 'dark', startMinimized: false },
        schemaVersion: 2,
      },
    }),
  );
}

async function launchWithFakeRunner(): Promise<TestRig> {
  const userData = await mkdtemp(join(tmpdir(), 'vg-wake-e2e-'));
  await seedSettings(userData);
  const app = await electron.launch({
    executablePath: PACKAGED_EXEC,
    args: [`--user-data-dir=${userData}`],
    env: { ...process.env, VG_E2E: '1', VG_WAKE_E2E_FAKE: '1' },
    timeout: 30_000,
  });
  const mainWindow = await app.firstWindow({ timeout: 15_000 });
  mainWindow.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      // eslint-disable-next-line no-console
      console.log(`[main ${msg.type()}] ${msg.text()}`);
    }
  });
  mainWindow.on('pageerror', (err) => {
    // eslint-disable-next-line no-console
    console.log(`[main pageerror] ${err.message}`);
  });
  await mainWindow.waitForLoadState('domcontentloaded');

  // Open the dedicated settings window via the IPC the gear icon uses.
  const settingsPromise = app.waitForEvent('window', { timeout: 10_000 });
  await mainWindow.evaluate(() => {
    const w = globalThis as unknown as {
      vg: { settings: { openWindow: () => void } };
    };
    w.vg.settings.openWindow();
  });
  const settingsWindow = await settingsPromise;
  settingsWindow.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      // eslint-disable-next-line no-console
      console.log(`[settings ${msg.type()}] ${msg.text()}`);
    }
  });
  await settingsWindow.waitForLoadState('domcontentloaded');
  return { app, mainWindow, settingsWindow, userData };
}

test.describe('wake-word — packaged app, deterministic fake runner', () => {
  let rig: TestRig | null = null;

  test.beforeAll(() => {
    if (!existsSync(PACKAGED_EXEC)) {
      test.skip(true, `Packaged app missing at ${PACKAGED_EXEC}. Run \`npm run build:mac\` first.`);
    }
  });

  test.afterEach(async () => {
    if (rig) {
      try {
        await rig.app.close();
      } catch {
        // ignore
      }
      try {
        await rm(rig.userData, { recursive: true, force: true });
      } catch {
        // ignore
      }
      rig = null;
    }
  });

  test('openww mode: Testar agora fires the deterministic fake runner', async () => {
    rig = await launchWithFakeRunner();
    const { settingsWindow } = rig;

    await settingsWindow.getByTestId('tab-ativacao').click();

    // Default wakeMode is openww (per the seeded settings). Test button visible.
    await expect(settingsWindow.getByTestId('wake-test-button')).toBeVisible();
    await expect(settingsWindow.getByTestId('wake-test-status')).toContainText(/pronto/i);

    await settingsWindow.getByTestId('wake-test-button').click();

    // The fake runner emits 'ready' immediately → the UI flips to "À escuta".
    await expect(settingsWindow.getByTestId('wake-test-status')).toContainText(
      /escuta|fala agora/i,
      { timeout: 5_000 },
    );

    // After ~1.5s the fake emits 'wake' → "✅ Detectei!".
    await expect(settingsWindow.getByTestId('wake-test-status')).toContainText(
      /detectei/i,
      { timeout: 6_000 },
    );
  });

  test('phrase mode: Testar agora streams transcript + fires', async () => {
    rig = await launchWithFakeRunner();
    const { settingsWindow } = rig;

    await settingsWindow.getByTestId('tab-ativacao').click();

    // Switch to phrase mode via the ProviderToggle.
    await settingsWindow.getByRole('button', { name: /frase personalizada/i }).click();

    // Phrase input is pre-seeded with "hey hermes" from the seeded settings.
    const phraseInput = settingsWindow.getByTestId('wake-phrase-input');
    await expect(phraseInput).toHaveValue('hey hermes');

    await settingsWindow.getByTestId('wake-test-button').click();

    // Live transcript pane should populate from the fake runner's stdout.
    await expect(settingsWindow.getByTestId('wake-test-transcript')).toContainText(
      /ouvi:/i,
      { timeout: 6_000 },
    );
    await expect(settingsWindow.getByTestId('wake-test-status')).toContainText(
      /detectei/i,
      { timeout: 6_000 },
    );
  });

  test('switching the typed phrase resets the tester state', async () => {
    rig = await launchWithFakeRunner();
    const { settingsWindow } = rig;
    await settingsWindow.getByTestId('tab-ativacao').click();
    await settingsWindow.getByRole('button', { name: /frase personalizada/i }).click();

    // Run one test → fires → "Detectei!"
    await settingsWindow.getByTestId('wake-test-button').click();
    await expect(settingsWindow.getByTestId('wake-test-status')).toContainText(
      /detectei/i,
      { timeout: 6_000 },
    );

    // Edit the phrase — the tester should re-arm to "Pronto a testar".
    await settingsWindow.getByTestId('wake-phrase-input').fill('hey claude please');
    await expect(settingsWindow.getByTestId('wake-test-status')).toContainText(
      /pronto a testar/i,
      { timeout: 3_000 },
    );
  });
});
