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
 * Hard requirements:
 *   - `npm run build:mac` produced release/mac-arm64/Voice Gateway.app
 *   - whisper-cli (`brew install whisper-cpp`) on PATH
 *   - the ggml-base model on disk (auto-downloads on first use, ~140 MB)
 *   - piper-tts installed OR the venv auto-installer can run (needs python3)
 *   - macOS mic permission already granted (fake-audio doesn't bypass TCC)
 *
 * Skipped silently when the packaged build is missing.
 */
import { expect, test } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  MOCK_DEFAULT_TOKEN,
  startMockBridge,
  type MockBridge,
} from '../integration/__mocks__/mock-bridge-server';
import type { ServerMessage } from '../../src/shared/protocol';
import {
  FIXTURES_DIR,
  instrumentTtsCounter,
  launchPackaged,
  packagedAppExists,
  readVgStats,
  sttReady,
  type TestRig,
} from './helpers/rig';

const FIXTURE = join(FIXTURES_DIR, 'hi-how-are-you.wav');
const REPLY_TEXT =
  "Hi there! I'm doing well today, thanks for asking. How can I help you?";

test.describe('audio conversation — packaged app', () => {
  let rig: TestRig | null = null;
  let bridge: MockBridge | null = null;

  test.beforeAll(() => {
    if (!packagedAppExists()) {
      test.skip(true, 'Packaged app missing. Run `npm run build:mac` first.');
    }
    if (!existsSync(FIXTURE)) {
      test.skip(true, `Fixture WAV missing at ${FIXTURE}.`);
    }
  });

  test.afterEach(async () => {
    await rig?.dispose();
    rig = null;
    await bridge?.close();
    bridge = null;
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
          send({ type: 'thinking', turn_id: m.turn_id } as ServerMessage);
          send({
            type: 'response_text',
            turn_id: m.turn_id,
            text: REPLY_TEXT,
            final: true,
          } as ServerMessage);
          send({ type: 'response_end', turn_id: m.turn_id } as ServerMessage);
        }
      },
    });

    rig = await launchPackaged({
      bridgeUrl: bridge.url,
      bridgeToken: MOCK_DEFAULT_TOKEN,
      fakeAudioFile: FIXTURE,
    });
    const { mainWindow } = rig;

    await expect(mainWindow.getByTestId('call-button')).toBeVisible({ timeout: 15_000 });
    await expect(mainWindow.getByTestId('connection-indicator')).toContainText(
      /ligado|ms/i,
      { timeout: 15_000 },
    );

    await instrumentTtsCounter(mainWindow);

    const sttPrepare = await sttReady(mainWindow);
    test.skip(
      !sttPrepare.ok,
      `Whisper local not ready — ${sttPrepare.message ?? 'unknown'}. Install: brew install whisper-cpp`,
    );

    const callButton = mainWindow.getByTestId('call-button');
    await expect(callButton).toBeEnabled({ timeout: 5_000 });
    await callButton.dispatchEvent('pointerdown');
    await mainWindow.waitForTimeout(2_500);
    await callButton.dispatchEvent('pointerup');

    await expect
      .poll(() => observedTranscripts.length, { timeout: 20_000 })
      .toBeGreaterThan(0);
    const heard = observedTranscripts.join(' | ').toLowerCase();
    // eslint-disable-next-line no-console
    console.log('[e2e] whisper transcript →', heard);
    expect(heard).toMatch(/\b(how|today|you)\b/);

    await expect(mainWindow.locator('text=' + REPLY_TEXT.slice(0, 25))).toBeVisible({
      timeout: 10_000,
    });

    await expect
      .poll(async () => (await readVgStats(mainWindow)).chunks, { timeout: 30_000 })
      .toBeGreaterThan(0);

    const stats = await readVgStats(mainWindow);
    // eslint-disable-next-line no-console
    console.log('[e2e] tts chunks received:', { chunks: stats.chunks, bytes: stats.bytes });
    expect(stats.chunks).toBeGreaterThan(0);
    expect(stats.bytes).toBeGreaterThan(1_000);
  });
});
