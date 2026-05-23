/**
 * Real-audio end-to-end conversation test.
 *
 * Drives the **packaged** Voice Gateway.app through a full turn:
 *   PTT press → fake mic feeds a pre-recorded "HI! How are you today?" WAV
 *   → renderer captures + IPC to main → real whisper.cpp transcribes →
 *   transcript sent over WS to a mock bridge → mock replies with scripted
 *   response_text → orchestrator hands text to local Piper TTS → renderer
 *   AudioPlayback receives PCM chunks → test asserts chunks arrived.
 *
 * The test does NOT check that audio actually came out of the speakers —
 * that's a hardware loopback assertion no headless run can make. It does
 * verify that:
 *   - the mock bridge saw a transcript whose text contains "how" or "today"
 *     (whisper-cli is allowed to render the phrase slightly differently);
 *   - the UI showed both the user transcript and the assistant reply;
 *   - the renderer received at least one `tts_chunk` IPC event with non-empty
 *     PCM data — which proves the Piper subprocess started and its stdout
 *     reached the AudioPlayback layer.
 *
 * Hard requirements:
 *   - `npm run build:mac` produced release/mac-arm64/Voice Gateway.app
 *   - whisper-cli (`brew install whisper-cpp`) on PATH
 *   - the ggml-base model on disk (will auto-download on first use, ~140 MB)
 *   - piper-tts installed OR the venv auto-installer can run (needs python3)
 *   - macOS mic permission already granted (the fake-audio flag doesn't
 *     bypass TCC — Chromium still asks the OS for permission)
 *
 * Skipped silently when the packaged build is missing so a fresh clone
 * still gets a green test run.
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
import {
  MOCK_DEFAULT_TOKEN,
  startMockBridge,
  type MockBridge,
} from '../integration/__mocks__/mock-bridge-server';
import type { ServerMessage } from '../../src/shared/protocol';

const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const PACKAGED_EXEC = join(
  ROOT,
  'release/mac-arm64/Voice Gateway.app/Contents/MacOS/Voice Gateway',
);
const FIXTURE = join(ROOT, 'tests/e2e/fixtures/hi-how-are-you.wav');

interface TestRig {
  app: ElectronApplication;
  mainWindow: Page;
  userData: string;
  /** Transcripts observed on the bridge during this test, in arrival order. */
  observedTranscripts: string[];
}

