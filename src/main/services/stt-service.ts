import { promises as fs, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { app } from 'electron';
import log from 'electron-log/main';
import type { LanguageCode } from '@shared/constants';
import type { SttSettings, WhisperLocalConfig } from '@shared/types';

export interface SttRequest {
  /** Mono PCM16 little-endian samples at 16 kHz. */
  pcm: Buffer | Uint8Array;
  /** ISO 639-1 language code, or "auto" to let the engine detect. */
  language: LanguageCode | 'auto';
}

export interface SttResult {
  text: string;
  language?: string;
  durationMs?: number;
}

export interface SttAdapter {
  readonly id: string;
  /** True if the adapter is ready to transcribe right now (e.g. model on disk). */
  isReady(): Promise<boolean>;
  /** Idempotent. Downloads model / verifies credentials, with progress callbacks. */
  prepare(onProgress?: (p: ProgressEvent) => void): Promise<void>;
  transcribe(req: SttRequest): Promise<SttResult>;
}

export interface ProgressEvent {
  stage: 'downloading' | 'extracting' | 'verifying' | 'installing' | 'ready';
  /** 0..1, or null if unknown. */
  fraction: number | null;
  detail?: string;
}

// ───────── OpenAI Whisper API adapter ─────────

export interface OpenAIWhisperOptions {
  apiKey: string;
  model?: string;
  /** Override the global fetch (useful for tests). */
  fetchImpl?: typeof fetch;
  /** Override the endpoint (useful for tests / Azure / proxies). */
  endpoint?: string;
}

export class OpenAIWhisperAdapter implements SttAdapter {
  readonly id = 'openai_whisper';
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly endpoint: string;

  constructor(opts: OpenAIWhisperOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? 'whisper-1';
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.endpoint = opts.endpoint ?? 'https://api.openai.com/v1/audio/transcriptions';
  }

  async isReady(): Promise<boolean> {
    return this.apiKey.trim().length > 0;
  }

  async prepare(onProgress?: (p: ProgressEvent) => void): Promise<void> {
    if (!(await this.isReady())) {
      throw new Error('Falta a chave API da OpenAI. Adiciona-a em Definições > Reconhecimento.');
    }
    onProgress?.({ stage: 'ready', fraction: 1 });
  }

  async transcribe(req: SttRequest): Promise<SttResult> {
    const startedAt = Date.now();
    const wav = pcm16ToWav(req.pcm, 16_000);
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');
    form.append('model', this.model);
    form.append('response_format', 'json');
    if (req.language !== 'auto') form.append('language', req.language);

    const res = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    });

    if (!res.ok) {
      const body = await safeText(res);
      throw new Error(`A OpenAI rejeitou o pedido (HTTP ${res.status}): ${body.slice(0, 200)}`);
    }

    const json = (await res.json()) as { text?: string; language?: string };
    return {
      text: (json.text ?? '').trim(),
      ...(json.language ? { language: json.language } : {}),
      durationMs: Date.now() - startedAt,
    };
  }
}

// ───────── whisper.cpp local adapter ─────────

export interface WhisperLocalOptions {
  /** Directory holding model files (ggml-*.bin). */
  modelsDir?: string;
  /** Preferred path to the whisper binary. If missing, falls back to PATH discovery. */
  binaryPath?: string;
  config: WhisperLocalConfig;
  /** Override the spawner — useful for tests. */
  spawnImpl?: typeof spawn;
  /** Override the downloader — useful for tests. */
  downloadFile?: (url: string, dest: string, onProgress?: (p: ProgressEvent) => void) => Promise<void>;
  /** Override the PATH-lookup helper — useful for tests. */
  whichImpl?: (cmd: string) => Promise<string | null>;
  /**
   * If true and binary is not found, try installing it via the platform
   * package manager (Homebrew on macOS). Off by default to keep behaviour
   * predictable; opt-in via boot config.
   */
  autoInstall?: boolean;
}

const WHISPER_MODEL_URLS: Record<string, string> = {
  tiny: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin',
  base: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
  small: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',
};

/** Binary names we accept, in order of preference. `whisper-cli` is the
 *  modern Homebrew name; `whisper-cpp` is the legacy alias; `whisper` is the
 *  classic name when users build from source. */
