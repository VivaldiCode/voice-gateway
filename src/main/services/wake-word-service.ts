import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { app } from 'electron';
import log from 'electron-log/main';
import type { WakeWord } from '@shared/constants';

export interface WakeWordServiceOptions {
  /** Override the path to the Python script (defaults to bundled resources). */
  scriptPath?: string;
  /** Override the Python executable (defaults to `python3`). */
  pythonExe?: string;
  /** Override the spawner — used by tests. */
  spawnImpl?: typeof spawn;
}

export interface WakeWordServiceEvents {
  ready: (models: string[]) => void;
  wake: (model: string, score: number) => void;
  error: (message: string) => void;
  exit: (code: number | null) => void;
}

/**
 * Spawns and supervises the embedded Python wake-word runner. Reads JSON
 * lines from stdout and re-emits them as typed events.
 */
export class WakeWordService extends EventEmitter {
  private readonly scriptPath: string;
  private readonly pythonExe: string;
  private readonly spawnImpl: typeof spawn;
  private proc: ChildProcess | null = null;

  constructor(opts: WakeWordServiceOptions = {}) {
    super();
    this.scriptPath = opts.scriptPath ?? defaultScriptPath();
    this.pythonExe = opts.pythonExe ?? 'python3';
    this.spawnImpl = opts.spawnImpl ?? spawn;
  }

  start(model: WakeWord, threshold = 0.5): void {
    if (this.proc) return;
    log.info('[VG] wake-word start', model, 'threshold', threshold);
    const proc = this.spawnImpl(
      this.pythonExe,
      [this.scriptPath, '--model', model, '--threshold', String(threshold)],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    this.proc = proc;

    if (proc.stdout) {
      const lines = createInterface({ input: proc.stdout });
      lines.on('line', (line) => this.handleLine(line));
    }
    proc.stderr?.on('data', (b: Buffer) =>
      log.debug('[VG] wake-word:', b.toString().trim()),
    );
    proc.on('error', (err) => this.emit('error', err.message));
    proc.on('exit', (code) => {
      this.proc = null;
      this.emit('exit', code);
    });
  }

  stop(): void {
    if (!this.proc) return;
    try {
      this.proc.kill('SIGTERM');
    } catch (err) {
      log.warn('[VG] wake-word stop failed', err);
    }
    this.proc = null;
  }

  isRunning(): boolean {
    return this.proc !== null;
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      log.warn('[VG] wake-word: bad JSON line:', line.slice(0, 100));
      return;
    }
    if (!isRecord(parsed) || typeof parsed['event'] !== 'string') return;
    switch (parsed['event']) {
      case 'ready':
        if (isStringArray(parsed['models'])) this.emit('ready', parsed['models']);
        return;
      case 'wake': {
        const model = parsed['model'];
        const score = parsed['score'];
        if (typeof model === 'string' && typeof score === 'number') {
          this.emit('wake', model, score);
        }
        return;
      }
      case 'error':
        if (typeof parsed['message'] === 'string') this.emit('error', parsed['message']);
        return;
    }
  }
}

function defaultScriptPath(): string {
  // In production the runner sits under resources/ extracted by electron-builder.
  // In dev we point at the in-repo copy.
  try {
    if (app.isPackaged) {
      return join(process.resourcesPath, 'python', 'wake_word_runner.py');
    }
  } catch {
    // outside Electron
  }
  return join(process.cwd(), 'resources', 'python', 'wake_word_runner.py');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}
