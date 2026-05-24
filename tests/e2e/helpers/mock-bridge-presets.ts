/**
 * Common `onClientMessage` recipes for `startMockBridge`. Most E2E specs
 * want exactly one of these patterns; pulling them out of each spec keeps
 * the test body focused on the behaviour under test.
 *
 * Each preset returns a `MockBridgeOptions['onClientMessage']`. Stack them
 * with `composeBridge(a, b)` when a spec needs both (e.g. track transcripts
 * AND script a reply).
 */
import type { WebSocket } from 'ws';
import type { MockBridgeOptions } from '../../integration/__mocks__/mock-bridge-server';
import type { ServerMessage } from '../../../src/shared/protocol';

type OnClientMessage = NonNullable<MockBridgeOptions['onClientMessage']>;

/**
 * Combine multiple onClientMessage handlers. They run in the given order
 * with the same payload — useful for adding observation alongside a
 * scripted reply.
 */
export function composeBridge(...handlers: OnClientMessage[]): OnClientMessage {
  return (msg, send) => {
    for (const h of handlers) h(msg, send);
  };
}

/**
 * Append every final transcript text into `sink` (mutable array).
 */
export function captureTranscripts(sink: string[]): OnClientMessage {
  return (raw) => {
    const m = raw as { type?: string; text?: string; final?: boolean };
    if (m.type === 'transcript' && m.final && typeof m.text === 'string') {
      sink.push(m.text);
    }
  };
}

/**
 * On `end_turn`, reply with thinking → response_text(final, given text)
 * → response_end. Matches the production bridge's _run_turn shape.
 */
export function scriptedTextReply(text: string): OnClientMessage {
  return (raw, send) => {
    const m = raw as { type?: string; turn_id?: string };
    if (m.type === 'end_turn' && typeof m.turn_id === 'string') {
      send({ type: 'thinking', turn_id: m.turn_id } as ServerMessage);
      send({
        type: 'response_text',
        turn_id: m.turn_id,
        text,
        final: true,
      } as ServerMessage);
      send({ type: 'response_end', turn_id: m.turn_id } as ServerMessage);
    }
  };
}

/**
 * On `end_turn`, reply with one `error` frame. The orchestrator should put
 * the FSM in ERROR. Used by the auto-recovery spec.
 */
export function scriptedError(opts: {
  code?: string;
  message?: string;
} = {}): OnClientMessage {
  const code = opts.code ?? 'HERMES_UPSTREAM';
  const message = opts.message ?? 'simulated upstream failure';
  return (raw, send) => {
    const m = raw as { type?: string; turn_id?: string };
    if (m.type === 'end_turn' && typeof m.turn_id === 'string') {
      send({ type: 'error', code, message, turn_id: m.turn_id } as ServerMessage);
    }
  };
}

/**
 * On `end_turn`, send a `response_audio_chunk` JSON header then a raw
 * binary PCM frame, then `response_end`. Tests the binary-after-header
 * codepath in HermesClient + the renderer's AudioPlayback's pcm16_24khz
 * branch.
 *
 * The mock-bridge-server's onClientMessage callback only has the JSON
 * `send` helper, so we hand the WS via a closure on the bridge's
 * `connections` set instead. Caller passes the bridge object — yes, this
 * couples to MockBridge instead of just the option callback, so it's
 * exposed as a free function rather than as a preset.
 */
export function sendServerAudio(
  ws: WebSocket,
  opts: { turnId: string; seq: number; format: 'pcm16_24khz' | 'mp3'; payload: Buffer },
): void {
  const header: ServerMessage = {
    type: 'response_audio_chunk',
    turn_id: opts.turnId,
    seq: opts.seq,
    format: opts.format,
  };
  ws.send(JSON.stringify(header));
  ws.send(opts.payload, { binary: true });
}
