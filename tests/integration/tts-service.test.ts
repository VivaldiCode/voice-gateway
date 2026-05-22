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
