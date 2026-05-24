/**
 * Behavioural E2Es that don't fit into conversation-flows.spec.ts:
 *
 *   #32 — explicit cancel mid-CAPTURING (different code path from the
 *         short-PTT warning: state goes through CAPTURING and the user
 *         actively cancels via `vg.conversation.cancel`).
 *
 *   #33 — settings round-trip survives an app restart. Validates that
 *         electron-store actually persists what we set.
 *
 *   #34 — switching `tts.provider` via IPC rebuilds the orchestrator
 *         (TTS_STATUS reflects the new adapter's id). Catches a class of
 *         bugs where the old orchestrator stays bound to the old adapter.
 *
 *   #35 — server-side audio path: bridge sends a `response_audio_chunk`
 *         header + raw binary PCM frame; renderer's AudioPlayback should
 *         receive the chunk via `tts_chunk` IPC.
 *
 *   #37 — Settings → Avançado → factory reset wipes the pairing and the
 *         schema-versioned fields, returning the user to the wizard.
 */
import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import {
  MOCK_DEFAULT_TOKEN,
  startMockBridge,
  type MockBridge,
} from '../integration/__mocks__/mock-bridge-server';
import {
  captureTranscripts,
  composeBridge,
  sendServerAudio,
} from './helpers/mock-bridge-presets';
import {
  FIXTURES_DIR,
  holdPtt,
  instrumentTtsCounter,
  launchPackaged,
  openSettingsWindow,
  packagedAppExists,
  readVgStats,
  vgTmpdir,
  waitForState,
  writeSeedSettings,
  PACKAGED_EXEC,
  type TestRig,
} from './helpers/rig';
import { _electron as electron } from '@playwright/test';

const FAKE_AUDIO = join(FIXTURES_DIR, 'hi-how-are-you.wav');

