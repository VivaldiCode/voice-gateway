/**
 * E2E for the round-10 UX additions:
 *
 *   #110  Settings → Avançado: auto-launch toggle persists in settings
 *         AND the renderer reflects the new value via onChange.
 *   #111  PairingWizard step-1 surfaces a datalist + chip list of the
 *         last recently-paired bridge URLs (seeded via settings).
 *   #112  Main VU meter appears while CAPTURING and disappears outside it.
 *   #113  System notification fires on SPEAKING → IDLE when the window
 *         loses focus (mocked Notification API to keep CI deterministic).
 *   #114  "Abrir registo de eventos" in Avançado returns the log file path.
 *   #115  PairingWizard URL field is pre-seeded from connection.draftUrl
 *         + the draft is persisted as the user types.
 */
import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  MOCK_DEFAULT_TOKEN,
  startMockBridge,
  type MockBridge,
} from '../integration/__mocks__/mock-bridge-server';
import { scriptedTextReply } from './helpers/mock-bridge-presets';
import { ConversationDriver } from './helpers/driver';
import {
  FIXTURES_DIR,
  launchPackaged,
  launchUnpaired,
  openSettingsWindow,
  packagedAppExists,
  type TestRig,
} from './helpers/rig';

const FAKE_AUDIO = join(FIXTURES_DIR, 'hi-how-are-you.wav');

