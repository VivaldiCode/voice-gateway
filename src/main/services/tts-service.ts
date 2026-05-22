import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { app } from 'electron';
import log from 'electron-log/main';
import type { ElevenLabsConfig, PiperVoiceConfig, TtsSettings } from '@shared/types';
import { parsePiperVoiceId, piperVoiceFileUrl } from '@shared/piper-voices';
import { downloadFile as defaultDownloadFile, whichCmd as defaultWhich } from './_subprocess-utils';

export type TtsAudioFormat = 'pcm16_22050' | 'mp3';

export interface TtsChunk {
  data: Buffer;
  format: TtsAudioFormat;
  /** Monotonic per-utterance counter. */
  seq: number;
}

export interface TtsAdapterEvents {
  chunk: (c: TtsChunk) => void;
  end: () => void;
  error: (err: Error) => void;
}

export interface TtsProgressEvent {
  stage: 'downloading' | 'extracting' | 'verifying' | 'installing' | 'ready';
  fraction: number | null;
  detail?: string;
}

export interface TtsAdapter extends EventEmitter {
  readonly id: string;
  isReady(): Promise<boolean>;
  /** Idempotent. Downloads voice / verifies credentials, with progress callbacks. */
  prepare?(onProgress?: (p: TtsProgressEvent) => void): Promise<void>;
  /** Begin synthesis. Resolves when the request was accepted (not when audio finishes). */
  speak(text: string): Promise<void>;
  /** Cancel any in-flight synthesis (used for barge-in). */
  stop(): void;
}

// ───────── Piper (local) ─────────

export interface PiperAdapterOptions {
  binaryPath?: string;
  voicesDir?: string;
  config: PiperVoiceConfig;
  spawnImpl?: typeof spawn;
  whichImpl?: (cmd: string) => Promise<string | null>;
  downloadFile?: (url: string, dest: string, onProgress?: (p: TtsProgressEvent) => void) => Promise<void>;
  autoInstall?: boolean;
}

/** Binary names we'll accept, in order of preference. */
const PIPER_BINARY_CANDIDATES = ['piper', 'piper-tts'];

export class PiperAdapter extends EventEmitter implements TtsAdapter {
  readonly id = 'piper_local';
  private readonly preferredBinary: string;
  private readonly voicesDir: string;
  private readonly config: PiperVoiceConfig;
  private readonly spawnImpl: typeof spawn;
  private readonly whichImpl: (cmd: string) => Promise<string | null>;
  private readonly downloadFile: NonNullable<PiperAdapterOptions['downloadFile']>;
  private readonly autoInstall: boolean;
  private resolvedBinary: string | null = null;
  private current: ReturnType<typeof spawn> | null = null;
  private seq = 0;

  constructor(opts: PiperAdapterOptions) {
    super();
    this.preferredBinary =
      opts.binaryPath ?? join(safeUserDataPath(), 'piper', 'bin', binaryName());
    this.voicesDir = opts.voicesDir ?? join(safeUserDataPath(), 'piper', 'voices');
    this.config = opts.config;
    this.spawnImpl = opts.spawnImpl ?? spawn;
    this.whichImpl = opts.whichImpl ?? defaultWhich;
    this.downloadFile = opts.downloadFile ?? defaultDownloadFile;
    this.autoInstall = opts.autoInstall ?? false;
  }

  private modelPath(): string {
    return join(this.voicesDir, `${this.config.modelId}.onnx`);
  }

  private metadataPath(): string {
    return join(this.voicesDir, `${this.config.modelId}.onnx.json`);
  }