const WHISPER_BINARY_CANDIDATES = ['whisper-cli', 'whisper-cpp', 'whisper'];

export class WhisperLocalAdapter implements SttAdapter {
  readonly id = 'whisper_local';
  private readonly modelsDir: string;
  private readonly preferredBinary: string;
  private readonly config: WhisperLocalConfig;
  private readonly spawnImpl: typeof spawn;
  private readonly downloadFile: NonNullable<WhisperLocalOptions['downloadFile']>;
  private readonly whichImpl: NonNullable<WhisperLocalOptions['whichImpl']>;
  private readonly autoInstall: boolean;
  private resolvedBinary: string | null = null;

  constructor(opts: WhisperLocalOptions) {
    this.modelsDir = opts.modelsDir ?? join(safeUserDataPath(), 'whisper', 'models');
    this.preferredBinary =
      opts.binaryPath ?? join(safeUserDataPath(), 'whisper', 'bin', binaryName());
    this.config = opts.config;
    this.spawnImpl = opts.spawnImpl ?? spawn;
    this.downloadFile = opts.downloadFile ?? defaultDownloadFile;
    this.whichImpl = opts.whichImpl ?? defaultWhich;
    this.autoInstall = opts.autoInstall ?? false;
  }

  private modelPath(): string {
    return join(this.modelsDir, `ggml-${this.config.model}.bin`);
  }

  /**
   * Locate a usable whisper binary. Order:
   *   1. The explicitly-preferred path (typically userData/whisper/bin/whisper)
   *   2. `whisper-cli` / `whisper-cpp` / `whisper` on PATH
   * Returns the absolute path on success or null on failure.
   */
  private async discoverBinary(): Promise<string | null> {
    if (this.resolvedBinary) return this.resolvedBinary;
    try {
      await fs.access(this.preferredBinary);
      this.resolvedBinary = this.preferredBinary;
      return this.resolvedBinary;
    } catch {
      // fall through to PATH lookup
    }
    for (const name of WHISPER_BINARY_CANDIDATES) {
      const found = await this.whichImpl(name);
      if (found) {
        this.resolvedBinary = found;
        return this.resolvedBinary;
      }
    }
    return null;
  }

  async isReady(): Promise<boolean> {
    const bin = await this.discoverBinary();
    if (!bin) return false;
    try {
      await fs.access(this.modelPath());
      return true;
    } catch {
      return false;
    }
  }

  async prepare(onProgress?: (p: ProgressEvent) => void): Promise<void> {
    await fs.mkdir(this.modelsDir, { recursive: true });

    let bin = await this.discoverBinary();
    if (!bin && this.autoInstall && process.platform === 'darwin') {
      const brew = await this.whichImpl('brew');
      if (brew) {
        onProgress?.({
          stage: 'installing',
          fraction: null,
          detail: 'brew install whisper-cpp',
        });
        await this.runProcess(brew, ['install', 'whisper-cpp']);
        bin = await this.discoverBinary();
      }
    }
    if (!bin) {
      throw new Error(
        process.platform === 'darwin'
          ? 'Whisper local não está instalado. No terminal: `brew install whisper-cpp`. (Ou abre Definições e escolhe a OpenAI Whisper API.)'
          : 'Whisper local não está instalado. Instala `whisper.cpp` ou abre Definições e escolhe a OpenAI Whisper API.',
      );
    }

    try {
      await fs.access(this.modelPath());
    } catch {
      const url = WHISPER_MODEL_URLS[this.config.model];
      if (!url) throw new Error(`Modelo Whisper desconhecido: ${this.config.model}`);
      onProgress?.({
        stage: 'downloading',
        fraction: 0,
        detail: `ggml-${this.config.model}.bin`,
      });
      await this.downloadFile(url, this.modelPath(), onProgress);
    }
    onProgress?.({ stage: 'ready', fraction: 1 });
  }

