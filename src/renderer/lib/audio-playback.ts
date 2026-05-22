/**
 * Streaming audio playback for TTS chunks.
 *
 * Supports two chunk formats:
 * - 'pcm16_22050' (Piper) and 'pcm16_24khz' (server-side TTS): scheduled
 *   directly via AudioBuffer + sample-accurate timing.
 * - 'mp3' (ElevenLabs): collected and decoded as a single AudioBuffer once
 *   the stream ends (browsers do not expose a chunked MP3 decoder API).
 *
 * Barge-in: `stop()` cancels any pending buffers immediately.
 */

export type PlaybackFormat = 'pcm16_22050' | 'pcm16_24khz' | 'mp3';

export interface AudioPlaybackEvents {
  start: () => void;
  end: () => void;
  error: (err: Error) => void;
}

export class AudioPlayback {
  private ctx: AudioContext | null = null;
  private nextStartAt = 0;
  private active: AudioBufferSourceNode[] = [];
  private mp3Chunks: Uint8Array[] = [];
  private pendingFormat: PlaybackFormat | null = null;
  private startedEmitted = false;
  private endTimer: number | null = null;
  private listeners: Partial<AudioPlaybackEvents> = {};

  on<K extends keyof AudioPlaybackEvents>(event: K, cb: AudioPlaybackEvents[K]): void {
    this.listeners[event] = cb;
  }

  private getCtx(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext();
    // Chromium's audio policy suspends AudioContexts that aren't created
    // during a user gesture. Resume on every entry — resume() is a no-op
    // when the context is already running, and is allowed any time after
    // the user has already interacted with the page once.
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
    return this.ctx;
  }

  beginUtterance(format: PlaybackFormat): void {
    this.stop();
    this.pendingFormat = format;
    this.startedEmitted = false;
    this.mp3Chunks = [];
    this.nextStartAt = 0;
    // Eagerly create + resume the AudioContext now, while we still have the
    // user-gesture stack frame from the click handler. Without this, the
    // context created on the first chunk arrival (after an IPC round-trip)
    // stays suspended and source.start() produces silence.
    this.getCtx();
  }

  pushChunk(chunk: Uint8Array, format: PlaybackFormat): void {
    if (this.pendingFormat === null) this.beginUtterance(format);
    if (format !== this.pendingFormat) {
      // Mid-stream format change is treated as a new utterance.
      this.beginUtterance(format);
    }
    if (format === 'mp3') {
      this.mp3Chunks.push(chunk);
      return;
    }
    const sampleRate = format === 'pcm16_22050' ? 22050 : 24000;
    this.scheduleInt16(chunk, sampleRate);
  }

  endUtterance(): void {
    if (this.pendingFormat === 'mp3' && this.mp3Chunks.length > 0) {
      void this.decodeAndPlayMp3();
    } else {
      this.scheduleEndCheck();
    }
  }

  stop(): void {
    if (this.endTimer !== null) {
      clearTimeout(this.endTimer);
      this.endTimer = null;
    }
    for (const node of this.active) {
      try {
        node.stop();
        node.disconnect();
      } catch {
        // ignore
      }
    }
    this.active = [];
    this.mp3Chunks = [];
    this.pendingFormat = null;
    this.nextStartAt = 0;
  }

  private scheduleInt16(chunk: Uint8Array, sampleRate: number): void {
    const ctx = this.getCtx();
    const int16 = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.byteLength / 2);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      const v = int16[i] ?? 0;
      float32[i] = v < 0 ? v / 0x8000 : v / 0x7fff;
    }
    const buffer = ctx.createBuffer(1, float32.length, sampleRate);
    buffer.copyToChannel(float32, 0);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);

    const startAt = Math.max(ctx.currentTime, this.nextStartAt);
    source.start(startAt);
    this.nextStartAt = startAt + buffer.duration;
    this.active.push(source);

    source.onended = () => {
      this.active = this.active.filter((n) => n !== source);
    };

    if (!this.startedEmitted) {
      this.startedEmitted = true;
      this.listeners.start?.();
    }
    this.scheduleEndCheck();
  }

  private async decodeAndPlayMp3(): Promise<void> {
    const ctx = this.getCtx();
    const total = this.mp3Chunks.reduce((n, c) => n + c.length, 0);
    const merged = new Uint8Array(total);
    let o = 0;
    for (const c of this.mp3Chunks) {
      merged.set(c, o);
      o += c.length;
    }
    this.mp3Chunks = [];
    let buffer: AudioBuffer;
    try {
      buffer = await ctx.decodeAudioData(merged.buffer.slice(0));
    } catch (err) {
      this.listeners.error?.(err as Error);
      return;
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start();
    this.active.push(source);
    if (!this.startedEmitted) {
      this.startedEmitted = true;
      this.listeners.start?.();
    }
    source.onended = () => {
      this.active = this.active.filter((n) => n !== source);
      if (this.active.length === 0) this.listeners.end?.();
    };
  }

  private scheduleEndCheck(): void {
    if (this.endTimer !== null) {
      clearTimeout(this.endTimer);
    }
    const ctx = this.getCtx();
    const delay = Math.max(0, this.nextStartAt - ctx.currentTime);
    this.endTimer = setTimeout(() => {
      this.endTimer = null;
      if (this.active.length === 0) this.listeners.end?.();
    }, delay * 1000 + 50) as unknown as number;
  }

  async dispose(): Promise<void> {
    this.stop();
    if (this.ctx) {
      await this.ctx.close();
      this.ctx = null;
    }
  }
}
