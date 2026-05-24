/**
 * Higher-coverage E2Es that exercise paths missed by conversation-flows
 * and conversation-extras:
 *
 *   #41 — wake fires → full conversation turn (wake → CAPTURING →
 *         PTT_RELEASE → STREAMING → THINKING → SPEAKING → LISTENING_WAKE).
 *
 *   #42 — server-side MP3 audio path. The mock bridge sends a
 *         response_audio_chunk header with format=mp3 + raw bytes. The
 *         renderer's AudioPlayback buffers them; we verify the IPC chunks
 *         arrive (the actual decodeAudioData is best-effort and out of
 *         scope for this assertion).
 *
 *   #43 — transcript pane visual rendering. Two turns should leave four
 *         alternating rows (tu/hermes/tu/hermes) with the right text.
 *
 *   #46 — re-pair to a different bridge mid-session. settings.set with a
 *         fresh pairing → orchestrator rebuilds → bridge B sees a welcome.
 */
import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import {
  MOCK_DEFAULT_TOKEN,
  startMockBridge,
  type MockBridge,
} from '../integration/__mocks__/mock-bridge-server';
import {
  scriptedTextReply,
  sendServerAudio,
} from './helpers/mock-bridge-presets';
import {
  FIXTURES_DIR,
  holdPtt,
  instrumentTtsCounter,
  launchPackaged,
  packagedAppExists,
  readVgStats,
  waitForState,
  type TestRig,
} from './helpers/rig';

const FAKE_AUDIO = join(FIXTURES_DIR, 'hi-how-are-you.wav');

