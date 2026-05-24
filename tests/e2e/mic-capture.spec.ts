/**
 * Microphone capture E2E for the packaged app.
 *
 * Two checks:
 *   1. getUserMedia probe — confirms the bundle has the right
 *      NSMicrophoneUsageDescription entitlements so MediaStream creation
 *      doesn't reject with AbortError.
 *   2. VU meter — the renderer's audio-worklet downsampler must emit
 *      non-zero RMS for the test mic to count as wired.
 *
 * Requires `npm run build:mac` AND macOS mic permission already granted
 * to the bundle (run the app interactively once and click Allow).
 */
import { expect, test } from '@playwright/test';
import { hostname } from 'node:os';
import {
  launchPackaged,
  openSettingsWindow,
  packagedAppExists,
  type TestRig,
} from './helpers/rig';

test.describe('mic capture — packaged app', () => {
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

  test('diagnose getUserMedia from the renderer of the packaged build', async () => {
    rig = await launchPackaged({
      bridgeUrl: 'ws://127.0.0.1:9/ws',
      bridgeToken: 'fake-e2e-token-1234567890',
    });
    const { mainWindow } = rig;

    await expect(
      mainWindow.locator('[data-testid="connection-indicator"], [data-testid="loading"]'),
    ).toBeVisible({ timeout: 15_000 });

    type MicStatus = 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown';
    const macStatus = await mainWindow.evaluate<MicStatus>(() =>
      (
        globalThis as unknown as { vg: { audio: { getMicStatus: () => Promise<MicStatus> } } }
      ).vg.audio.getMicStatus(),
    );
    // eslint-disable-next-line no-console
    console.log(`[probe] macOS mic status = ${macStatus}`);

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

    const probeProd = await mainWindow.evaluate(async () => {
      interface Track {
        stop: () => void;
      }
      interface Stream {
        getTracks: () => Track[];
      }
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

    if (macStatus !== 'granted') {
      throw new Error(
        `macOS mic permission is "${macStatus}". Grant the running bundle access in System Settings → Privacy → Microphone, then re-run.`,
      );
    }
    expect(
      probeBasic.ok,
      `getUserMedia({audio: true}) failed: ${probeBasic.name} — ${probeBasic.message}`,
    ).toBe(true);
  });

  test('Razer Seiren / default mic produces non-zero RMS during a 3 s test', async () => {
    rig = await launchPackaged({
      bridgeUrl: 'ws://127.0.0.1:9/ws',
      bridgeToken: 'fake-e2e-token-1234567890',
    });
    const { mainWindow } = rig;

    await expect(
      mainWindow.locator('[data-testid="connection-indicator"], [data-testid="loading"]'),
    ).toBeVisible({ timeout: 15_000 });

    const settingsWindow = await openSettingsWindow(rig);
    await settingsWindow.getByTestId('tab-microfone').click();

    const permStatus = await settingsWindow
      .locator('[data-testid="mic-permission"]')
      .getAttribute('data-status');
    // eslint-disable-next-line no-console
    console.log(`[mic-permission] status = ${permStatus} (host=${hostname()})`);

    await settingsWindow.getByTestId('mic-start-test').click();

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

    expect(permStatus, 'macOS mic permission must be granted before this test runs').toBe(
      'granted',
    );
    expect(
      errorText,
      `mic test surfaced an error: ${errorText ?? '(none)'}`,
    ).toBeFalsy();
    expect(samples.length, 'capture pipeline never emitted any frames').toBeGreaterThan(0);
    expect(
      maxLevel,
      `mic produced an absolute-zero signal across ${samples.length} samples.`,
    ).toBeGreaterThan(0);
  });
});
