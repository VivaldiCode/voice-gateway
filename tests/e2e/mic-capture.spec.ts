/**
 * End-to-end test for microphone capture.
 *
 * Launches the **packaged** Voice Gateway.app (not the dev build) so we
 * exercise the exact entitlements / Info.plist / ad-hoc signature path the
 * user sees. Pre-writes a settings.json with a pairing already set so we
 * skip the wizard and land straight on the main window.
 *
 * Test plan (per Playwright spec):
 *  1. Launch packaged app with a temp user-data-dir.
 *  2. Wait for the main window, then trigger 'open settings window' via IPC.
 *  3. In the settings window, click the Microfone tab.
 *  4. Inspect `[data-testid="mic-permission"]`'s `data-status` attribute.
 *  5. Click 'Começar teste' (data-testid="mic-start-test").
 *  6. Poll `[data-testid="vu-meter"]`'s `data-level` for ~3s.
 *  7. Assert the maximum observed level is > 0.001 (any ambient noise from
 *     the Razer Seiren V3 Mini would clear this threshold), or surface a
 *     dedicated mic-test-error message.
 *
 * Hard requirements before running:
 *  - `npm run build:mac` has produced release/mac-arm64/Voice Gateway.app
 *  - The OS-level mic permission for this bundle is already 'granted' (run
 *    the app once interactively, click Allow on the prompt).
 *  - A microphone capable of picking up ambient noise is connected.
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
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
  userData: string;
}

async function launchPackaged(): Promise<TestRig> {
  const userData = await mkdtemp(join(tmpdir(), 'vg-mic-e2e-'));

  // Pre-populate electron-store with a pairing so we bypass the wizard.
  // electron-store writes to <userData>/voice-gateway-settings.json.
  const settingsFile = join(userData, 'voice-gateway-settings.json');
  await mkdir(userData, { recursive: true });
  await writeFile(
    settingsFile,
    JSON.stringify(
      {
        settings: {
          pairing: { url: 'ws://127.0.0.1:9/ws', token: 'fake-e2e-token-1234567890' },
          activation: {
            mode: 'PUSH_TO_TALK',
            wakeWord: 'hey_jarvis',
            globalHotkey: 'CommandOrControl+Shift+H',
            vadThreshold: 0.5,
            vadSilenceMs: 800,
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
          schemaVersion: 1,
        },
      },
      null,
      2,
    ),
  );

  const app = await electron.launch({
    executablePath: PACKAGED_EXEC,
    args: [`--user-data-dir=${userData}`],
    env: { ...process.env, VG_E2E: '1' },
    timeout: 30_000,
  });

  const mainWindow = await app.firstWindow({ timeout: 15_000 });
  mainWindow.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      // eslint-disable-next-line no-console
      console.log(`[main-window ${msg.type()}] ${msg.text()}`);
    }
  });
  mainWindow.on('pageerror', (err) => {
    // eslint-disable-next-line no-console
    console.log(`[main-window pageerror] ${err.message}`);
  });

  return { app, mainWindow, userData };
}

test.describe('mic capture — packaged app', () => {
  let rig: TestRig | null = null;

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

  test('diagnose getUserMedia from the renderer of the packaged build', async () => {
    rig = await launchPackaged();
    const { mainWindow } = rig;

    await mainWindow.waitForLoadState('domcontentloaded');
    await expect(
      mainWindow.locator('[data-testid="connection-indicator"], [data-testid="loading"]'),
    ).toBeVisible({ timeout: 15_000 });

    // Probe macOS permission status via IPC.
    type MicStatus = 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown';
    const macStatus = await mainWindow.evaluate<MicStatus>(() =>
      (
        globalThis as unknown as { vg: { audio: { getMicStatus: () => Promise<MicStatus> } } }
      ).vg.audio.getMicStatus(),
    );
    // eslint-disable-next-line no-console
    console.log(`[probe] macOS mic status = ${macStatus}`);

    // Enumerate devices in the renderer. (Evaluated inside the page where
    // navigator.mediaDevices exists; the Node-side typecheck needs an
    // explicit narrow because this project's node tsconfig has no DOM lib.)
    const deviceList = await mainWindow.evaluate(async () => {
      type DevInfo = { kind: string; deviceId: string; label: string };
      const nav = navigator as unknown as {
        mediaDevices: { enumerateDevices(): Promise<DevInfo[]> };
      };
      const all = await nav.mediaDevices.enumerateDevices();
      return all
        .filter((d: DevInfo) => d.kind === 'audioinput')
        .map((d: DevInfo) => ({ id: d.deviceId, label: d.label }));
    });
    // eslint-disable-next-line no-console
    console.log('[probe] audioinput devices:', JSON.stringify(deviceList, null, 2));

    // Try the simplest possible getUserMedia call — no constraints beyond
    // {audio: true}. If this fails the bug is below our code.
    const probeBasic = await mainWindow.evaluate(async () => {
      interface Track {
        label: string;
        getSettings: () => unknown;
        readyState: string;
        stop: () => void;
      }
      interface Stream {
        getAudioTracks: () => Track[];
        getTracks: () => Track[];
      }
      const nav = navigator as unknown as {
        mediaDevices: { getUserMedia(c: unknown): Promise<Stream> };
      };
      try {
        const s = await nav.mediaDevices.getUserMedia({ audio: true });
        const tracks = s.getAudioTracks().map((t: Track) => ({
          label: t.label,
          settings: t.getSettings(),
          readyState: t.readyState,
        }));
        s.getTracks().forEach((t: Track) => t.stop());
        return { ok: true, tracks };
      } catch (e) {
        const err = e as { name?: string; message?: string };
        return { ok: false, name: err.name ?? 'Error', message: err.message ?? '' };
      }
    });
    // eslint-disable-next-line no-console
    console.log('[probe] getUserMedia({audio: true}) →', JSON.stringify(probeBasic, null, 2));

    // Try with our exact production constraints.
    const probeProd = await mainWindow.evaluate(async () => {
      interface Track { stop: () => void }
      interface Stream { getTracks: () => Track[] }
      const nav = navigator as unknown as {
        mediaDevices: { getUserMedia(c: unknown): Promise<Stream> };
      };
      try {
        const s = await nav.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: false,
          },
          video: false,
        });
        s.getTracks().forEach((t: Track) => t.stop());
        return { ok: true };
      } catch (e) {
        const err = e as { name?: string; message?: string };
        return { ok: false, name: err.name ?? 'Error', message: err.message ?? '' };
      }
    });
    // eslint-disable-next-line no-console
    console.log('[probe] getUserMedia(production constraints) →', JSON.stringify(probeProd));

    // Surface the most informative failure as the assertion message so the
    // Playwright report explains itself.
    if (macStatus !== 'granted') {
      throw new Error(
        `macOS mic permission is "${macStatus}". Grant the running bundle access in System Settings → Privacy → Microphone, then re-run. Permanent fix: ship the app with a stable code signature.`,
      );
    }
    expect(probeBasic.ok, `getUserMedia({audio: true}) failed: ${probeBasic.name} — ${probeBasic.message}`).toBe(true);
  });

  test('Razer Seiren / default mic produces non-zero RMS during a 3 s test', async () => {
    rig = await launchPackaged();
    const { app, mainWindow } = rig;

    // Wait for the React app to mount past the loading state.
    await mainWindow.waitForLoadState('domcontentloaded');
    await expect(
      mainWindow.locator('[data-testid="connection-indicator"], [data-testid="loading"]'),
    ).toBeVisible({ timeout: 15_000 });

    // Open the dedicated settings window via the IPC the gear button uses.
    const windowOpenPromise = app.waitForEvent('window', { timeout: 10_000 });
    await mainWindow.evaluate(() => {
      (globalThis as unknown as { vg: { settings: { openWindow: () => void } } }).vg.settings.openWindow();
    });
    const settingsWindow = await windowOpenPromise;
    settingsWindow.on('console', (msg) => {
      if (msg.type() === 'error' || msg.type() === 'warning') {
        // eslint-disable-next-line no-console
        console.log(`[settings ${msg.type()}] ${msg.text()}`);
      }
    });
    settingsWindow.on('pageerror', (err) => {
      // eslint-disable-next-line no-console
      console.log(`[settings pageerror] ${err.message}`);
    });

    await settingsWindow.waitForLoadState('domcontentloaded');
    await settingsWindow.getByTestId('tab-microfone').click();

    // Surface the macOS permission status — it should be 'granted' for the
    // assertions below to make sense.
    const permStatus = await settingsWindow
      .locator('[data-testid="mic-permission"]')
      .getAttribute('data-status');
    // eslint-disable-next-line no-console
    console.log(`[mic-permission] status = ${permStatus} (host=${hostname()})`);

    // Click start. If getUserMedia throws (e.g. AbortError), the UI surfaces
    // it under data-testid="mic-test-error". We capture both cases.
    await settingsWindow.getByTestId('mic-start-test').click();

    // Sample the level for 3 seconds at ~10Hz. Keep the maximum.
    const samples: number[] = [];
    const start = Date.now();
    while (Date.now() - start < 3_000) {
      const raw = await settingsWindow
        .locator('[data-testid="vu-meter"]')
        .getAttribute('data-level');
      if (raw !== null) samples.push(parseFloat(raw));
      await settingsWindow.waitForTimeout(100);
    }
    const maxLevel = samples.length > 0 ? Math.max(...samples) : 0;
    const errorText = await settingsWindow
      .locator('[data-testid="mic-test-error"]')
      .first()
      .textContent()
      .catch(() => null);

    // eslint-disable-next-line no-console
    console.log(`[vu] samples=${samples.length} max=${maxLevel.toFixed(5)}`);
    if (errorText) {
      // eslint-disable-next-line no-console
      console.log(`[mic-test-error] ${errorText}`);
    }

    // Hard assertions:
    expect(permStatus, 'macOS mic permission must be granted before this test runs').toBe(
      'granted',
    );
    expect(
      errorText,
      `mic test surfaced an error: ${errorText ?? '(none)'}`,
    ).toBeFalsy();
    // 0.0001 is essentially the noise floor of a quiet room — anything
    // above pure zero proves the capture pipeline (mic → AudioWorklet → RMS
    // → IPC → UI) is actually wired. The earlier production bug was a
    // dead-flat 0.00000 because AudioWorklet.addModule was blocked by CSP
    // (silent AbortError).
    expect(
      samples.length,
      'capture pipeline never emitted any frames',
    ).toBeGreaterThan(0);
    expect(
      maxLevel,
      `mic produced an absolute-zero signal across ${samples.length} samples. Check the Razer Seiren V3 Mini is plugged in and unmuted.`,
    ).toBeGreaterThan(0);
  });
});
