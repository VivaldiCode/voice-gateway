import { promises as fs } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { app } from 'electron';
import log from 'electron-log/main';
import type { WakeWord } from '@shared/constants';
import { whichCmd as defaultWhich } from './_subprocess-utils';

export interface WakeWordServiceOptions {
  /** Override the path to the Python script (defaults to bundled resources). */
  scriptPath?: string;
  /** Override the Python executable (defaults to discovery via auto-install / PATH). */
  pythonExe?: string;
  /** Override the spawner — used by tests. */
  spawnImpl?: typeof spawn;
  /** Override the `which` helper — used by tests. */
  whichImpl?: (cmd: string) => Promise<string | null>;
  /**
   * If true (default in production), the service tries to create a venv at
   * `<userData>/wake/venv` and `pip install -r requirements.txt` into it on
   * first start. Off in tests where we inject a fake spawn instead.
   */
  autoInstall?: boolean;
}

export interface WakeWordServiceEvents {
  ready: (info: { models?: string[]; phrase?: string }) => void;
  wake: (info: { model?: string; phrase?: string; score?: number; transcript?: string }) => void;
  /** Phrase mode only — every transcribed window, even non-matching ones. */
  transcript: (text: string) => void;
  error: (message: string) => void;
  exit: (code: number | null) => void;
}

export interface OpenWwParams {
  mode: 'openww';
  model: WakeWord;
  threshold?: number;
}

export interface PhraseParams {
  mode: 'phrase';
  phrase: string;
  whisperBin: string;
  whisperModel: string;
  language?: string;
  cooldownSec?: number;
}

export type WakeStartParams = OpenWwParams | PhraseParams;

const REQUIREMENTS_FILENAME = 'requirements.txt';

/**
 * Spawns and supervises the embedded Python wake-word runner.
 *
 * - Supports both openWakeWord and the streaming-whisper "phrase" mode.
 * - Auto-creates a venv at `<userData>/wake/venv` on first start so a fresh
 *   macOS install doesn't have to manually `pip install openwakeword`.
 * - Reads JSON lines from stdout and re-emits them as typed events.
 */
export class WakeWordService extends EventEmitter {
  private readonly scriptPath: string;
  private readonly explicitPythonExe: string | null;
  private readonly spawnImpl: typeof spawn;
  private readonly whichImpl: (cmd: string) => Promise<string | null>;
  private readonly autoInstall: boolean;
  private proc: ChildProcess | null = null;
  /** Cached resolved python exe across multiple start() calls. */
  private resolvedPython: string | null = null;

  constructor(opts: WakeWordServiceOptions = {}) {
    super();
    this.scriptPath = opts.scriptPath ?? defaultScriptPath();
    this.explicitPythonExe = opts.pythonExe ?? null;
    this.spawnImpl = opts.spawnImpl ?? spawn;
    this.whichImpl = opts.whichImpl ?? defaultWhich;
    this.autoInstall = opts.autoInstall ?? true;
  }

  /**
   * Resolve a python executable that has openwakeword (or sounddevice for
   * phrase mode) installed. Order:
   *
   *   1. The explicit `pythonExe` option, if provided.
   *   2. The cached venv binary at `<userData>/wake/venv/bin/python`, if it
   *      exists.
   *   3. A freshly-built venv at the same path (if `autoInstall` is true).
   *   4. The system `python3` on PATH.
   *
   * Returns the absolute path on success or null if nothing usable was found.
   */
  async resolvePython(): Promise<string | null> {
    if (this.explicitPythonExe) return this.explicitPythonExe;
    if (this.resolvedPython) return this.resolvedPython;

    const venvPy = join(safeUserDataPath(), 'wake', 'venv', 'bin', pythonName());
    try {
      await fs.access(venvPy);
      this.resolvedPython = venvPy;
      return venvPy;
    } catch {
      // venv doesn't exist yet — fall through
    }

    if (this.autoInstall) {
      const built = await this.buildVenv();
      if (built) {
        this.resolvedPython = built;
        return built;
      }
    }

    const sysPy = await this.whichImpl('python3');
    if (sysPy) {
      this.resolvedPython = sysPy;
      return sysPy;
    }
    return null;
  }

