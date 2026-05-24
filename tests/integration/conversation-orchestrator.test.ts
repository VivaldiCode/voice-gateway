import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConversationOrchestrator } from '@main/services/conversation-orchestrator';
import type { HermesClient } from '@main/services/hermes-client';
import type { SttAdapter, SttResult } from '@main/services/stt-service';
import type { TtsAdapter, TtsChunk } from '@main/services/tts-service';
import { defaultSettings } from '@main/services/settings-store';
import type { Settings } from '@shared/types';

class FakeClient extends EventEmitter {
  connected = true;
  sent: Array<{ type: string; payload?: unknown }> = [];
  isConnected(): boolean {
    return this.connected;
  }
  sendStartTurn(turn_id: string, lang?: string): void {
    this.sent.push({ type: 'start_turn', payload: { turn_id, lang } });
  }
  sendClientTranscript(turn_id: string, text: string, final: boolean): void {
    this.sent.push({ type: 'transcript', payload: { turn_id, text, final } });
  }
  sendEndTurn(turn_id: string): void {
    this.sent.push({ type: 'end_turn', payload: { turn_id } });
  }
  sendAudioChunk(): void {
    this.sent.push({ type: 'audio_chunk' });
  }
  sendInterrupt(): void {
    this.sent.push({ type: 'interrupt' });
  }
}

class FakeStt implements SttAdapter {
  readonly id = 'fake_stt';
  result: SttResult = { text: 'olá hermes' };
  shouldThrow = false;
  /** When set, transcribe() never resolves — used to exercise STT timeout. */
  hang = false;
  async isReady(): Promise<boolean> {
    return true;
  }
  async prepare(): Promise<void> {
    return;
  }
  async transcribe(): Promise<SttResult> {
    if (this.shouldThrow) throw new Error('stt boom');
    if (this.hang) return new Promise<SttResult>(() => undefined);
    return this.result;
  }
}

class FakeTts extends EventEmitter implements TtsAdapter {
  readonly id = 'fake_tts';
  stopped = false;
  spoken: string[] = [];
  /** When false, speak emits chunk but never emits end — useful for barge-in tests. */
  autoFinish = true;
  async isReady(): Promise<boolean> {
    return true;
  }
  async speak(text: string): Promise<void> {
    this.stopped = false;
    this.spoken.push(text);
    queueMicrotask(() => {
      this.emit('chunk', { data: Buffer.from([1, 2]), format: 'pcm16_22050', seq: 1 } satisfies TtsChunk);
      if (this.autoFinish) this.emit('end');
    });
  }
  stop(): void {
    this.stopped = true;
  }
}

let id = 0;

function makeOrchestrator(
  opts: { sttTimeoutMs?: number; ttsTimeoutMs?: number } = {},
): {
  o: ConversationOrchestrator;
  client: FakeClient;
  stt: FakeStt;
  tts: FakeTts;
  settings: Settings;
} {
  const client = new FakeClient();
  const stt = new FakeStt();
  const tts = new FakeTts();
  const settings = defaultSettings();
  // Tests push tiny byte buffers; disable the production min-audio guard so
  // the orchestrator still exercises the STT → WS → TTS path.
  settings.activation.minAudioMs = 0;
  const o = new ConversationOrchestrator(
    client as unknown as HermesClient,
    stt,
    tts,
    settings,
    { newTurnId: () => `turn-${++id}` },
    {
      ...(opts.sttTimeoutMs != null ? { sttMs: opts.sttTimeoutMs } : {}),
      ...(opts.ttsTimeoutMs != null ? { ttsMs: opts.ttsTimeoutMs } : {}),
    },
  );
  return { o, client, stt, tts, settings };
}