  private async discoverBinary(): Promise<string | null> {
    if (this.resolvedBinary) return this.resolvedBinary;
    try {
      await fs.access(this.preferredBinary);
      this.resolvedBinary = this.preferredBinary;
      return this.resolvedBinary;
    } catch {
      // fall through
    }
    for (const name of PIPER_BINARY_CANDIDATES) {
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
      await fs.access(this.metadataPath());
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Best-effort setup: discover the binary anywhere on disk, otherwise create
   * a self-contained Python venv at <userData>/piper/venv and `pip install
   * piper-tts` into it. Then download the .onnx + .onnx.json files for the
   * configured voice from Hugging Face.
   *
   * piper-tts has no Homebrew formula; the canonical install path is PyPI
   * (https://pypi.org/project/piper-tts/). We isolate it in a venv so the
   * user's system Python stays untouched.
   */
  async prepare(onProgress?: (p: TtsProgressEvent) => void): Promise<void> {
    await fs.mkdir(this.voicesDir, { recursive: true });

    let bin = await this.discoverBinary();
    if (!bin && this.autoInstall) {
      bin = await this.tryAutoInstall(onProgress);
    }
    if (!bin) {
      throw new Error(
        'Piper não está instalado. ' +
          'Forma simples: `pip3 install --user piper-tts` no terminal. ' +
          'Ou escolhe ElevenLabs em Definições > Voz.',
      );
    }

    if (!parsePiperVoiceId(this.config.modelId)) {
      throw new Error(
        `Voz Piper desconhecida: ${this.config.modelId}. Escolhe uma da lista em Definições > Voz.`,
      );
    }
    await fs.mkdir(dirname(this.modelPath()), { recursive: true });
    try {
      await fs.access(this.modelPath());
    } catch {
      const url = piperVoiceFileUrl(this.config.modelId, 'onnx');
      onProgress?.({ stage: 'downloading', fraction: 0, detail: `${this.config.modelId}.onnx` });
      await this.downloadFile(url, this.modelPath(), onProgress);
    }
    try {
      await fs.access(this.metadataPath());
    } catch {
      const url = piperVoiceFileUrl(this.config.modelId, 'onnx.json');
      onProgress?.({ stage: 'downloading', fraction: null, detail: `${this.config.modelId}.onnx.json` });
      await this.downloadFile(url, this.metadataPath(), onProgress);
    }
    onProgress?.({ stage: 'ready', fraction: 1 });
  }

  async speak(text: string): Promise<void> {
    if (!(await this.isReady())) {
      throw new Error(
        'Piper ainda não está pronto. Vai a Definições > Voz e descarrega a voz.',
      );
    }
    const bin = this.resolvedBinary;
    if (!bin) throw new Error('Piper: binário não resolvido.');

    this.stop();
    this.seq = 0;

    // piper-tts >= 1.2 uses dash-separated flags; older versions accept both.
    const args = [
      '--model', this.modelPath(),
      '--output-raw',
      '--sentence-silence', '0.2',
    ];
    const proc = this.spawnImpl(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.current = proc;

    proc.stdout?.on('data', (b: Buffer) => {
      this.seq += 1;
      this.emit('chunk', { data: b, format: 'pcm16_22050' as const, seq: this.seq });
    });
    proc.stderr?.on('data', (b: Buffer) => log.debug('[VG] piper:', b.toString().trim()));
    proc.on('error', (err) => this.emit('error', err));
    proc.on('close', (code) => {
      this.current = null;
      if (code === 0 || code === null) this.emit('end');
      else this.emit('error', new Error(`piper saiu com código ${code}`));
    });

    proc.stdin?.end(`${text}\n`);
  }

  stop(): void {
    if (this.current) {
      try {
        this.current.kill('SIGTERM');
      } catch {
        // ignore
      }
      this.current = null;
    }
  }

  /**
   * Create a venv at <userData>/piper/venv and install piper-tts into it.
   * Returns the resolved binary path on success, null on failure (caller
   * surfaces the friendly error). Stdout/stderr of pip is sent to
   * electron-log so a power user can grep ~/Library/Logs/.
   */
  private async tryAutoInstall(
    onProgress?: (p: TtsProgressEvent) => void,
  ): Promise<string | null> {
    const venvDir = join(safeUserDataPath(), 'piper', 'venv');
    const venvBin = join(venvDir, 'bin', process.platform === 'win32' ? 'piper.exe' : 'piper');

    const python3 = await this.whichImpl('python3');
    if (!python3) {
      log.warn('[VG] piper auto-install: no python3 on PATH');
      return null;
    }

    onProgress?.({ stage: 'installing', fraction: null, detail: 'a criar venv para piper-tts' });
    try {
      // Re-creating an existing venv is harmless and recovers from
      // half-built ones (e.g. from an aborted install).
      await fs.rm(venvDir, { recursive: true, force: true });
      await fs.mkdir(dirname(venvDir), { recursive: true });
      await this.runProcess(python3, ['-m', 'venv', venvDir]);
    } catch (err) {
      log.warn('[VG] piper auto-install: venv creation failed', err);
      return null;
    }

    const venvPip = join(venvDir, 'bin', process.platform === 'win32' ? 'pip.exe' : 'pip');
    onProgress?.({ stage: 'installing', fraction: null, detail: 'pip install --upgrade pip wheel' });
    try {
      await this.runProcess(venvPip, ['install', '--quiet', '--upgrade', 'pip', 'wheel']);
    } catch (err) {
      log.warn('[VG] piper auto-install: pip self-upgrade failed', err);
      // Non-fatal; older pip can still install piper-tts.
    }

    onProgress?.({ stage: 'installing', fraction: null, detail: 'pip install piper-tts' });
    try {
      await this.runProcess(venvPip, ['install', '--quiet', '--upgrade', 'piper-tts']);
    } catch (err) {
      log.warn('[VG] piper auto-install: pip install piper-tts failed', err);
      return null;
    }

    try {
      await fs.access(venvBin);
    } catch {
      log.warn('[VG] piper auto-install: binary not at', venvBin);
      return null;
    }
    this.resolvedBinary = venvBin;
    log.info('[VG] piper auto-installed at', venvBin);
    return venvBin;
  }

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
        reject(new Error(`${bin} falhou (código ${code}): ${tail || '(sem stderr)'}`));
      });
    });
  }
}