  /**
   * Build the wake-word venv at `<userData>/wake/venv` and pip-install the
   * runner's requirements.txt into it. Returns the venv's python path on
   * success, null on failure. Recreates from scratch on each call so a
   * half-built venv from a previous aborted install gets cleaned up.
   */
  private async buildVenv(): Promise<string | null> {
    const venvDir = join(safeUserDataPath(), 'wake', 'venv');
    const venvPy = join(venvDir, 'bin', pythonName());
    const venvPip = join(venvDir, 'bin', pipName());

    const sysPy = await this.whichImpl('python3');
    if (!sysPy) {
      log.warn('[VG] wake auto-install: no python3 on PATH');
      return null;
    }

    log.info('[VG] wake auto-install: creating venv at', venvDir);
    try {
      await fs.rm(venvDir, { recursive: true, force: true });
      await fs.mkdir(dirname(venvDir), { recursive: true });
      await runProcess(this.spawnImpl, sysPy, ['-m', 'venv', venvDir]);
    } catch (err) {
      log.warn('[VG] wake auto-install: venv creation failed', err);
      return null;
    }

    try {
      await runProcess(this.spawnImpl, venvPip, ['install', '--quiet', '--upgrade', 'pip', 'wheel']);
    } catch (err) {
      log.warn('[VG] wake auto-install: pip self-upgrade failed (non-fatal)', err);
    }

    const reqPath = join(dirname(this.scriptPath), REQUIREMENTS_FILENAME);
    try {
      await fs.access(reqPath);
    } catch {
      log.warn('[VG] wake auto-install: requirements.txt missing at', reqPath);
      return null;
    }

    try {
      await runProcess(this.spawnImpl, venvPip, ['install', '--quiet', '-r', reqPath]);
    } catch (err) {
      log.warn('[VG] wake auto-install: pip install -r failed', err);
      return null;
    }

    try {
      await fs.access(venvPy);
    } catch {
      log.warn('[VG] wake auto-install: venv python missing at', venvPy);
      return null;
    }
    log.info('[VG] wake auto-installed at', venvPy);
    return venvPy;
  }

  /**
   * Start the runner. Idempotent — second call while a process is alive is
   * a no-op. Emits 'error' instead of throwing when the python interpreter
   * is missing so callers can surface it to the UI.
   */
  async start(params: WakeStartParams): Promise<void> {
    if (this.proc) return;
    const python = await this.resolvePython();
    if (!python) {
      this.emit('error', 'Não consegui encontrar python3. Instala o Python para ativar a deteção por wake word.');
      return;
    }

    const args = this.buildArgs(params);
    log.info('[VG] wake-word start', { mode: params.mode, python });
    let proc: ChildProcess;
    try {
      proc = this.spawnImpl(python, [this.scriptPath, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      this.emit('error', err instanceof Error ? err.message : 'spawn failed');
      return;
    }
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
      if (this.proc === proc) this.proc = null;
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

  private buildArgs(params: WakeStartParams): string[] {
    if (params.mode === 'openww') {
      return [
        '--mode', 'openww',
        '--model', params.model,
        '--threshold', String(params.threshold ?? 0.5),
      ];
    }
    return [
      '--mode', 'phrase',
      '--phrase', params.phrase,
      '--whisper-bin', params.whisperBin,
      '--whisper-model', params.whisperModel,
      '--language', params.language ?? 'auto',
      '--cooldown', String(params.cooldownSec ?? 1.5),
    ];
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
      case 'ready': {
        const models = isStringArray(parsed['models']) ? parsed['models'] : undefined;
        const phrase = typeof parsed['phrase'] === 'string' ? parsed['phrase'] : undefined;
        this.emit('ready', { ...(models ? { models } : {}), ...(phrase ? { phrase } : {}) });
        return;
      }
      case 'wake': {
        const model = typeof parsed['model'] === 'string' ? parsed['model'] : undefined;
        const phrase = typeof parsed['phrase'] === 'string' ? parsed['phrase'] : undefined;
        const score = typeof parsed['score'] === 'number' ? parsed['score'] : undefined;
        const transcript = typeof parsed['transcript'] === 'string' ? parsed['transcript'] : undefined;
        this.emit('wake', {
          ...(model ? { model } : {}),
          ...(phrase ? { phrase } : {}),
          ...(score !== undefined ? { score } : {}),
          ...(transcript ? { transcript } : {}),
        });
        return;
      }
      case 'transcript':
        if (typeof parsed['text'] === 'string') this.emit('transcript', parsed['text']);
        return;
      case 'error':
        if (typeof parsed['message'] === 'string') this.emit('error', parsed['message']);
        return;
    }
  }
}

function defaultScriptPath(): string {
  try {
    if (app.isPackaged) {
      return join(process.resourcesPath, 'python', 'wake_word_runner.py');
    }
  } catch {
    // outside Electron
  }
  return join(process.cwd(), 'resources', 'python', 'wake_word_runner.py');
}

function safeUserDataPath(): string {
  try {
    return app.getPath('userData');
  } catch {
    return join(process.cwd(), '.vg-userdata');
  }
}

function pythonName(): string {
  return process.platform === 'win32' ? 'python.exe' : 'python';
}

function pipName(): string {
  return process.platform === 'win32' ? 'pip.exe' : 'pip';
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

async function runProcess(
  spawnImpl: typeof spawn,
  bin: string,
  args: string[],
): Promise<string> {
  return new Promise((resolve, reject) => {
    let proc: ChildProcess;
    try {
      proc = spawnImpl(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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