  async transcribe(req: SttRequest): Promise<SttResult> {
    if (!(await this.isReady())) {
      throw new Error('Whisper local não está pronto. Chama prepare() primeiro.');
    }
    const bin = this.resolvedBinary;
    if (!bin) throw new Error('Whisper local: binário não resolvido.');

    // whisper-cli reads from a file (no stdin support). Write the WAV to a
    // per-turn temp file and clean up afterwards.
    const workDir = await fs.mkdtemp(join(tmpdir(), 'vg-whisper-'));
    const wavPath = join(workDir, 'turn.wav');
    try {
      await fs.writeFile(wavPath, pcm16ToWav(req.pcm, 16_000));
      const args = [
        '-m', this.modelPath(),
        '-l', req.language === 'auto' ? 'auto' : req.language,
        '-nt', // no timestamps
        '-np', // suppress whisper.cpp's own log lines on stderr
        '-f', wavPath,
      ];
      const startedAt = Date.now();
      const text = await this.runProcess(bin, args);
      return { text: text.trim(), durationMs: Date.now() - startedAt };
    } finally {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Spawn a process, capture stdout, reject on non-zero exit. */
  private runProcess(bin: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      let proc: ChildProcess;
      try {
        proc = this.spawnImpl(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      proc.stdout?.on('data', (b: Buffer) => out.push(b));
      proc.stderr?.on('data', (b: Buffer) => err.push(b));
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code === 0) {
          resolve(Buffer.concat(out).toString('utf-8'));
          return;
        }
        const tail = Buffer.concat(err).toString('utf-8').trim().slice(-300);
        reject(new Error(`whisper.cpp falhou (código ${code}): ${tail || '(sem stderr)'}`));
      });
    });
  }
}

// ───────── Factory ─────────

export interface CreateSttOptions {
  /** If true, auto-install missing local STT dependencies (e.g. brew). */
  autoInstall?: boolean;
}

export function createSttAdapter(
  settings: SttSettings,
  opts: CreateSttOptions = {},
): SttAdapter {
  if (settings.provider === 'openai_whisper') {
    return new OpenAIWhisperAdapter({
      apiKey: settings.openai.apiKey,
      model: settings.openai.model,
    });
  }
  return new WhisperLocalAdapter({
    config: settings.whisperLocal,
    autoInstall: opts.autoInstall ?? false,
  });
}

// ───────── Helpers ─────────

function safeUserDataPath(): string {
  // Outside of Electron (tests) `app` is unavailable. Fall back to /tmp.
  try {
    return app.getPath('userData');
  } catch {
    return join(process.cwd(), '.vg-userdata');
  }
}

function binaryName(): string {
  return process.platform === 'win32' ? 'whisper.exe' : 'whisper';
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

/**
 * Wrap mono PCM16 little-endian samples in a minimal WAV container.
 * Whisper accepts this format directly.
 */
export function pcm16ToWav(pcm: Buffer | Uint8Array, sampleRate: number): Buffer {
  const data = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm);
  const buf = Buffer.alloc(44 + data.length);
  // RIFF header
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + data.length, 4);
  buf.write('WAVE', 8, 'ascii');
  // fmt chunk
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  // data chunk
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(data.length, 40);
  data.copy(buf, 44);
  return buf;
}

/** Default which() — spawns `/usr/bin/which` (or `where` on Windows) and returns
 *  the resolved binary path on success. */
function defaultWhich(cmd: string): Promise<string | null> {
  const tool = process.platform === 'win32' ? 'where' : 'which';
  return new Promise((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawn(tool, [cmd], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }
    const chunks: Buffer[] = [];
    proc.stdout?.on('data', (b: Buffer) => chunks.push(b));
    proc.on('error', () => resolve(null));
    proc.on('close', (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      const first = Buffer.concat(chunks).toString('utf-8').split(/\r?\n/)[0]?.trim();
      resolve(first && first.length > 0 ? first : null);
    });
  });
}

async function defaultDownloadFile(
  url: string,
  dest: string,
  onProgress?: (p: ProgressEvent) => void,
): Promise<void> {
  log.info('[VG] downloading', url, '→', dest);
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status})`);
  const total = Number(res.headers.get('content-length') ?? '0') || null;
  const reader = res.body.getReader();
  const stream = createWriteStream(dest);
  let downloaded = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      stream.write(value);
      downloaded += value.length;
      onProgress?.({
        stage: 'downloading',
        fraction: total ? downloaded / total : null,
        detail: `${(downloaded / 1024 / 1024).toFixed(1)} MB`,
      });
    }
  } finally {
    stream.end();
  }
  await new Promise<void>((resolve) => stream.on('finish', () => resolve()));
}
