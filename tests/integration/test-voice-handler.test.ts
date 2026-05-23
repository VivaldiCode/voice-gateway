/**
 * Tests for the `testVoice` IPC handler — the function behind the
 * "Reproduzir" button in Settings → Voz.
 *
 * We don't spawn Piper or hit ElevenLabs here. The handler accepts an
 * `adapterOverride` so we can inject a fake adapter and assert:
 *   - the user-typed text reaches `adapter.speak(...)`
 *   - chunk events round-trip through the `onChunk` callback as base64
 *   - the final `done: true` sentinel is emitted on `end`
 *   - adapter errors surface as `{ ok: false, message }`
 *   - bad ElevenLabs configs short-circuit before any speak attempt
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { testVoice, type TestTtsChunkPayload } from '@main/ipc-handlers';
import type { TtsAdapter } from '@main/services/tts-service';

class FakeTtsAdapter extends EventEmitter implements TtsAdapter {
  readonly id = 'fake_tts';
  spoken: string[] = [];
  speakError: Error | null = null;
  stopped = false;

  /** When set, emit these chunks then 'end' on `speak()`. */
  chunksToEmit: Array<{ data: Buffer; format: string; seq: number }> = [];

  async isReady(): Promise<boolean> {
    return true;
  }

  async speak(text: string): Promise<void> {
    if (this.speakError) throw this.speakError;
    this.spoken.push(text);
    // Emit chunks on the next microtask so the caller has time to attach
    // listeners — mirrors how real adapters behave.
    queueMicrotask(() => {
      for (const c of this.chunksToEmit) this.emit('chunk', c);
      this.emit('end');
    });
  }

  stop(): void {
    this.stopped = true;
  }
}

describe('testVoice (IPC handler)', () => {
  it('passes the user-typed text through to adapter.speak()', async () => {
    const adapter = new FakeTtsAdapter();
    adapter.chunksToEmit = [{ data: Buffer.from([1, 2, 3]), format: 'pcm16_22050', seq: 1 }];

    const r = await testVoice(
      { provider: 'piper_local', text: 'olá hermes' },
      () => undefined,
      { adapterOverride: adapter },
    );

    expect(r.ok).toBe(true);
    expect(adapter.spoken).toEqual(['olá hermes']);
  });

  it('forwards chunk events as base64-encoded payloads + a done sentinel', async () => {
    const adapter = new FakeTtsAdapter();
    adapter.chunksToEmit = [
      { data: Buffer.from([1, 2]), format: 'pcm16_22050', seq: 1 },
      { data: Buffer.from([3, 4]), format: 'pcm16_22050', seq: 2 },
    ];

    const received: TestTtsChunkPayload[] = [];
    const r = await testVoice(
      { provider: 'piper_local', text: 'hi' },
      (c) => received.push(c),
      { adapterOverride: adapter },
    );

    expect(r.ok).toBe(true);
    // 2 chunk payloads + 1 done sentinel.
    expect(received).toHaveLength(3);
    expect(received[0]).toEqual({
      seq: 1,
      format: 'pcm16_22050',
      data: Buffer.from([1, 2]).toString('base64'),
    });
    expect(received[1]).toEqual({
      seq: 2,
      format: 'pcm16_22050',
      data: Buffer.from([3, 4]).toString('base64'),
    });
    expect(received[2]).toEqual({ seq: -1, format: '', data: '', done: true });
  });

  it('preserves multi-line and unicode input verbatim through to speak()', async () => {
    // We sanitise on the renderer side (prepareTestText) — the handler
    // itself should not double-trim or mutate the text the caller passes.
    const adapter = new FakeTtsAdapter();
    const text = 'linha um\nlinha dois 🎙️';

    await testVoice(
      { provider: 'piper_local', text },
      () => undefined,
      { adapterOverride: adapter },
    );

    expect(adapter.spoken).toEqual([text]);
  });

  it('returns { ok:false, message } when adapter.speak rejects', async () => {
    const adapter = new FakeTtsAdapter();
    adapter.speakError = new Error('piper exploded');

    const r = await testVoice(
      { provider: 'piper_local', text: 'hi' },
      () => undefined,
      { adapterOverride: adapter },
    );

    expect(r.ok).toBe(false);
    expect(r.message).toBe('piper exploded');
  });

  it('returns { ok:false, message } when adapter emits an error mid-stream', async () => {
    const adapter = new FakeTtsAdapter();
    // Override speak: emit an error event instead of chunks.
    adapter.speak = async (text: string): Promise<void> => {
      adapter.spoken.push(text);
      queueMicrotask(() => adapter.emit('error', new Error('boom')));
    };

    const r = await testVoice(
      { provider: 'piper_local', text: 'olá' },
      () => undefined,
      { adapterOverride: adapter },
    );

    expect(r.ok).toBe(false);
    expect(r.message).toBe('boom');
  });

  it('short-circuits with friendly message for ElevenLabs without an API key', async () => {
    // No adapter override — exercises the real production branch.
    const r = await testVoice(
      {
        provider: 'elevenlabs',
        text: 'hi',
        elevenlabs: { apiKey: '', voiceId: '', modelId: 'eleven_turbo_v2_5' },
      },
      () => undefined,
    );
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/chave|voz/i);
  });

  it('short-circuits with friendly message for ElevenLabs without a voice id', async () => {
    const r = await testVoice(
      {
        provider: 'elevenlabs',
        text: 'hi',
        elevenlabs: { apiKey: 'sk-something', voiceId: '', modelId: 'eleven_turbo_v2_5' },
      },
      () => undefined,
    );
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/chave|voz/i);
  });
});