test.describe('conversation advanced', () => {
  let rig: TestRig | null = null;
  let bridge: MockBridge | null = null;
  let bridgeB: MockBridge | null = null;

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
    await bridgeB?.close();
    bridgeB = null;
  });

  // ───── #41: wake fires → full turn
  test('wake event drives a full conversation turn back to LISTENING_WAKE', async () => {
    bridge = await startMockBridge({
      onClientMessage: scriptedTextReply('Olá! Estou aqui.'),
    });
    rig = await launchPackaged({
      bridgeUrl: bridge.url,
      bridgeToken: MOCK_DEFAULT_TOKEN,
      fakeAudioFile: FAKE_AUDIO,
      activation: { mode: 'WAKE_WORD', minAudioMs: 50 },
      extraEnv: {
        VG_WAKE_E2E_FAKE: '1',
        VG_E2E_FAKE_TRANSCRIPT: 'olá hermes',
      },
    });
    const { mainWindow } = rig;
    await expect(mainWindow.getByTestId('connection-indicator')).toContainText(
      /ligado|ms/i,
      { timeout: 15_000 },
    );
    await instrumentTtsCounter(mainWindow);

    // The orchestrator constructs with state=LISTENING_WAKE but only emits
    // 'state' on transitions, so the initial rest state never reaches the
    // event log. Skip to the first observable transition: wake detected.
    // The fake wake runner emits wake ~1.5s after spawn.
    await waitForState(mainWindow, ['CAPTURING'], { timeoutMs: 10_000 });

    // Simulate VAD silence / end-of-utterance — production wires this from
    // the audio worklet; the test just dispatches the FSM event directly.
    await mainWindow.waitForTimeout(300); // gather a small audio buffer
    await mainWindow.evaluate(() => {
      const w = globalThis as unknown as {
        vg: { conversation: { pttRelease: () => void } };
      };
      w.vg.conversation.pttRelease();
    });

    // Full turn completes and we end up back at LISTENING_WAKE.
    await waitForState(mainWindow, ['LISTENING_WAKE'], { timeoutMs: 20_000 });

    // The renderer should have stepped through CAPTURING → STREAMING → THINKING
    // → SPEAKING → LISTENING_WAKE. Loose check: it visited at least 3 of those.
    const visited = new Set(
      (await readVgStats(mainWindow)).stateLog.map((s) => s.state),
    );
    const intermediate = ['STREAMING', 'THINKING', 'SPEAKING'].filter((s) =>
      visited.has(s),
    );
    expect(intermediate.length, `visited states: ${[...visited].join(', ')}`).toBeGreaterThanOrEqual(
      2,
    );
  });

  // ───── #42: server-side MP3 audio
  test('server-side MP3 chunks reach the renderer via tts_chunk', async () => {
    // Build a small fake MP3 payload — 32 bytes. We're testing the IPC path,
    // not the decoder; the renderer's AudioPlayback buffers MP3 chunks until
    // endUtterance() and then attempts decodeAudioData. decode may fail
    // (we'd then see __vg_errors), but the chunk count is what matters here.
    const mp3Bytes = Buffer.alloc(32, 0xff);
    bridge = await startMockBridge({
      onClientMessage: (raw, _send) => {
        const m = raw as { type?: string; turn_id?: string };
        if (m.type === 'end_turn' && typeof m.turn_id === 'string') {
          const ws = [...(bridge?.connections ?? [])][0];
          if (!ws) return;
          sendServerAudio(ws, {
            turnId: m.turn_id,
            seq: 0,
            format: 'mp3',
            payload: mp3Bytes,
          });
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

    await expect
      .poll(async () => (await readVgStats(mainWindow)).chunks, { timeout: 10_000 })
      .toBeGreaterThan(0);

    const stats = await readVgStats(mainWindow);
    expect(stats.chunks).toBeGreaterThan(0);
    expect(stats.bytes).toBeGreaterThanOrEqual(mp3Bytes.length);
  });

  // ───── #43: transcript pane visual rendering
  test('two turns leave four alternating rows in the transcript pane', async () => {
    let turnCounter = 0;
    bridge = await startMockBridge({
      onClientMessage: (raw, send) => {
        const m = raw as { type?: string; turn_id?: string };
        if (m.type === 'end_turn' && typeof m.turn_id === 'string') {
          turnCounter += 1;
          send({ type: 'thinking', turn_id: m.turn_id });
          send({
            type: 'response_text',
            turn_id: m.turn_id,
            text: `assistant reply number ${turnCounter}`,
            final: true,
          });
          send({ type: 'response_end', turn_id: m.turn_id });
        }
      },
    });
    rig = await launchPackaged({
      bridgeUrl: bridge.url,
      bridgeToken: MOCK_DEFAULT_TOKEN,
      fakeAudioFile: FAKE_AUDIO,
      activation: { minAudioMs: 50 },
      extraEnv: { VG_E2E_FAKE_TRANSCRIPT: 'user utterance' },
    });
    const { mainWindow } = rig;
    await expect(mainWindow.getByTestId('connection-indicator')).toContainText(/ligado|ms/i, {
      timeout: 15_000,
    });
    await instrumentTtsCounter(mainWindow);

    // Turn 1
    await holdPtt(mainWindow, 200);
    await waitForState(mainWindow, ['IDLE'], { timeoutMs: 15_000 });

    // Turn 2
    await holdPtt(mainWindow, 200);
    await waitForState(mainWindow, ['IDLE'], { timeoutMs: 15_000 });

    // Visual: two user rows + two assistant rows in order.
    const userRows = mainWindow.locator('[data-testid="transcript-user"]');
    const assistantRows = mainWindow.locator('[data-testid="transcript-assistant"]');
    await expect(userRows).toHaveCount(2);
    await expect(assistantRows).toHaveCount(2);

    const firstAssistant = await assistantRows.first().textContent();
    const lastAssistant = await assistantRows.last().textContent();
    expect(firstAssistant).toContain('reply number 1');
    expect(lastAssistant).toContain('reply number 2');
  });

  // ───── #46: re-pair to a different bridge mid-session
  test('switching pairing rebuilds the orchestrator against bridge B', async () => {
    bridge = await startMockBridge({ sessionId: 'bridge-A' });
    rig = await launchPackaged({
      bridgeUrl: bridge.url,
      bridgeToken: MOCK_DEFAULT_TOKEN,
    });
    const { mainWindow } = rig;
    await expect(mainWindow.getByTestId('connection-indicator')).toContainText(/ligado|ms/i, {
      timeout: 15_000,
    });
    // A saw at least one connection (the initial one).
    const aConnsBefore = bridge.connections.size;
    expect(aConnsBefore).toBeGreaterThan(0);

    // Spin up bridge B on a different port with its own token.
    const TOKEN_B = 'bridge-b-token-aaaaaaaaaaaa';
    bridgeB = await startMockBridge({
      expectedToken: TOKEN_B,
      sessionId: 'bridge-B',
    });

    // Re-pair via the same IPC the Settings panel uses.
    await mainWindow.evaluate(
      async (req) => {
        const w = globalThis as unknown as {
          vg: {
            settings: {
              set: (p: { pairing: { url: string; token: string } }) => Promise<unknown>;
            };
          };
        };
        await w.vg.settings.set({ pairing: req });
      },
      { url: bridgeB.url, token: TOKEN_B },
    );

    // B should receive a welcome. We poll its connections count instead of
    // looking at the UI badge (which can briefly flicker through 'connecting').
    await expect
      .poll(() => bridgeB?.connections.size ?? 0, { timeout: 15_000 })
      .toBeGreaterThan(0);
    // Indicator returns to green after the rebuild.
    await expect(mainWindow.getByTestId('connection-indicator')).toContainText(/ligado|ms/i, {
      timeout: 15_000,
    });
  });
});
