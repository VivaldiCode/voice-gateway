import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:stream';
import {
  OpenAIWhisperAdapter,
  WhisperLocalAdapter,
  pcm16ToWav,
  createSttAdapter,
} from '@main/services/stt-service';
import type { SttSettings } from '@shared/types';

describe('pcm16ToWav', () => {
  it('writes a valid RIFF/WAVE header for a tiny buffer', () => {
    const pcm = Buffer.from([0, 0, 1, 0, 2, 0, 3, 0]); // 4 samples
    const wav = pcm16ToWav(pcm, 16_000);
    expect(wav.subarray(0, 4).toString()).toBe('RIFF');
    expect(wav.subarray(8, 12).toString()).toBe('WAVE');
    expect(wav.subarray(12, 16).toString()).toBe('fmt ');
    expect(wav.subarray(36, 40).toString()).toBe('data');
    expect(wav.readUInt32LE(40)).toBe(pcm.length);
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.length).toBe(44 + pcm.length);
  });
});

describe('OpenAIWhisperAdapter', () => {
  it('isReady is false without an API key', async () => {
    const a = new OpenAIWhisperAdapter({ apiKey: '' });
    expect(await a.isReady()).toBe(false);
  });

  it('prepare throws a friendly error when missing API key', async () => {
    const a = new OpenAIWhisperAdapter({ apiKey: ' ' });
    await expect(a.prepare()).rejects.toThrow(/chave api/i);
  });

  it('transcribe POSTs to the endpoint with WAV body and returns text', async () => {
    const fetchImpl = vi.fn(async (_url, init) => {
      const body = (init as RequestInit).body as FormData;
      const file = body.get('file') as Blob;
      expect(file).toBeInstanceOf(Blob);
      // body should contain at least the WAV header
      const arr = new Uint8Array(await file.arrayBuffer());
      expect(String.fromCharCode(arr[0] ?? 0, arr[1] ?? 0, arr[2] ?? 0, arr[3] ?? 0)).toBe('RIFF');
      return new Response(
        JSON.stringify({ text: 'olá hermes', language: 'pt' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const a = new OpenAIWhisperAdapter({
      apiKey: 'sk-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const r = await a.transcribe({ pcm: Buffer.alloc(160), language: 'pt' });
    expect(r.text).toBe('olá hermes');
    expect(r.language).toBe('pt');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('throws a friendly error on non-2xx response', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('bad key', { status: 401 }),
    ) as unknown as typeof fetch;
    const a = new OpenAIWhisperAdapter({ apiKey: 'sk-test', fetchImpl });
    await expect(a.transcribe({ pcm: Buffer.alloc(0), language: 'auto' })).rejects.toThrow(
      /openai|rejei/i,
    );
  });
});

describe('WhisperLocalAdapter', () => {
  let tmpDir: string;
  /** Always return null from PATH lookup so tests stay deterministic on dev
   *  machines that happen to have whisper-cli installed via brew. */
  const noPathLookup = async (): Promise<string | null> => null;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'vg-whisper-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('isReady is false when binary or model is missing', async () => {
    const a = new WhisperLocalAdapter({
      modelsDir: join(tmpDir, 'models'),
      binaryPath: join(tmpDir, 'bin', 'whisper'),
      config: { model: 'base' },
      whichImpl: noPathLookup,
    });
    expect(await a.isReady()).toBe(false);
  });

  it('prepare throws helpful message when binary is missing', async () => {
    const a = new WhisperLocalAdapter({
      modelsDir: join(tmpDir, 'models'),
      binaryPath: join(tmpDir, 'bin', 'whisper'),
      config: { model: 'base' },
      whichImpl: noPathLookup,
    });
    await expect(a.prepare()).rejects.toThrow(/não está instalado/i);
  });

  it('isReady becomes true once a binary is discovered on PATH', async () => {
    await fs.mkdir(join(tmpDir, 'models'), { recursive: true });
    await fs.writeFile(join(tmpDir, 'models', 'ggml-base.bin'), '');
    const a = new WhisperLocalAdapter({
      modelsDir: join(tmpDir, 'models'),
      binaryPath: join(tmpDir, 'no-such-bin'),
      config: { model: 'base' },
      whichImpl: async (cmd) => (cmd === 'whisper-cli' ? '/opt/homebrew/bin/whisper-cli' : null),
    });
    expect(await a.isReady()).toBe(true);
  });

  it('prepare downloads the model if binary exists but model does not', async () => {
    await fs.mkdir(join(tmpDir, 'bin'), { recursive: true });
    await fs.writeFile(join(tmpDir, 'bin', 'whisper'), '');
    const downloads: string[] = [];
    const a = new WhisperLocalAdapter({
      modelsDir: join(tmpDir, 'models'),
      binaryPath: join(tmpDir, 'bin', 'whisper'),
      config: { model: 'tiny' },
      whichImpl: noPathLookup,
      downloadFile: async (url, dest) => {
        downloads.push(url);
        await fs.mkdir(join(dest, '..'), { recursive: true });
        await fs.writeFile(dest, 'fake-model');
      },
    });
    await a.prepare();
    expect(downloads).toHaveLength(1);
    expect(downloads[0]).toMatch(/ggml-tiny\.bin$/);
    expect(await a.isReady()).toBe(true);
  });

  it('prepare auto-installs via brew on macOS when autoInstall=true', async () => {
    if (process.platform !== 'darwin') return; // brew path only relevant on darwin
    await fs.mkdir(join(tmpDir, 'models'), { recursive: true });
    await fs.writeFile(join(tmpDir, 'models', 'ggml-base.bin'), '');
    const ranCommands: string[][] = [];
    let installed = false;
    const fakeSpawn = ((path: string, args: string[]) => {
      ranCommands.push([path, ...args]);
      const ee = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      ee.stdout = new EventEmitter();
      ee.stderr = new EventEmitter();
      setImmediate(() => {
        installed = path.endsWith('/brew') || installed;
        ee.emit('close', 0);
      });
      return ee;
    }) as unknown as ConstructorParameters<typeof WhisperLocalAdapter>[0]['spawnImpl'];

    let lookupCallCount = 0;
    const a = new WhisperLocalAdapter({
      modelsDir: join(tmpDir, 'models'),
      binaryPath: join(tmpDir, 'no-such-bin'),
      config: { model: 'base' },
      autoInstall: true,
      spawnImpl: fakeSpawn,
      whichImpl: async (cmd) => {
        lookupCallCount += 1;
        if (cmd === 'brew') return '/opt/homebrew/bin/brew';
        // Pretend whisper-cli appears after brew install ran.
        if (cmd === 'whisper-cli' && installed) return '/opt/homebrew/bin/whisper-cli';
        return null;
      },
    });
    await a.prepare();
    expect(ranCommands[0]?.[0]).toBe('/opt/homebrew/bin/brew');
    expect(ranCommands[0]?.slice(1)).toEqual(['install', 'whisper-cpp']);
    expect(lookupCallCount).toBeGreaterThan(0);
  });

  it('transcribe spawns the binary with the right args and reads stdout', async () => {
    await fs.mkdir(join(tmpDir, 'bin'), { recursive: true });
    await fs.mkdir(join(tmpDir, 'models'), { recursive: true });
    await fs.writeFile(join(tmpDir, 'bin', 'whisper'), '');
    await fs.writeFile(join(tmpDir, 'models', 'ggml-base.bin'), '');

    const seenArgs: string[][] = [];
    const fakeSpawn = ((path: string, args: string[]) => {
      seenArgs.push(args);
      expect(path).toBe(join(tmpDir, 'bin', 'whisper'));
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      const proc = new EventEmitter() as EventEmitter & {
        stdin: { end: (b?: Buffer) => void };
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      proc.stdin = { end: () => undefined };
      proc.stdout = stdout;
      proc.stderr = stderr;
      setImmediate(() => {
        stdout.emit('data', Buffer.from('olá hermes\n'));
        proc.emit('close', 0);
      });
      return proc;
    }) as unknown as ConstructorParameters<typeof WhisperLocalAdapter>[0]['spawnImpl'];

    const a = new WhisperLocalAdapter({
      modelsDir: join(tmpDir, 'models'),
      binaryPath: join(tmpDir, 'bin', 'whisper'),
      config: { model: 'base' },
      spawnImpl: fakeSpawn,
      whichImpl: noPathLookup,
    });
    const r = await a.transcribe({ pcm: Buffer.alloc(0), language: 'pt' });
    expect(r.text).toBe('olá hermes');
    expect(seenArgs[0]).toContain('-m');
    expect(seenArgs[0]).toContain('-l');
    expect(seenArgs[0]).toContain('pt');
    expect(seenArgs[0]).toContain('-f');
    // -f must be followed by a real WAV path (no longer `-` for stdin).
    const fIdx = seenArgs[0]!.indexOf('-f');
    expect(seenArgs[0]![fIdx + 1]).not.toBe('-');
    expect(seenArgs[0]![fIdx + 1]).toMatch(/\.wav$/);
  });
});

describe('createSttAdapter', () => {
  const base: SttSettings = {
    provider: 'openai_whisper',
    language: 'auto',
    whisperLocal: { model: 'base' },
    openai: { apiKey: 'sk-1', model: 'whisper-1' },
  };

  it('returns an OpenAIWhisperAdapter when provider is openai_whisper', () => {
    const a = createSttAdapter(base);
    expect(a.id).toBe('openai_whisper');
  });

  it('returns a WhisperLocalAdapter when provider is whisper_local', () => {
    const a = createSttAdapter({ ...base, provider: 'whisper_local' });
    expect(a.id).toBe('whisper_local');
  });
});
