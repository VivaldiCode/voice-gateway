/**
 * Verifies the renderer-side AudioPlayback honours setOutputDevice():
 *
 * - Constructor passes sinkId in AudioContextOptions when set up before the
 *   first chunk arrives (the user picked a speaker before pressing PTT).
 * - Falls back to bare `new AudioContext()` + setSinkId() if the browser
 *   throws on the sinkId option (older Chromium).
 * - setOutputDevice() switches a live context via setSinkId().
 * - getOutputDevice() round-trips the value.
 *
 * Unit-tests the playback layer without a real Web Audio engine — we install
 * minimal fakes for AudioContext / AudioBuffer / AudioBufferSourceNode etc.
 * Just enough surface area for AudioPlayback.beginUtterance / pushChunk /
 * setOutputDevice. The vitest environment is node, so these globals don't
 * otherwise exist.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ───────── Fakes ─────────

interface FakeCtxRecord {
  ctorOpts: { sinkId?: string } | undefined;
  setSinkIdCalls: string[];
  sinkId: string;
}

const ctxRegistry: FakeCtxRecord[] = [];
/** Optional override — when set, the FakeAudioContext constructor throws if
 *  given the matching sinkId. Used to simulate "browser doesn't accept the
 *  sinkId option" so the fallback path runs. */
let ctorThrowsForSinkId: string | null = null;

class FakeAudioBuffer {
  constructor(
    public numberOfChannels: number,
    public length: number,
    public sampleRate: number,
  ) {}
  copyToChannel(): void {
    // no-op
  }
  duration = 0.001;
}

class FakeBufferSource {
  buffer: FakeAudioBuffer | null = null;
  onended: (() => void) | null = null;
  connect(): void {
    // no-op
  }
  start(): void {
    // no-op
  }
  stop(): void {
    // no-op
  }
  disconnect(): void {
    // no-op
  }
}

class FakeAudioContext {
  state: 'suspended' | 'running' | 'closed' = 'running';
  currentTime = 0;
  destination = {} as object;
  private record: FakeCtxRecord;

  constructor(opts?: { sinkId?: string }) {
    if (opts?.sinkId && ctorThrowsForSinkId === opts.sinkId) {
      throw new Error(`fake: ctor rejects sinkId=${opts.sinkId}`);
    }
    this.record = {
      ctorOpts: opts,
      setSinkIdCalls: [],
      sinkId: opts?.sinkId ?? '',
    };
    ctxRegistry.push(this.record);
  }

  get sinkId(): string {
    return this.record.sinkId;
  }

  async setSinkId(id: string): Promise<void> {
    this.record.sinkId = id;
    this.record.setSinkIdCalls.push(id);
  }

  async resume(): Promise<void> {
    this.state = 'running';
  }

  async close(): Promise<void> {
    this.state = 'closed';
  }

  createBuffer(numberOfChannels: number, length: number, sampleRate: number): FakeAudioBuffer {
    return new FakeAudioBuffer(numberOfChannels, length, sampleRate);
  }

  createBufferSource(): FakeBufferSource {
    return new FakeBufferSource();
  }
}

// ───────── Tests ─────────

describe('AudioPlayback — output device routing', () => {
  beforeEach(() => {
    ctxRegistry.length = 0;
    ctorThrowsForSinkId = null;
    (globalThis as unknown as { AudioContext: typeof FakeAudioContext }).AudioContext =
      FakeAudioContext;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as unknown as { AudioContext?: unknown }).AudioContext;
  });

  async function loadFresh() {
    vi.resetModules();
    return await import('../../src/renderer/lib/audio-playback');
  }

  it('uses sinkId in AudioContextOptions when set before the first chunk', async () => {
    const { AudioPlayback } = await loadFresh();
    const p = new AudioPlayback();
    p.setOutputDevice('speaker-id-42');
    p.beginUtterance('pcm16_22050');
    // 4 samples of silence.
    p.pushChunk(new Uint8Array(8), 'pcm16_22050');
    expect(ctxRegistry).toHaveLength(1);
    expect(ctxRegistry[0]?.ctorOpts).toEqual({ sinkId: 'speaker-id-42' });
    expect(ctxRegistry[0]?.sinkId).toBe('speaker-id-42');
  });

  it('omits the sinkId option when no device picked (system default)', async () => {
    const { AudioPlayback } = await loadFresh();
    const p = new AudioPlayback();
    p.beginUtterance('pcm16_22050');
    p.pushChunk(new Uint8Array(8), 'pcm16_22050');
    expect(ctxRegistry[0]?.ctorOpts).toBeUndefined();
    expect(ctxRegistry[0]?.sinkId).toBe('');
  });

  it('treats empty / whitespace device id as default', async () => {
    const { AudioPlayback } = await loadFresh();
    const p = new AudioPlayback();
    p.setOutputDevice('   ');
    p.beginUtterance('pcm16_22050');
    p.pushChunk(new Uint8Array(8), 'pcm16_22050');
    expect(ctxRegistry[0]?.ctorOpts).toBeUndefined();
  });

  it('falls back to bare AudioContext + setSinkId when the option throws', async () => {
    ctorThrowsForSinkId = 'unsupported-id';
    const { AudioPlayback } = await loadFresh();
    const p = new AudioPlayback();
    p.setOutputDevice('unsupported-id');
    p.beginUtterance('pcm16_22050');
    p.pushChunk(new Uint8Array(8), 'pcm16_22050');
    // One failing ctor + one bare ctor — both register.
    expect(ctxRegistry).toHaveLength(1);
    // The bare context is the one that survives; its setSinkId was called
    // with the requested id.
    expect(ctxRegistry[0]?.setSinkIdCalls).toContain('unsupported-id');
    expect(ctxRegistry[0]?.sinkId).toBe('unsupported-id');
  });

  it('switches a live context via setSinkId when the device changes', async () => {
    const { AudioPlayback } = await loadFresh();
    const p = new AudioPlayback();
    p.beginUtterance('pcm16_22050');
    p.pushChunk(new Uint8Array(8), 'pcm16_22050');
    expect(ctxRegistry[0]?.setSinkIdCalls).toEqual([]);
    p.setOutputDevice('headphones-7');
    expect(ctxRegistry[0]?.setSinkIdCalls).toEqual(['headphones-7']);
    // Switching back to default → setSinkId('').
    p.setOutputDevice(null);
    expect(ctxRegistry[0]?.setSinkIdCalls).toEqual(['headphones-7', '']);
  });

  it('getOutputDevice round-trips the value', async () => {
    const { AudioPlayback } = await loadFresh();
    const p = new AudioPlayback();
    expect(p.getOutputDevice()).toBeNull();
    p.setOutputDevice('xyz');
    expect(p.getOutputDevice()).toBe('xyz');
    p.setOutputDevice('');
    expect(p.getOutputDevice()).toBeNull();
  });

  it('does not crash when setOutputDevice is called before any context exists', async () => {
    const { AudioPlayback } = await loadFresh();
    const p = new AudioPlayback();
    expect(() => p.setOutputDevice('whatever')).not.toThrow();
    expect(ctxRegistry).toHaveLength(0);
  });
});