// ───────── ElevenLabs (cloud) ─────────

export interface ElevenLabsAdapterOptions {
  config: ElevenLabsConfig;
  fetchImpl?: typeof fetch;
  endpoint?: (voiceId: string) => string;
}

export class ElevenLabsAdapter extends EventEmitter implements TtsAdapter {
  readonly id = 'elevenlabs';
  private readonly config: ElevenLabsConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly endpoint: (voiceId: string) => string;
  private controller: AbortController | null = null;
  private seq = 0;

  constructor(opts: ElevenLabsAdapterOptions) {
    super();
    this.config = opts.config;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.endpoint =
      opts.endpoint ??
      ((voiceId) =>
        `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=mp3_44100_128`);
  }

  async isReady(): Promise<boolean> {
    return this.config.apiKey.trim().length > 0 && this.config.voiceId.trim().length > 0;
  }

  async speak(text: string): Promise<void> {
    if (!(await this.isReady())) {
      throw new Error('ElevenLabs precisa de chave API e voz selecionada.');
    }
    this.stop();
    this.seq = 0;
    const controller = new AbortController();
    this.controller = controller;

    const res = await this.fetchImpl(this.endpoint(this.config.voiceId), {
      method: 'POST',
      headers: {
        'xi-api-key': this.config.apiKey,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: this.config.modelId,
        voice_settings: { stability: 0.45, similarity_boost: 0.75 },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await safeText(res);
      throw new Error(`A ElevenLabs rejeitou o pedido (HTTP ${res.status}): ${body.slice(0, 200)}`);
    }
    if (!res.body) {
      throw new Error('A ElevenLabs não devolveu áudio.');
    }

    const reader = res.body.getReader();
    void this.pump(reader);
  }

  private async pump(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.length === 0) continue;
        this.seq += 1;
        this.emit('chunk', { data: Buffer.from(value), format: 'mp3' as const, seq: this.seq });
      }
      this.emit('end');
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        this.emit('end');
        return;
      }
      this.emit('error', err as Error);
    } finally {
      this.controller = null;
    }
  }

  stop(): void {
    if (this.controller) {
      try {
        this.controller.abort();
      } catch {
        // ignore
      }
      this.controller = null;
    }
  }
}

// ───────── Factory ─────────

export interface CreateTtsOptions {
  /** Allow Piper to brew-install itself if missing on macOS. */
  autoInstall?: boolean;
}

export function createTtsAdapter(
  settings: TtsSettings,
  opts: CreateTtsOptions = {},
): TtsAdapter {
  if (settings.provider === 'elevenlabs') {
    return new ElevenLabsAdapter({ config: settings.elevenlabs });
  }
  return new PiperAdapter({
    config: settings.piper,
    autoInstall: opts.autoInstall ?? false,
  });
}

// ───────── Helpers ─────────

function safeUserDataPath(): string {
  try {
    return app.getPath('userData');
  } catch {
    return join(process.cwd(), '.vg-userdata');
  }
}

function binaryName(): string {
  return process.platform === 'win32' ? 'piper.exe' : 'piper';
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
