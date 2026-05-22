/**
 * Live round-trip against a real Hermes bridge.
 *
 * Connects to `${VG_BRIDGE_URL}` with `${VG_BRIDGE_TOKEN}`, sends the
 * literal text "oi" as a final transcript, and asserts that at least one
 * non-empty `response_text` delta comes back. Times out at 30 s.
 *
 * Skipped when those env vars aren't set so vitest stays green in CI / on
 * a fresh clone. To run against the user's deployment:
 *
 *   VG_BRIDGE_URL=ws://10.0.19.1:8765/ws \
 *   VG_BRIDGE_TOKEN=kug4fJKR... \
 *   npm test -- tests/integration/bridge-text-roundtrip.test.ts
 *
 * If the assistant comes back empty, the chat-completions stream parsing
 * (or Hermes' own response) is the suspect — *not* the desktop audio
 * pipeline. Diagnostics are dumped to stderr to make journalctl diffing
 * trivial.
 */
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { CLIENT_VERSION } from '@shared/constants';
import {
  type MsgError,
  type MsgResponseEnd,
  type MsgResponseText,
  type MsgThinking,
  type MsgWelcome,
  parseServerMessage,
} from '@shared/protocol';

const BRIDGE_URL = process.env['VG_BRIDGE_URL'];
const BRIDGE_TOKEN = process.env['VG_BRIDGE_TOKEN'];
const TIMEOUT_MS = Number(process.env['VG_BRIDGE_TIMEOUT_MS'] ?? 30_000);

const live = BRIDGE_URL && BRIDGE_TOKEN ? describe : describe.skip;

live('bridge text round-trip (live)', () => {
  it(
    'returns a non-empty assistant reply for "oi"',
    async () => {
      const result = await sendTextTurn({
        url: BRIDGE_URL!,
        token: BRIDGE_TOKEN!,
        text: 'oi',
        timeoutMs: TIMEOUT_MS,
      });

      // Dump what we got so the failure message is actionable in CI.
      // eslint-disable-next-line no-console
      console.error('[bridge-roundtrip]', JSON.stringify(result, null, 2));

      expect(result.welcome, 'never received a welcome frame').toBeTruthy();
      expect(result.thinking, 'bridge never advanced past streaming').toBeTruthy();
      expect(result.error, `bridge returned error: ${result.error?.message}`).toBeNull();
      expect(result.responseEnd, 'never got response_end').toBeTruthy();
      expect(result.deltaCount, 'bridge yielded zero response_text deltas').toBeGreaterThan(0);
      expect(
        result.finalText?.trim().length ?? 0,
        `assistant final text was empty (deltas=${result.deltaCount})`,
      ).toBeGreaterThan(0);
    },
    TIMEOUT_MS + 5_000,
  );
});

export interface RoundTripResult {
  welcome: MsgWelcome | null;
  thinking: MsgThinking | null;
  responseEnd: MsgResponseEnd | null;
  error: MsgError | null;
  deltaCount: number;
  totalChars: number;
  finalText: string | null;
  /** Raw message types in order, useful for diffing flows. */
  trace: string[];
}

export async function sendTextTurn(opts: {
  url: string;
  token: string;
  text: string;
  timeoutMs?: number;
}): Promise<RoundTripResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  return await new Promise<RoundTripResult>((resolve, reject) => {
    const result: RoundTripResult = {
      welcome: null,
      thinking: null,
      responseEnd: null,
      error: null,
      deltaCount: 0,
      totalChars: 0,
      finalText: null,
      trace: [],
    };
    const turnId = `e2e-${Date.now()}`;
    const ws = new WebSocket(opts.url, {
      headers: { Authorization: `Bearer ${opts.token}` },
      handshakeTimeout: 5_000,
    });
    const cleanup = (): void => {
      try {
        ws.close();
      } catch {
        // ignore
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`bridge round-trip timed out after ${timeoutMs} ms — trace: ${result.trace.join(', ')}`));
    }, timeoutMs);

    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          type: 'hello',
          client_version: CLIENT_VERSION,
          capabilities: ['stt_local', 'tts_local'],
        }),
      );
    });

    ws.on('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      cleanup();
      reject(new Error(`bridge rejected the upgrade: HTTP ${res.statusCode}`));
    });

    ws.on('message', (data) => {
      const msg = parseServerMessage(JSON.parse(data.toString()));
      if (!msg) return;
      result.trace.push(msg.type);
      switch (msg.type) {
        case 'welcome':
          result.welcome = msg;
          ws.send(JSON.stringify({ type: 'start_turn', turn_id: turnId, lang: 'pt' }));
          ws.send(
            JSON.stringify({
              type: 'transcript',
              turn_id: turnId,
              text: opts.text,
              final: true,
            }),
          );
          ws.send(JSON.stringify({ type: 'end_turn', turn_id: turnId }));
          break;
        case 'thinking':
          result.thinking = msg;
          break;
        case 'response_text': {
          const t = msg as MsgResponseText;
          if (t.text) {
            result.deltaCount += 1;
            result.totalChars += t.text.length;
            if (t.final) result.finalText = t.text;
          }
          break;
        }
        case 'response_end':
          result.responseEnd = msg;
          clearTimeout(timer);
          cleanup();
          resolve(result);
          break;
        case 'error':
          result.error = msg;
          clearTimeout(timer);
          cleanup();
          resolve(result);
          break;
        default:
          // ignore pong, transcript, response_audio_chunk
          break;
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      cleanup();
      reject(err);
    });
  });
}