describe('ConversationOrchestrator', () => {
  beforeEach(() => {
    id = 0;
  });

  afterEach(() => {
    // No teardown needed (no timers).
  });

  it('starts in IDLE for push-to-talk mode', () => {
    const { o } = makeOrchestrator();
    expect(o.getState().state).toBe('IDLE');
  });

  it('emits state events on each transition', () => {
    const { o } = makeOrchestrator();
    const states: string[] = [];
    o.on('state', (ctx) => states.push(ctx.state));
    o.pttPress();
    expect(states).toEqual(['CAPTURING']);
  });

  it('happy path PTT: press → audio → release → stt → ws → tts → end', async () => {
    const { o, client, stt, tts } = makeOrchestrator();
    const transcripts: string[] = [];
    const ttsChunks: TtsChunk[] = [];
    o.on('transcript_final', (t) => transcripts.push(t));
    o.on('tts_chunk', (c) => ttsChunks.push(c));

    o.pttPress();
    o.pushAudio(Buffer.from([1, 2, 3]));
    o.pushAudio(Buffer.from([4, 5, 6]));
    o.pttRelease();

    // wait microtasks
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(transcripts).toEqual(['olá hermes']);
    expect(client.sent.map((s) => s.type)).toEqual([
      'start_turn',
      'transcript',
      'end_turn',
    ]);
    expect(o.getState().state).toBe('THINKING');

    // Server tells us the response text (final=true). Orchestrator should
    // hand it to TTS.
    (client as unknown as EventEmitter).emit('response_text', {
      type: 'response_text',
      turn_id: 'turn-1',
      text: 'olá!',
      final: true,
    });

    // Wait for TTS to emit chunk+end via microtasks.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(tts.spoken).toEqual(['olá!']);
    expect(ttsChunks.length).toBe(1);
    expect(o.getState().state).toBe('IDLE');
    void stt; // referenced via fake; keep lint happy
  });

  it('defers RESPONSE_END from server while local TTS is still active', async () => {
    // Regression test for the audio-never-plays bug. The bridge sends
    // response_text(final=true) and response_end back-to-back. Without the
    // deferral, the FSM would leave SPEAKING before the first TTS chunk
    // reached the renderer, batching away the SPEAKING state and skipping
    // playback entirely.
    const { o, client, tts } = makeOrchestrator();
    tts.autoFinish = false; // simulate Piper still spawning

    o.pttPress();
    o.pttRelease();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    (client as unknown as EventEmitter).emit('response_text', {
      type: 'response_text',
      turn_id: 'turn-1',
      text: 'olá!',
      final: true,
    });
    await new Promise((r) => setImmediate(r));
    expect(o.getState().state).toBe('SPEAKING');

    // Server's response_end arrives while TTS is still pending — must be a no-op.
    (client as unknown as EventEmitter).emit('response_end', {
      type: 'response_end',
      turn_id: 'turn-1',
    });
    expect(o.getState().state).toBe('SPEAKING');

    // When the local TTS finally emits 'end', the FSM should advance.
    tts.emit('end');
    expect(o.getState().state).toBe('IDLE');
  });

  it('routes server-side audio chunks straight to tts_chunk', async () => {
    const { o, client } = makeOrchestrator();
    const ttsChunks: TtsChunk[] = [];
    o.on('tts_chunk', (c) => ttsChunks.push(c));

    o.pttPress();
    o.pttRelease();
    await new Promise((r) => setImmediate(r));

    (client as unknown as EventEmitter).emit(
      'response_audio_chunk',
      { type: 'response_audio_chunk', turn_id: 'turn-1', seq: 0, format: 'pcm16_24khz' },
      Buffer.from([9, 9]),
    );

    expect(ttsChunks).toHaveLength(1);
    expect(o.getState().state).toBe('SPEAKING');

    (client as unknown as EventEmitter).emit('response_end', { type: 'response_end', turn_id: 'turn-1' });
    expect(o.getState().state).toBe('IDLE');
  });

  it('stt failure moves FSM to ERROR and emits error event', async () => {
    const { o, stt } = makeOrchestrator();
    stt.shouldThrow = true;
    const errors: Array<[string, string]> = [];
    o.on('error', (c, m) => errors.push([c, m]));
    o.pttPress();
    o.pttRelease();
    await new Promise((r) => setImmediate(r));
    expect(errors[0]?.[0]).toBe('STT_FAILED');
    expect(o.getState().state).toBe('ERROR');
  });

  it('cancel stops TTS and clears the buffered audio', async () => {
    const { o, tts } = makeOrchestrator();
    o.pttPress();
    o.pushAudio(Buffer.from([1]));
    o.cancel();
    expect(o.getState().state).toBe('IDLE');
    expect(tts.stopped).toBe(true);
  });

  it('bargeIn transitions to CAPTURING with a fresh turn id', async () => {
    const { o, client, tts } = makeOrchestrator();
    tts.autoFinish = false; // keep the TTS pretending to still be talking
    o.pttPress();
    o.pttRelease();
    await new Promise((r) => setImmediate(r));
    (client as unknown as EventEmitter).emit('response_text', {
      type: 'response_text',
      turn_id: 'turn-1',
      text: 'longa resposta',
      final: true,
    });
    await new Promise((r) => setImmediate(r));
    expect(o.getState().state).toBe('SPEAKING');
    o.bargeIn();
    expect(o.getState().state).toBe('CAPTURING');
    expect(o.getState().turnId).toBe('turn-2');
    expect(tts.stopped).toBe(true);
  });

  it('refuses to send to Hermes when WS is disconnected and surfaces error', async () => {
    const { o, client } = makeOrchestrator();
    client.connected = false;
    const errors: Array<[string, string]> = [];
    o.on('error', (c, m) => errors.push([c, m]));
    o.pttPress();
    o.pttRelease();
    await new Promise((r) => setImmediate(r));
    expect(errors[0]?.[0]).toBe('WS_DISCONNECTED');
    expect(o.getState().state).toBe('ERROR');
  });

  it('STT hang fires TIMEOUT error within the configured window', async () => {
    const { o, stt } = makeOrchestrator({ sttTimeoutMs: 50 });
    stt.hang = true;
    const errors: Array<[string, string]> = [];
    o.on('error', (c, m) => errors.push([c, m]));
    o.pttPress();
    o.pushAudio(Buffer.from([1, 2, 3]));
    o.pttRelease();
    // Wait a little longer than the 50 ms cap so the race resolves.
    await new Promise((r) => setTimeout(r, 200));
    expect(errors[0]?.[0]).toBe('TIMEOUT');
    expect(errors[0]?.[1]).toMatch(/STT.*timed out/);
    expect(o.getState().state).toBe('ERROR');
  });

  it('TTS hang fires TIMEOUT error and calls tts.stop() for cleanup', async () => {
    const { o, client, tts } = makeOrchestrator({ ttsTimeoutMs: 50 });
    // Make speak() never resolve.
    tts.speak = (text: string): Promise<void> => {
      tts.spoken.push(text);
      return new Promise<void>(() => undefined);
    };
    const errors: Array<[string, string]> = [];
    o.on('error', (c, m) => errors.push([c, m]));
    o.pttPress();
    o.pttRelease();
    await new Promise((r) => setImmediate(r));
    (client as unknown as EventEmitter).emit('response_text', {
      type: 'response_text',
      turn_id: 'turn-1',
      text: 'olá!',
      final: true,
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(errors[0]?.[0]).toBe('TIMEOUT');
    expect(errors[0]?.[1]).toMatch(/TTS.*timed out/);
    expect(tts.stopped, 'orchestrator should have called tts.stop() on timeout').toBe(true);
  });

  it('empty transcript skips Hermes and returns to IDLE', async () => {
    const { o, stt, client } = makeOrchestrator();
    stt.result = { text: '' };
    o.pttPress();
    o.pttRelease();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(client.sent).toHaveLength(0);
    expect(o.getState().state).toBe('IDLE');
  });
});