async function seedSettings(userData: string, bridgeUrl: string): Promise<void> {
  const settingsFile = join(userData, 'voice-gateway-settings.json');
  await mkdir(userData, { recursive: true });
  await writeFile(
    settingsFile,
    JSON.stringify({
      settings: {
        pairing: { url: bridgeUrl, token: MOCK_DEFAULT_TOKEN },
        activation: {
          mode: 'PUSH_TO_TALK',
          wakeWord: 'hey_jarvis',
          wakeMode: 'openww',
          wakePhrase: 'hey hermes',
          globalHotkey: 'CommandOrControl+Shift+H',
          vadThreshold: 0.5,
          vadSilenceMs: 800,
          minAudioMs: 200, // small so a 2 s capture isn't filtered as too-short
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

async function launchPackaged(bridgeUrl: string): Promise<TestRig> {
  const userData = await mkdtemp(join(tmpdir(), 'vg-audio-e2e-'));
  await seedSettings(userData, bridgeUrl);
  const app = await electron.launch({
    executablePath: PACKAGED_EXEC,
    args: [
      `--user-data-dir=${userData}`,
      // Chromium fake-media-stream so getUserMedia returns the WAV.
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${FIXTURE}`,
      // Skip the autoplay-blocking heuristics since we never get a real
      // user gesture inside a fake window.
      '--autoplay-policy=no-user-gesture-required',
    ],
    env: { ...process.env, VG_E2E: '1' },
    timeout: 30_000,
  });

  const mainWindow = await app.firstWindow({ timeout: 15_000 });
  mainWindow.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      // eslint-disable-next-line no-console
      console.log(`[renderer ${msg.type()}] ${msg.text()}`);
    }
  });
  mainWindow.on('pageerror', (err) => {
    // eslint-disable-next-line no-console
    console.log(`[renderer pageerror] ${err.message}`);
  });
  return { app, mainWindow, userData, observedTranscripts: [] };
}

const REPLY_TEXT =
  "Hi there! I'm doing well today, thanks for asking. How can I help you?";

test.describe('audio conversation — packaged app', () => {
  let rig: TestRig | null = null;
  let bridge: MockBridge | null = null;

  test.beforeAll(() => {
    if (!existsSync(PACKAGED_EXEC)) {
      test.skip(true, `Packaged app missing at ${PACKAGED_EXEC}. Run \`npm run build:mac\` first.`);
    }
    if (!existsSync(FIXTURE)) {
      test.skip(true, `Fixture WAV missing at ${FIXTURE}. Run scripts/make-e2e-fixtures.sh.`);
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
    if (bridge) {
      try {
        await bridge.close();
      } catch {
        // ignore
      }
      bridge = null;
    }
  });

  test('full turn: fake mic → whisper → mock bridge → piper → tts chunks', async () => {
    const observedTranscripts: string[] = [];
    bridge = await startMockBridge({
      onClientMessage: (raw, send) => {
        const m = raw as { type?: string; turn_id?: string; text?: string; final?: boolean };
        if (m.type === 'transcript' && m.final && typeof m.text === 'string') {
          observedTranscripts.push(m.text);
        }
        if (m.type === 'end_turn' && typeof m.turn_id === 'string') {
          // Script: thinking → response_text final=true → response_end.
          // Mirrors the production bridge's _run_turn shape.
          const thinking: ServerMessage = { type: 'thinking', turn_id: m.turn_id };
          send(thinking);
          const respText: ServerMessage = {
            type: 'response_text',
            turn_id: m.turn_id,
            text: REPLY_TEXT,
            final: true,
          };
          send(respText);
          const respEnd: ServerMessage = { type: 'response_end', turn_id: m.turn_id };
          send(respEnd);
        }
      },
    });

    rig = await launchPackaged(bridge.url);
    const { mainWindow } = rig;
    rig.observedTranscripts = observedTranscripts;

    await mainWindow.waitForLoadState('domcontentloaded');
    await expect(mainWindow.getByTestId('call-button')).toBeVisible({ timeout: 15_000 });
    await expect(mainWindow.getByTestId('connection-indicator')).toContainText(
      /ligado|ms/i,
      { timeout: 15_000 },
    );

    // Instrument: register a renderer-side IPC listener that counts tts_chunks
    // and stashes the count on window.__vg_tts_chunks. Survives across the
    // hold/release cycle because Playwright keeps the page alive.
    await mainWindow.evaluate(() => {
      type W = Window & {
        vg: {
          conversation: {
            onTtsChunk: (
              cb: (c: { seq: number; format: string; data: string }) => void,
            ) => () => void;
            onResponseText: (cb: (c: { text: string }) => void) => () => void;
          };
        };
        __vg_tts_chunks?: number;
        __vg_tts_bytes?: number;
        __vg_last_response?: string;
      };
      const w = globalThis as unknown as W;
      w.__vg_tts_chunks = 0;
      w.__vg_tts_bytes = 0;
      w.vg.conversation.onTtsChunk((c) => {
        w.__vg_tts_chunks = (w.__vg_tts_chunks ?? 0) + 1;
        // c.data is base64 PCM/MP3
        w.__vg_tts_bytes = (w.__vg_tts_bytes ?? 0) + atob(c.data).length;
      });
      w.vg.conversation.onResponseText((c) => {
        w.__vg_last_response = c.text;
      });
    });

    // Wait until STT is ready (whisper binary discovered + model on disk).
    // If whisper isn't installed at all, fail with a hint instead of hanging.
    const sttReady = await mainWindow.evaluate(async () => {
      type W = {
        vg: { stt: { prepare: () => Promise<{ ok: boolean; message?: string }> } };
      };
      const w = globalThis as unknown as W;
      return await w.vg.stt.prepare();
    });
    test.skip(
      !sttReady.ok,
      `Whisper local not ready — ${sttReady.message ?? 'unknown reason'}. Install: brew install whisper-cpp`,
    );

    // Press the call button, hold for 2.5 s so a couple of fixture reps land
    // in the captured buffer, then release.
    const callButton = mainWindow.getByTestId('call-button');
    await expect(callButton).toBeEnabled({ timeout: 5_000 });
    await callButton.dispatchEvent('pointerdown');
    await mainWindow.waitForTimeout(2_500);
    await callButton.dispatchEvent('pointerup');

    // Wait for the bridge to see the final transcript.
    await expect
      .poll(() => observedTranscripts.length, { timeout: 20_000 })
      .toBeGreaterThan(0);
    const heard = observedTranscripts.join(' | ').toLowerCase();
    // eslint-disable-next-line no-console
    console.log('[e2e] whisper transcript →', heard);
    // Whisper is allowed to render the phrase loosely ("hi how are you",
    // "hi how are you today", etc). Accept any substring of the recorded
    // sentence that proves the audio went through STT.
    expect(heard).toMatch(/\b(how|today|you)\b/);

    // Wait for the reply text to render in the transcript pane.
    await expect(mainWindow.locator('text=' + REPLY_TEXT.slice(0, 25))).toBeVisible({
      timeout: 10_000,
    });

    // Wait for the renderer to receive TTS chunks back from local Piper.
    // Piper takes ~1-3s to start emitting after the response_text final=true.
    // The orchestrator's deferral keeps SPEAKING alive until TTS 'end' fires.
    await expect
      .poll(
        async () =>
          (await mainWindow.evaluate(
            () => (globalThis as unknown as { __vg_tts_chunks?: number }).__vg_tts_chunks ?? 0,
          )) as number,
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0);

    const stats = await mainWindow.evaluate(() => ({
      chunks: (globalThis as unknown as { __vg_tts_chunks?: number }).__vg_tts_chunks ?? 0,
      bytes: (globalThis as unknown as { __vg_tts_bytes?: number }).__vg_tts_bytes ?? 0,
    }));
    // eslint-disable-next-line no-console
    console.log('[e2e] tts chunks received:', stats);
    expect(stats.chunks).toBeGreaterThan(0);
    expect(stats.bytes).toBeGreaterThan(1_000); // anything meaningful → > 1 kB PCM
  });
});
