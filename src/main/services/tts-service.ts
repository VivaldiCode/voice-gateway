import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { app } from 'electron';
import log from 'electron-log/main';
import type { ElevenLabsConfig, PiperVoiceConfig, TtsSettings } from '@shared/types';

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

export interface TtsAdapter extends EventEmitter {
  readonly id: string;
  isReady(): Promise<boolean>;
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
}

export class PiperAdapter extends EventEmitter implements TtsAdapter {
  readonly id = 'piper_local';
  private readonly binaryPath: string;
  private readonly voicesDir: string;
  private readonly config: PiperVoiceConfig;
  private readonly spawnImpl: typeof spawn;
  private current: ReturnType<typeof spawn> | null = null;
  private seq = 0;

  constructor(opts: PiperAdapterOptions) {
    super();
    this.binaryPath = opts.binaryPath ?? join(safeUserDataPath(), 'piper', 'bin', binaryName());
    this.voicesDir = opts.voicesDir ?? join(safeUserDataPath(), 'piper', 'voices');
    this.config = opts.config;
    this.spawnImpl = opts.spawnImpl ?? spawn;
  }

  async isReady(): Promise<boolean> {
    try {
      await fs.access(this.binaryPath);
      await fs.access(join(this.voicesDir, `${this.config.modelId}.onnx`));
      await fs.access(join(this.voicesDir, `${this.config.modelId}.onnx.json`));
      return true;
    } catch {
      return false;
    }
  }

  async speak(text: string): Promise<void> {
    if (!(await this.isReady())) {
      throw new Error(
        'Piper local não está instalado. Vai a Definições > Voz para fazer download da voz.',
      );
    }
    this.stop();
    this.seq = 0;

    const modelPath = join(this.voicesDir, `${this.config.modelId}.onnx`);
    const args = ['--model', modelPath, '--output_raw', '--sentence_silence', '0.2'];
    const proc = this.spawnImpl(this.binaryPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
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

export function createTtsAdapter(settings: TtsSettings): TtsAdapter {
  if (settings.provider === 'elevenlabs') {
    return new ElevenLabsAdapter({ config: settings.elevenlabs });
  }
  return new PiperAdapter({ config: settings.piper });
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
