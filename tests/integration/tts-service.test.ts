import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:stream';
import {
  ElevenLabsAdapter,
  PiperAdapter,
  createTtsAdapter,
  type TtsChunk,
} from '@main/services/tts-service';

describe('PiperAdapter', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'vg-piper-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('isReady is false without binary + voice files', async () => {
    const a = new PiperAdapter({
      binaryPath: join(tmpDir, 'piper'),
      voicesDir: join(tmpDir, 'voices'),
      config: { modelId: 'en_US-lessac-medium' },
    });
    expect(await a.isReady()).toBe(false);
  });

  it('speak streams PCM stdout as chunk events and emits end on exit 0', async () => {
    await fs.writeFile(join(tmpDir, 'piper'), '');
    await fs.mkdir(join(tmpDir, 'voices'), { recursive: true });
    await fs.writeFile(join(tmpDir, 'voices', 'v.onnx'), '');
    await fs.writeFile(join(tmpDir, 'voices', 'v.onnx.json'), '{}');

    const fakeSpawn = (() => {
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      const proc = new EventEmitter() as EventEmitter & {
        stdin: { end: (b?: Buffer | string) => void };
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: (s?: string) => void;
      };
      proc.stdin = { end: () => undefined };
      proc.stdout = stdout;
      proc.stderr = stderr;
      proc.kill = () => undefined;
      setImmediate(() => {
        stdout.emit('data', Buffer.from([1, 2]));
        stdout.emit('data', Buffer.from([3, 4]));
        proc.emit('close', 0);
      });
      return proc;
    }) as unknown as ConstructorParameters<typeof PiperAdapter>[0]['spawnImpl'];

    const a = new PiperAdapter({
      binaryPath: join(tmpDir, 'piper'),
      voicesDir: join(tmpDir, 'voices'),
      config: { modelId: 'v' },
      spawnImpl: fakeSpawn,
    });
    const chunks: TtsChunk[] = [];
    const ended = new Promise<void>((resolve) => a.once('end', () => resolve()));
    a.on('chunk', (c) => chunks.push(c));
    await a.speak('olá');
    await ended;
    expect(chunks.map((c) => c.seq)).toEqual([1, 2]);
    expect(chunks[0]?.format).toBe('pcm16_22050');
  });

  it('isReady is true when binary + model + metadata all exist', async () => {
    await fs.writeFile(join(tmpDir, 'piper'), '');
    await fs.mkdir(join(tmpDir, 'voices'), { recursive: true });
    await fs.writeFile(join(tmpDir, 'voices', 'v.onnx'), '');
    await fs.writeFile(join(tmpDir, 'voices', 'v.onnx.json'), '{}');
    const a = new PiperAdapter({
      binaryPath: join(tmpDir, 'piper'),
      voicesDir: join(tmpDir, 'voices'),
      config: { modelId: 'v' },
    });
    expect(await a.isReady()).toBe(true);
  });

  it('speak() rejects with a friendly error when Piper is not ready', async () => {
    const a = new PiperAdapter({
      binaryPath: join(tmpDir, 'piper-missing'),
      voicesDir: join(tmpDir, 'voices'),
      config: { modelId: 'v' },
    });
    await expect(a.speak('texto')).rejects.toThrow(/piper|pronto|instalada/i);
  });

  it('non-zero exit code emits an error event with the exit code', async () => {
    await fs.writeFile(join(tmpDir, 'piper'), '');
    await fs.mkdir(join(tmpDir, 'voices'), { recursive: true });
    await fs.writeFile(join(tmpDir, 'voices', 'v.onnx'), '');
    await fs.writeFile(join(tmpDir, 'voices', 'v.onnx.json'), '{}');

    const fakeSpawn = (() => {
      const proc = new EventEmitter() as EventEmitter & {
        stdin: { end: (b?: Buffer | string) => void };
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: (s?: string) => void;
      };
      proc.stdin = { end: () => undefined };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = () => undefined;
      setImmediate(() => proc.emit('close', 137));
      return proc;
    }) as unknown as ConstructorParameters<typeof PiperAdapter>[0]['spawnImpl'];

    const a = new PiperAdapter({
      binaryPath: join(tmpDir, 'piper'),
      voicesDir: join(tmpDir, 'voices'),
      config: { modelId: 'v' },
      spawnImpl: fakeSpawn,
    });
    const errors: Error[] = [];
    a.on('error', (err: Error) => errors.push(err));
    await a.speak('hello');
    await new Promise((r) => setImmediate(r));
    expect(errors[0]?.message).toMatch(/137/);
  });

  it('stop kills the running process (barge-in)', async () => {
    await fs.writeFile(join(tmpDir, 'piper'), '');
    await fs.mkdir(join(tmpDir, 'voices'), { recursive: true });
    await fs.writeFile(join(tmpDir, 'voices', 'v.onnx'), '');
    await fs.writeFile(join(tmpDir, 'voices', 'v.onnx.json'), '{}');

    let killed = false;
    const fakeSpawn = (() => {
      const proc = new EventEmitter() as EventEmitter & {
        stdin: { end: (b?: Buffer | string) => void };
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: (s?: string) => void;
      };
      proc.stdin = { end: () => undefined };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = () => {
        killed = true;
      };
      return proc;
    }) as unknown as ConstructorParameters<typeof PiperAdapter>[0]['spawnImpl'];

    const a = new PiperAdapter({
      binaryPath: join(tmpDir, 'piper'),
      voicesDir: join(tmpDir, 'voices'),
      config: { modelId: 'v' },
      spawnImpl: fakeSpawn,
    });
    await a.speak('olá');
    a.stop();
    expect(killed).toBe(true);
  });
});