test.describe('UX round-10 — Avançado, wizard suggestions, VU meter, notifications', () => {
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

  // ───── #110: auto-launch toggle round-trip
  test('Avançado: auto-launch toggle flips settings.ui.autoLaunch and persists', async () => {
    bridge = await startMockBridge();
    rig = await launchPackaged({
      bridgeUrl: bridge.url,
      bridgeToken: MOCK_DEFAULT_TOKEN,
    });
    const settings = await openSettingsWindow(rig);
    await settings.getByTestId('tab-avancado').click();
    const toggle = settings.getByTestId('auto-launch-toggle');
    await expect(toggle).not.toBeChecked();

    await toggle.click();
    await expect(toggle).toBeChecked();

    // Round-trip: settings.get reflects the new value.
    const persisted = await settings.evaluate(async () => {
      const w = globalThis as unknown as { vg: { settings: { get: () => Promise<{ ui: { autoLaunch: boolean } }> } } };
      const s = await w.vg.settings.get();
      return s.ui.autoLaunch;
    });
    expect(persisted).toBe(true);

    // Toggle off and confirm the round-trip is symmetric.
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    const persistedOff = await settings.evaluate(async () => {
      const w = globalThis as unknown as { vg: { settings: { get: () => Promise<{ ui: { autoLaunch: boolean } }> } } };
      const s = await w.vg.settings.get();
      return s.ui.autoLaunch;
    });
    expect(persistedOff).toBe(false);
  });

  // ───── #114: log reveal returns the path
  test('Avançado: "Abrir registo de eventos" returns the log file path', async () => {
    bridge = await startMockBridge();
    rig = await launchPackaged({
      bridgeUrl: bridge.url,
      bridgeToken: MOCK_DEFAULT_TOKEN,
    });
    const settings = await openSettingsWindow(rig);
    await settings.getByTestId('tab-avancado').click();
    await settings.getByTestId('reveal-log-file').click();
    // The displayed path code element appears once main responds.
    const pathEl = settings.getByTestId('reveal-log-path');
    await expect(pathEl).toBeVisible({ timeout: 5_000 });
    const shown = (await pathEl.textContent()) ?? '';
    expect(shown).toMatch(/main\.log$/);
  });

  // ───── #112: VU meter visibility lifecycle
  test('Main: VU meter renders during CAPTURING and is gone in IDLE', async () => {
    bridge = await startMockBridge({
      onClientMessage: scriptedTextReply('ok'),
    });
    rig = await launchPackaged({
      bridgeUrl: bridge.url,
      bridgeToken: MOCK_DEFAULT_TOKEN,
      fakeAudioFile: FAKE_AUDIO,
      activation: { minAudioMs: 50 },
      extraEnv: { VG_E2E_FAKE_TRANSCRIPT: 'oi' },
    });
    const { mainWindow } = rig;
    await expect(mainWindow.getByTestId('connection-indicator')).toContainText(/ligado|ms/i, {
      timeout: 15_000,
    });

    // Before any press: VU meter is not on the page.
    await expect(mainWindow.getByTestId('main-vu-meter')).toHaveCount(0);

    const driver = await ConversationDriver.attach(mainWindow);
    await driver.pressPtt();
    await driver.waitFor(['CAPTURING'], 5_000);

    // Now visible.
    await expect(mainWindow.getByTestId('main-vu-meter')).toBeVisible();

    await driver.releasePtt();
    await driver.waitFor(['IDLE'], 10_000);

    // And gone again.
    await expect(mainWindow.getByTestId('main-vu-meter')).toHaveCount(0);
  });

  // ───── #113: notification fires on SPEAKING → IDLE while window is "hidden"
  test('Main: notification fires on reply when document.hidden is true', async () => {
    bridge = await startMockBridge({
      onClientMessage: scriptedTextReply('hello you'),
    });
    rig = await launchPackaged({
      bridgeUrl: bridge.url,
      bridgeToken: MOCK_DEFAULT_TOKEN,
      fakeAudioFile: FAKE_AUDIO,
      activation: { minAudioMs: 50 },
      extraEnv: { VG_E2E_FAKE_TRANSCRIPT: 'oi' },
    });
    const { mainWindow } = rig;
    await expect(mainWindow.getByTestId('connection-indicator')).toContainText(/ligado|ms/i, {
      timeout: 15_000,
    });

    // Patch Notification + document.hidden BEFORE the turn so the effect
    // fires through our spy. The mock keeps the same shape — granted, with
    // a constructor that records its arguments.
    await mainWindow.evaluate(() => {
      const g = globalThis as unknown as {
        Notification: unknown;
        document: { hidden: boolean; hasFocus: () => boolean };
        __vg_notifications: Array<{ title: string; body: string }>;
      };
      g.__vg_notifications = [];
      class FakeNotification {
        static permission: 'granted' | 'denied' | 'default' = 'granted';
        static async requestPermission(): Promise<'granted'> {
          return 'granted';
        }
        constructor(title: string, init?: { body?: string }) {
          g.__vg_notifications.push({ title, body: init?.body ?? '' });
        }
      }
      g.Notification = FakeNotification;
      // Pretend the window has been hidden by the user.
      Object.defineProperty(g.document, 'hidden', { value: true, configurable: true });
      g.document.hasFocus = () => false;
    });

    const driver = await ConversationDriver.attach(mainWindow);
    await driver.runTurn({ holdMs: 200, until: ['IDLE'] });

    // The notification fires from a React useEffect watching conv.state +
    // conv.transcript. By the time the FSM reaches IDLE the effect has
    // been scheduled but may not have run yet — poll the spy array so
    // the assertion doesn't race the render. (Round-12 follow-up: this
    // was a flaky-passing-on-retry-1 spec on macos-latest headless.)
    await expect
      .poll(
        async () =>
          await mainWindow.evaluate(
            () =>
              (globalThis as unknown as { __vg_notifications: Array<{ title: string; body: string }> })
                .__vg_notifications.length,
          ),
        { timeout: 5_000 },
      )
      .toBeGreaterThan(0);

    const seen = await mainWindow.evaluate(
      () => (globalThis as unknown as { __vg_notifications: Array<{ title: string; body: string }> }).__vg_notifications,
    );
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]?.title).toMatch(/Hermes/);
    expect(seen[0]?.body).toMatch(/hello you/);
  });

  // ───── #111 + #115: wizard datalist + draft persistence
  test('PairingWizard: recent URLs surface as chips and draft persists across launches', async () => {
    // Seed an unpaired userData with two prior URLs + an in-flight draft so
    // the wizard's step 1 shows the suggestion list AND seeds the input.
    rig = await launchUnpaired();
    const seededDraft = 'ws://draft.example.com:8765';
    const recents = [
      'ws://old-bridge-one.lan:8765',
      'ws://old-bridge-two.lan:8765',
    ];
    // Write the settings file into the unpaired rig's userData and reload
    // the renderer so the wizard re-mounts and re-reads the store.
    const userData = rig.userData;
    await writeFile(
      join(userData, 'voice-gateway-settings.json'),
      JSON.stringify({
        settings: {
          pairing: null,
          activation: {
            mode: 'PUSH_TO_TALK',
            wakeWord: 'hey_jarvis',
            wakeMode: 'openww',
            wakePhrase: 'hey hermes',
            globalHotkey: 'CommandOrControl+Shift+H',
            vadThreshold: 0.5,
            vadSilenceMs: 800,
            minAudioMs: 200,
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
          audio: { inputDeviceId: null, outputDeviceId: null, outputMuted: false },
          ui: { language: 'pt', theme: 'dark', startMinimized: false, autoLaunch: false },
          connection: { recentUrls: recents, draftUrl: seededDraft },
          schemaVersion: 4,
        },
      }),
    );
    await rig.mainWindow.reload();
    await rig.mainWindow.waitForLoadState('domcontentloaded');

    // Step 1 should now pre-fill the URL from the draft.
    const urlInput = rig.mainWindow.getByTestId('url-input');
    await expect(urlInput).toBeVisible({ timeout: 10_000 });
    await expect(urlInput).toHaveValue(seededDraft);

    // Both recent URLs appear as clickable chips.
    const chips = rig.mainWindow.getByTestId('recent-bridge-chip');
    await expect(chips).toHaveCount(2);
    await expect(chips.nth(0)).toContainText('old-bridge-one');
    await expect(chips.nth(1)).toContainText('old-bridge-two');

    // Click a chip → input adopts that URL.
    await chips.nth(1).click();
    await expect(urlInput).toHaveValue('ws://old-bridge-two.lan:8765');

    // Type a fresh URL and wait past the 400 ms debounce.
    await urlInput.fill('ws://newly-typed.lan:8765');
    await rig.mainWindow.waitForTimeout(600);

    // settings.connection.draftUrl now reflects the typed value.
    const persistedDraft = await rig.mainWindow.evaluate(async () => {
      const w = globalThis as unknown as { vg: { settings: { get: () => Promise<{ connection: { draftUrl: string } }> } } };
      const s = await w.vg.settings.get();
      return s.connection.draftUrl;
    });
    expect(persistedDraft).toBe('ws://newly-typed.lan:8765');
  });
});