test.describe('conversation extras', () => {
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

  // ───── #32: explicit cancel mid-capture
  test('cancel() mid-CAPTURING returns to IDLE without hitting STT or bridge', async () => {
    const transcripts: string[] = [];
    bridge = await startMockBridge({
      onClientMessage: composeBridge(captureTranscripts(transcripts)),
    });
    rig = await launchPackaged({
      bridgeUrl: bridge.url,
      bridgeToken: MOCK_DEFAULT_TOKEN,
      fakeAudioFile: FAKE_AUDIO,
      activation: { minAudioMs: 50 },
      extraEnv: { VG_E2E_FAKE_TRANSCRIPT: 'should never reach the bridge' },
    });
    const { mainWindow } = rig;
    await expect(mainWindow.getByTestId('connection-indicator')).toContainText(/ligado|ms/i, {
      timeout: 15_000,
    });
    await instrumentTtsCounter(mainWindow);

    // Press PTT, give it time to actually enter CAPTURING.
    await mainWindow.getByTestId('call-button').dispatchEvent('pointerdown');
    await waitForState(mainWindow, ['CAPTURING'], { timeoutMs: 5_000 });

    // Fire the explicit cancel IPC (the same one the renderer exposes via
    // a future "Cancel" button — for now exercised via window.vg).
    await mainWindow.evaluate(() => {
      const w = globalThis as unknown as {
        vg: { conversation: { cancel: () => void } };
      };
      w.vg.conversation.cancel();
    });

    // FSM goes back to IDLE (rest state). transcribe() was never called.
    await waitForState(mainWindow, ['IDLE'], { timeoutMs: 5_000 });

    await mainWindow.waitForTimeout(500);
    expect(transcripts).toHaveLength(0);
    const stats = await readVgStats(mainWindow);
    expect(stats.warnings).toHaveLength(0);
    expect(stats.errors).toHaveLength(0);
  });

  // ───── #33: settings persist across restart
  test('settings change survives an app restart (electron-store round-trip)', async () => {
    bridge = await startMockBridge();
    const userData = await mkdtemp(join(vgTmpdir(), 'vg-persist-'));
    await writeSeedSettings(userData, {
      bridgeUrl: bridge.url,
      bridgeToken: MOCK_DEFAULT_TOKEN,
    });

    // Run #1: change wakePhrase + minAudioMs via IPC.
    const app1 = await electron.launch({
      executablePath: PACKAGED_EXEC,
      args: [`--user-data-dir=${userData}`, '--autoplay-policy=no-user-gesture-required'],
      env: { ...process.env, VG_E2E: '1' },
    });
    const win1 = await app1.firstWindow();
    await win1.waitForLoadState('domcontentloaded');
    await win1.evaluate(async () => {
      const w = globalThis as unknown as {
        vg: {
          settings: {
            get: () => Promise<{
              activation: { wakePhrase: string; minAudioMs: number };
            }>;
            set: (
              p: { activation: { wakePhrase: string; minAudioMs: number } },
            ) => Promise<unknown>;
          };
        };
      };
      const s = await w.vg.settings.get();
      await w.vg.settings.set({
        activation: { ...s.activation, wakePhrase: 'persisted phrase', minAudioMs: 999 },
      });
    });
    // Give the store a tick to flush its JSON.
    await win1.waitForTimeout(200);
    await app1.close();

    // Run #2: relaunch against the same userData and read the settings back.
    const app2 = await electron.launch({
      executablePath: PACKAGED_EXEC,
      args: [`--user-data-dir=${userData}`, '--autoplay-policy=no-user-gesture-required'],
      env: { ...process.env, VG_E2E: '1' },
    });
    const win2 = await app2.firstWindow();
    await win2.waitForLoadState('domcontentloaded');
    const loaded = await win2.evaluate(async () => {
      const w = globalThis as unknown as {
        vg: {
          settings: {
            get: () => Promise<{ activation: { wakePhrase: string; minAudioMs: number } }>;
          };
        };
      };
      return await w.vg.settings.get();
    });
    expect(loaded.activation.wakePhrase).toBe('persisted phrase');
    expect(loaded.activation.minAudioMs).toBe(999);
    await app2.close();
    await rm(userData, { recursive: true, force: true });
  });

  // ───── #34: TTS provider live-swap rebuilds the orchestrator
  test('switching tts.provider rebuilds the orchestrator (TTS_STATUS updates)', async () => {
    bridge = await startMockBridge();
    rig = await launchPackaged({
      bridgeUrl: bridge.url,
      bridgeToken: MOCK_DEFAULT_TOKEN,
    });
    const { mainWindow } = rig;
    await expect(mainWindow.getByTestId('connection-indicator')).toContainText(/ligado|ms/i, {
      timeout: 15_000,
    });

    // Subscribe to TTS_STATUS so we can detect the rebuild.
    await mainWindow.evaluate(() => {
      const w = globalThis as unknown as {
        vg: {
          tts: {
            onStatus: (
              cb: (s: { state: string; message?: string }) => void,
            ) => () => void;
          };
        };
        __vg_tts_status_log?: Array<{ state: string; message?: string }>;
      };
      w.__vg_tts_status_log = [];
      w.vg.tts.onStatus((s) => w.__vg_tts_status_log!.push(s));
    });

    // Flip provider from piper_local → elevenlabs (with a dummy key so the
    // adapter at least constructs; we don't expect it to be ready).
    await mainWindow.evaluate(async () => {
      const w = globalThis as unknown as {
        vg: {
          settings: {
            get: () => Promise<{ tts: unknown }>;
            set: (p: unknown) => Promise<unknown>;
          };
        };
      };
      const cur = (await w.vg.settings.get()) as unknown as {
        tts: { piper: unknown; elevenlabs: unknown };
      };
      await w.vg.settings.set({
        tts: {
          provider: 'elevenlabs',
          piper: cur.tts.piper,
          elevenlabs: {
            apiKey: 'sk-fake',
            voiceId: 'fake-voice',
            modelId: 'eleven_turbo_v2_5',
          },
        },
      });
    });

    // After the swap the orchestrator is rebuilt and TTS_STATUS is broadcast
    // with the new adapter's readiness. ElevenLabs is "ready" (no prepare()
    // step beyond the API-key check), so we expect either 'ready' or 'idle'
    // — either way a NEW status arrives.
    await expect
      .poll(
        async () =>
          (await mainWindow.evaluate(
            () =>
              (
                globalThis as unknown as {
                  __vg_tts_status_log?: Array<{ state: string }>;
                }
              ).__vg_tts_status_log?.length ?? 0,
          )) as number,
        { timeout: 10_000 },
      )
      .toBeGreaterThan(0);
  });

  // ───── #35: server-side response_audio_chunk binary path
  test('server-side audio chunks flow through to the renderer', async () => {
    bridge = await startMockBridge({
      onClientMessage: (raw, _send) => {
        const m = raw as { type?: string; turn_id?: string };
        if (m.type === 'end_turn' && typeof m.turn_id === 'string') {
          // Need the underlying WS to send a binary frame — onClientMessage
          // doesn't expose it, so grab the only connection (we know there's
          // one because this callback just fired).
          const ws = [...(bridge?.connections ?? [])][0];
          if (!ws) return;
          // 480 samples = 20 ms of PCM16 @ 24 kHz, the format the renderer
          // accepts on the response_audio_chunk path.
          const pcm = Buffer.alloc(480 * 2);
          for (let i = 0; i < 480; i++) {
            pcm.writeInt16LE(Math.sin(i * 0.1) * 0x4000, i * 2);
          }
          sendServerAudio(ws, {
            turnId: m.turn_id,
            seq: 0,
            format: 'pcm16_24khz',
            payload: pcm,
          });
          // Close the turn so the FSM goes back to IDLE.
          ws.send(JSON.stringify({ type: 'response_end', turn_id: m.turn_id }));
        }
      },
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
    await instrumentTtsCounter(mainWindow);

    await holdPtt(mainWindow, 200);

    // The renderer should receive at least one tts_chunk via the
    // server-audio path (orchestrator emits it for response_audio_chunk).
    await expect
      .poll(async () => (await readVgStats(mainWindow)).chunks, { timeout: 10_000 })
      .toBeGreaterThan(0);

    const stats = await readVgStats(mainWindow);
    expect(stats.bytes).toBeGreaterThanOrEqual(480 * 2);
  });

  // ───── #37: factory reset
  test('Settings → Avançado → factory reset wipes pairing and reverts defaults', async () => {
    bridge = await startMockBridge();
    rig = await launchPackaged({
      bridgeUrl: bridge.url,
      bridgeToken: MOCK_DEFAULT_TOKEN,
      activation: { wakePhrase: 'will be wiped' },
    });
    const { mainWindow } = rig;

    const settings = await openSettingsWindow(rig);
    await settings.getByTestId('tab-avancado').click();
    await settings.getByTestId('factory-reset').click();
    await settings.getByTestId('factory-reset-confirm').click();
    // The reset handler calls `location.reload()` on the settings window,
    // which races our IPC read on the main window. Wait a beat for the
    // store flush, then read defaults on the main window (which doesn't
    // reload).
    await mainWindow.waitForTimeout(500);

    // After reset, the persisted settings should match defaults: no pairing,
    // wakePhrase back to "hey hermes".
    const after = await mainWindow.evaluate(async () => {
      const w = globalThis as unknown as {
        vg: {
          settings: {
            get: () => Promise<{
              pairing: unknown;
              activation: { wakePhrase: string };
            }>;
          };
        };
      };
      return await w.vg.settings.get();
    });
    expect(after.pairing).toBeNull();
    expect(after.activation.wakePhrase).toBe('hey hermes');
  });
});