describe('ElevenLabsAdapter', () => {
  it('isReady is false without API key or voice', async () => {
    const a = new ElevenLabsAdapter({
      config: { apiKey: '', voiceId: '', modelId: 'm' },
    });
    expect(await a.isReady()).toBe(false);
  });

  it('streams MP3 chunks from the response body', async () => {
    const fetchImpl = vi.fn(async (url, init) => {
      expect(String(url)).toContain('voice-x');
      expect((init as RequestInit).method).toBe('POST');
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([0xff, 0xfb]));
            controller.enqueue(new Uint8Array([0x90, 0x00, 0x01]));
            controller.close();
          },
        }),
        { status: 200, headers: { 'content-type': 'audio/mpeg' } },
      );
    });
    const a = new ElevenLabsAdapter({
      config: { apiKey: 'k', voiceId: 'voice-x', modelId: 'eleven_turbo_v2_5' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const chunks: TtsChunk[] = [];
    const ended = new Promise<void>((resolve) => a.once('end', () => resolve()));
    a.on('chunk', (c) => chunks.push(c));
    await a.speak('olá');
    await ended;
    expect(chunks.map((c) => c.format)).toEqual(['mp3', 'mp3']);
    expect(chunks[0]?.seq).toBe(1);
    expect(chunks[1]?.seq).toBe(2);
  });

  it('stop aborts the in-flight fetch', async () => {
    let aborted = false;
    const fetchImpl = vi.fn(async (_url, init) => {
      const sig = (init as RequestInit).signal!;
      sig.addEventListener('abort', () => {
        aborted = true;
      });
      return new Response(
        new ReadableStream<Uint8Array>({
          // Never enqueue — pump waits forever until abort.
          start() {},
        }),
        { status: 200 },
      );
    });
    const a = new ElevenLabsAdapter({
      config: { apiKey: 'k', voiceId: 'voice-x', modelId: 'm' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await a.speak('olá');
    a.stop();
    expect(aborted).toBe(true);
  });

  it('throws a friendly error on non-2xx', async () => {
    const fetchImpl = vi.fn(async () => new Response('quota', { status: 402 }));
    const a = new ElevenLabsAdapter({
      config: { apiKey: 'k', voiceId: 'voice-x', modelId: 'm' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(a.speak('olá')).rejects.toThrow(/elevenlabs|rejei/i);
  });

  it('throws when the API key is empty', async () => {
    const a = new ElevenLabsAdapter({
      config: { apiKey: '', voiceId: 'voice-x', modelId: 'm' },
    });
    await expect(a.speak('olá')).rejects.toThrow(/chave|API/i);
  });

  it('throws when the voice id is empty', async () => {
    const a = new ElevenLabsAdapter({
      config: { apiKey: 'k', voiceId: '', modelId: 'm' },
    });
    await expect(a.speak('olá')).rejects.toThrow(/voz|chave|API/i);
  });

  it('throws when the response has no body', async () => {
    const fetchImpl = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          body: null,
          text: async () => '',
        }) as unknown as Response,
    );
    const a = new ElevenLabsAdapter({
      config: { apiKey: 'k', voiceId: 'v', modelId: 'm' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(a.speak('olá')).rejects.toThrow(/áudio|audio|body/i);
  });

  it('uses the configured endpoint override', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(new Uint8Array([1, 2, 3]).buffer, { status: 200 }),
    );
    const a = new ElevenLabsAdapter({
      config: { apiKey: 'k', voiceId: 'voice-x', modelId: 'm' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      endpoint: (voiceId) => `https://example.com/${voiceId}`,
    });
    await a.speak('hi');
    // Drain the streaming pump.
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchImpl).toHaveBeenCalled();
    const calls = fetchImpl.mock.calls as unknown as Array<unknown[]>;
    expect(calls[0]?.[0]).toBe('https://example.com/voice-x');
  });

  it('calling stop() before any speak() is a no-op', () => {
    const a = new ElevenLabsAdapter({
      config: { apiKey: 'k', voiceId: 'v', modelId: 'm' },
    });
    expect(() => a.stop()).not.toThrow();
  });
});

describe('PiperAdapter — additional coverage', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'vg-piper-extra-'));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('discoverBinary falls back to the second PATH candidate when the first fails', async () => {
    await fs.mkdir(join(tmpDir, 'voices'), { recursive: true });
    await fs.writeFile(join(tmpDir, 'voices', 'v.onnx'), '');
    await fs.writeFile(join(tmpDir, 'voices', 'v.onnx.json'), '{}');
    let calls = 0;
    const a = new PiperAdapter({
      binaryPath: join(tmpDir, 'no-such-bin'),
      voicesDir: join(tmpDir, 'voices'),
      config: { modelId: 'v' },
      whichImpl: async (cmd) => {
        calls += 1;
        // First candidate ('piper') misses, second ('piper-tts') hits.
        if (cmd === 'piper-tts') return '/opt/piper-tts';
        return null;
      },
    });
    expect(await a.isReady()).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('discoverBinary caches the resolved binary after a hit', async () => {
    await fs.mkdir(join(tmpDir, 'voices'), { recursive: true });
    await fs.writeFile(join(tmpDir, 'voices', 'v.onnx'), '');
    await fs.writeFile(join(tmpDir, 'voices', 'v.onnx.json'), '{}');
    let whichCount = 0;
    const a = new PiperAdapter({
      binaryPath: join(tmpDir, 'no-such-bin'),
      voicesDir: join(tmpDir, 'voices'),
      config: { modelId: 'v' },
      whichImpl: async (cmd) => {
        whichCount += 1;
        return cmd === 'piper' ? '/opt/piper' : null;
      },
    });
    expect(await a.isReady()).toBe(true);
    // Second call hits the cached value — no extra `which` calls.
    const countAfterFirst = whichCount;
    expect(await a.isReady()).toBe(true);
    expect(whichCount).toBe(countAfterFirst);
  });

  it('isReady returns false when the .onnx is present but the .onnx.json is not', async () => {
    await fs.writeFile(join(tmpDir, 'piper'), '');
    await fs.mkdir(join(tmpDir, 'voices'), { recursive: true });
    await fs.writeFile(join(tmpDir, 'voices', 'v.onnx'), '');
    // intentionally skip the metadata file
    const a = new PiperAdapter({
      binaryPath: join(tmpDir, 'piper'),
      voicesDir: join(tmpDir, 'voices'),
      config: { modelId: 'v' },
    });
    expect(await a.isReady()).toBe(false);
  });

  it('prepare rejects on an unknown voice id even if the binary exists', async () => {
    await fs.writeFile(join(tmpDir, 'piper'), '');
    const a = new PiperAdapter({
      binaryPath: join(tmpDir, 'piper'),
      voicesDir: join(tmpDir, 'voices'),
      config: { modelId: 'bogus-voice-id-not-in-catalog' },
      whichImpl: async () => null,
      downloadFile: async () => undefined,
    });
    await expect(a.prepare()).rejects.toThrow(/desconhecida|piper/i);
  });

  it('prepare downloads BOTH .onnx and .onnx.json when missing', async () => {
    await fs.writeFile(join(tmpDir, 'piper'), '');
    const downloads: string[] = [];
    const a = new PiperAdapter({
      binaryPath: join(tmpDir, 'piper'),
      voicesDir: join(tmpDir, 'voices'),
      config: { modelId: 'en_US-lessac-medium' },
      whichImpl: async () => null,
      downloadFile: async (url, dest) => {
        downloads.push(url);
        await fs.mkdir(join(dest, '..'), { recursive: true });
        await fs.writeFile(dest, 'fake');
      },
    });
    await a.prepare();
    expect(downloads).toHaveLength(2);
    expect(downloads.some((u) => u.endsWith('.onnx'))).toBe(true);
    expect(downloads.some((u) => u.endsWith('.onnx.json'))).toBe(true);
  });

  it('speak() before isReady throws a friendly install hint', async () => {
    const a = new PiperAdapter({
      binaryPath: join(tmpDir, 'piper-missing'),
      voicesDir: join(tmpDir, 'voices-missing'),
      config: { modelId: 'v' },
    });
    await expect(a.speak('hi')).rejects.toThrow(/Definições|voz|pronto|piper/i);
  });

  it('emitting "end" on close with code null (signalled) does not produce an error', async () => {
    await fs.writeFile(join(tmpDir, 'piper'), '');
    await fs.mkdir(join(tmpDir, 'voices'), { recursive: true });
    await fs.writeFile(join(tmpDir, 'voices', 'v.onnx'), '');
    await fs.writeFile(join(tmpDir, 'voices', 'v.onnx.json'), '{}');

    const fakeSpawn = (() => {
      const proc = new EventEmitter() as EventEmitter & {
        stdin: { end: (b?: Buffer | string) => void };
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: (s?: string) => void;
      };
      proc.stdin = { end: () => undefined };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = () => undefined;
      setImmediate(() => proc.emit('close', null)); // SIGTERM-like close
      return proc;
    }) as unknown as ConstructorParameters<typeof PiperAdapter>[0]['spawnImpl'];

    const a = new PiperAdapter({
      binaryPath: join(tmpDir, 'piper'),
      voicesDir: join(tmpDir, 'voices'),
      config: { modelId: 'v' },
      spawnImpl: fakeSpawn,
    });
    let ended = false;
    a.on('end', () => {
      ended = true;
    });
    a.on('error', () => {
      throw new Error('should not emit error on null exit');
    });
    await a.speak('hi');
    await new Promise((r) => setImmediate(r));
    expect(ended).toBe(true);
  });
});

describe('ElevenLabsAdapter — additional coverage', () => {
  it('ignores stop() calls after a request completed naturally', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([0xff, 0xfb]));
            controller.close();
          },
        }),
        { status: 200, headers: { 'content-type': 'audio/mpeg' } },
      ),
    );
    const a = new ElevenLabsAdapter({
      config: { apiKey: 'k', voiceId: 'v', modelId: 'm' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const ended = new Promise<void>((resolve) => a.once('end', () => resolve()));
    await a.speak('hi');
    await ended;
    expect(() => a.stop()).not.toThrow();
    expect(() => a.stop()).not.toThrow();
  });
});

describe('createTtsAdapter', () => {
  it('builds a Piper adapter for piper_local', () => {
    const a = createTtsAdapter({
      provider: 'piper_local',
      piper: { modelId: 'en_US-lessac-medium' },
      elevenlabs: { apiKey: '', voiceId: '', modelId: 'm' },
    });
    expect(a.id).toBe('piper_local');
  });

  it('builds an ElevenLabs adapter for elevenlabs', () => {
    const a = createTtsAdapter({
      provider: 'elevenlabs',
      piper: { modelId: 'x' },
      elevenlabs: { apiKey: 'k', voiceId: 'v', modelId: 'm' },
    });
    expect(a.id).toBe('elevenlabs');
  });
});
