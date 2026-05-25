/**
 * Shared Playwright test rig for Voice Gateway E2E.
 *
 * Centralises the boilerplate that every spec was duplicating:
 *
 *   - locating the packaged Voice Gateway.app
 *   - seeding electron-store with a pre-paired settings.json so the wizard
 *     doesn't appear
 *   - launching with the Chromium flags we always want in tests
 *     (disable GPU, optionally fake mic, fake-runner env vars)
 *   - opening the dedicated Settings BrowserWindow via IPC and waiting
 *     for it to load
 *   - tiny typed wrappers around `window.vg.*` so specs don't need to
 *     re-state the cast every time
 *
 * Each spec creates its own temp `userData` so parallel-friendly later if
 * we ever drop `workers: 1`.
 */
import {
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { existsSync, mkdirSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where to allocate per-test `userData` directories. Defaults to the OS
 * tmpdir, but `VG_E2E_TMPDIR` can override — useful when the system volume
 * is tight on space (real failure mode hit during round-5: a single full
 * Playwright run plus electron-builder's DMG staging blew through 990 MB
 * of system /tmp and crashed the harness mid-run). Setting
 * `VG_E2E_TMPDIR=/Volumes/<roomy-disk>/.vg-e2e` keeps the system
 * filesystem clean while the suite runs.
 */
export function vgTmpdir(): string {
  const override = process.env['VG_E2E_TMPDIR'];
  if (override && override.trim().length > 0) {
    try {
      mkdirSync(override, { recursive: true });
      return override;
    } catch {
      // Fall through to the system tmpdir if the override isn't writable.
    }
  }
  return tmpdir();
}

const ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
export const PACKAGED_EXEC = join(
  ROOT,
  'release/mac-arm64/Voice Gateway.app/Contents/MacOS/Voice Gateway',
);
export const FIXTURES_DIR = join(ROOT, 'tests/e2e/fixtures');

export function packagedAppExists(): boolean {
  return existsSync(PACKAGED_EXEC);
}

export interface SeedSettingsOptions {
  /** ws:// URL of the bridge to wire into the settings. */
  bridgeUrl: string;
  /** Bearer token expected by the bridge. */
  bridgeToken: string;
  /** Override defaults for `activation`. Merged shallow over the baseline. */
  activation?: Partial<{
    mode: 'PUSH_TO_TALK' | 'WAKE_WORD';
    wakeWord: string;
    wakeMode: 'openww' | 'phrase';
    wakePhrase: string;
    globalHotkey: string;
    vadThreshold: number;
    vadSilenceMs: number;
    minAudioMs: number;
  }>;
}

export async function writeSeedSettings(
  userData: string,
  opts: SeedSettingsOptions,
): Promise<void> {
  const settingsFile = join(userData, 'voice-gateway-settings.json');
  await mkdir(userData, { recursive: true });
  const activation = {
    mode: 'PUSH_TO_TALK' as const,
    wakeWord: 'hey_jarvis',
    wakeMode: 'openww' as const,
    wakePhrase: 'hey hermes',
    globalHotkey: 'CommandOrControl+Shift+H',
    vadThreshold: 0.5,
    vadSilenceMs: 800,
    minAudioMs: 200,
    ...opts.activation,
  };
  await writeFile(
    settingsFile,
    JSON.stringify({
      settings: {
        pairing: { url: opts.bridgeUrl, token: opts.bridgeToken },
        activation,
        stt: {
          provider: 'whisper_local',
          language: 'auto',
          whisperLocal: { model: 'base' },
          openai: { apiKey: '', model: 'whisper-1' },
        },
        tts: {
          provider: 'piper_local',
          piper: { modelId: 'en_US-lessac-medium' },
          elevenlabs: { apiKey: '', voiceId: '', modelId: 'eleven_turbo_v2_5' },
        },
        audio: { inputDeviceId: null, outputDeviceId: null, outputMuted: false },
        ui: { language: 'pt', theme: 'dark', startMinimized: false, autoLaunch: false },
        connection: { recentUrls: [], draftUrl: '' },
        transcript: { recent: [] },
        schemaVersion: 5,
      },
    }),
  );
}

export interface LaunchOptions {
  /** Required — used to seed pairing into electron-store. */
  bridgeUrl: string;
  bridgeToken: string;
  /** Optional overrides for the seeded activation block. */
  activation?: SeedSettingsOptions['activation'];
  /** Path to a WAV file to feed as fake mic input. Implies --use-fake-device. */
  fakeAudioFile?: string;
  /** Extra Chromium args to append. */
  extraArgs?: string[];
  /** Extra env vars to pass to the Electron process. */
  extraEnv?: Record<string, string>;
}

export interface TestRig {
  app: ElectronApplication;
  mainWindow: Page;
  userData: string;
  /** Convenience cleanup. Idempotent. */
  dispose: () => Promise<void>;
}

/**
 * Launch the packaged app **without** seeding a pairing — exercises the
 * first-run wizard path. Otherwise identical to `launchPackaged`.
 */
export async function launchUnpaired(
  opts: Omit<LaunchOptions, 'bridgeUrl' | 'bridgeToken'> = {},
): Promise<TestRig> {
  const userData = await mkdtemp(join(vgTmpdir(), 'vg-e2e-unpaired-'));
  // No settings.json — electron-store will create defaults with pairing=null,
  // which triggers the PairingWizard on first render.

  const args: string[] = [
    `--user-data-dir=${userData}`,
    '--autoplay-policy=no-user-gesture-required',
  ];
  if (opts.fakeAudioFile) {
    args.push('--use-fake-device-for-media-stream');
    args.push(`--use-file-for-fake-audio-capture=${opts.fakeAudioFile}`);
  }
  args.push(...(opts.extraArgs ?? []));

  const app = await electron.launch({
    executablePath: PACKAGED_EXEC,
    args,
    env: { ...process.env, VG_E2E: '1', ...opts.extraEnv },
    timeout: 30_000,
  });

  if (process.env['VG_E2E_VERBOSE'] === '1') {
    const proc = app.process();
    proc.stderr?.on('data', (b: Buffer) =>
      process.stderr.write(`[main stderr] ${b.toString()}`),
    );
    proc.stdout?.on('data', (b: Buffer) =>
      process.stdout.write(`[main stdout] ${b.toString()}`),
    );
  }

  const mainWindow = await app.firstWindow({ timeout: 15_000 });
  await mainWindow.waitForLoadState('domcontentloaded');

  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    try {
      await app.close();
    } catch {
      // ignore
    }
    try {
      await rm(userData, { recursive: true, force: true });
    } catch {
      // ignore
    }
  };
  return { app, mainWindow, userData, dispose };
}

export async function launchPackaged(opts: LaunchOptions): Promise<TestRig> {
  const userData = await mkdtemp(join(vgTmpdir(), 'vg-e2e-'));
  await writeSeedSettings(userData, {
    bridgeUrl: opts.bridgeUrl,
    bridgeToken: opts.bridgeToken,
    ...(opts.activation ? { activation: opts.activation } : {}),
  });

  const args: string[] = [
    `--user-data-dir=${userData}`,
    // Without a real user gesture inside an electron.launch session, the
    // Chromium autoplay heuristic suspends new AudioContexts. Tests need to
    // get audio out, so opt out of the policy.
    '--autoplay-policy=no-user-gesture-required',
  ];
  if (opts.fakeAudioFile) {
    args.push('--use-fake-device-for-media-stream');
    args.push(`--use-file-for-fake-audio-capture=${opts.fakeAudioFile}`);
  }
  args.push(...(opts.extraArgs ?? []));

  const app = await electron.launch({
    executablePath: PACKAGED_EXEC,
    args,
    env: { ...process.env, VG_E2E: '1', ...opts.extraEnv },
    timeout: 30_000,
  });

  // Forward main-process stderr (electron-log writes there) when verbose.
  // Plays back logs about WS connect attempts, settings rebuilds, etc — the
  // stuff that explains "why didn't the indicator turn green?".
  if (process.env['VG_E2E_VERBOSE'] === '1') {
    const proc = app.process();
    proc.stderr?.on('data', (b: Buffer) => {
      // eslint-disable-next-line no-console
      process.stderr.write(`[main stderr] ${b.toString()}`);
    });
    proc.stdout?.on('data', (b: Buffer) => {
      // eslint-disable-next-line no-console
      process.stdout.write(`[main stdout] ${b.toString()}`);
    });
  }

  const mainWindow = await app.firstWindow({ timeout: 15_000 });
  // Forward EVERY console message during E2E. Verbosity is cheap and the
  // diagnostics save hours when a connection silently fails.
  const verboseConsole = process.env['VG_E2E_VERBOSE'] === '1';
  mainWindow.on('console', (msg) => {
    const t = msg.type();
    if (verboseConsole || t === 'error' || t === 'warning') {
      // eslint-disable-next-line no-console
      console.log(`[main ${t}] ${msg.text()}`);
    }
  });
  mainWindow.on('pageerror', (err) => {
    // eslint-disable-next-line no-console
    console.log(`[main pageerror] ${err.message}`);
  });
  await mainWindow.waitForLoadState('domcontentloaded');

  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    try {
      await app.close();
    } catch {
      // ignore
    }
    try {
      await rm(userData, { recursive: true, force: true });
    } catch {
      // ignore
    }
  };

  return { app, mainWindow, userData, dispose };
}

/**
 * Open the dedicated Settings BrowserWindow via the same IPC that the gear
 * icon uses, wait for it to be ready, install standard log forwarding.
 */
export async function openSettingsWindow(rig: TestRig): Promise<Page> {
  const open = rig.app.waitForEvent('window', { timeout: 10_000 });
  await rig.mainWindow.evaluate(() => {
    const w = globalThis as unknown as {
      vg: { settings: { openWindow: () => void } };
    };
    w.vg.settings.openWindow();
  });
  const settings = await open;
  settings.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      // eslint-disable-next-line no-console
      console.log(`[settings ${msg.type()}] ${msg.text()}`);
    }
  });
  settings.on('pageerror', (err) => {
    // eslint-disable-next-line no-console
    console.log(`[settings pageerror] ${err.message}`);
  });
  await settings.waitForLoadState('domcontentloaded');
  return settings;
}

/**
 * Subscribe (in-page) to `vg.conversation.onTtsChunk` and stash chunk count
 * + total bytes on `window.__vg_tts_chunks` / `__vg_tts_bytes`. Resolves
 * once the listener is attached.
 */
export async function instrumentTtsCounter(page: Page): Promise<void> {
  await page.evaluate(() => {
    interface W {
      vg: {
        conversation: {
          onTtsChunk: (
            cb: (c: { seq: number; format: string; data: string }) => void,
          ) => () => void;
          onResponseText: (cb: (c: { text: string; final: boolean }) => void) => () => void;
          onState: (cb: (s: { state: string; turnId: string | null }) => void) => () => void;
          onWarning: (cb: (c: { code: string; message: string }) => void) => () => void;
          onError: (cb: (c: { code: string; message: string }) => void) => () => void;
        };
      };
      __vg_tts_chunks?: number;
      __vg_tts_bytes?: number;
      __vg_last_response?: string;
      __vg_state_log?: Array<{ state: string; turnId: string | null }>;
      __vg_warnings?: string[];
      __vg_errors?: string[];
    }
    const w = globalThis as unknown as W;
    w.__vg_tts_chunks = 0;
    w.__vg_tts_bytes = 0;
    w.__vg_state_log = [];
    w.__vg_warnings = [];
    w.__vg_errors = [];
    w.vg.conversation.onTtsChunk((c) => {
      w.__vg_tts_chunks = (w.__vg_tts_chunks ?? 0) + 1;
      w.__vg_tts_bytes = (w.__vg_tts_bytes ?? 0) + atob(c.data).length;
    });
    w.vg.conversation.onResponseText((c) => {
      if (c.text) w.__vg_last_response = c.text;
    });
    w.vg.conversation.onState((s) => {
      w.__vg_state_log!.push({ state: s.state, turnId: s.turnId });
    });
    w.vg.conversation.onWarning((c) => {
      w.__vg_warnings!.push(`${c.code}:${c.message}`);
    });
    w.vg.conversation.onError((c) => {
      w.__vg_errors!.push(`${c.code}:${c.message}`);
    });
  });
}

export interface VgStats {
  chunks: number;
  bytes: number;
  lastResponse: string | undefined;
  stateLog: Array<{ state: string; turnId: string | null }>;
  warnings: string[];
  errors: string[];
}

export async function readVgStats(page: Page): Promise<VgStats> {
  return await page.evaluate(() => {
    const w = globalThis as unknown as {
      __vg_tts_chunks?: number;
      __vg_tts_bytes?: number;
      __vg_last_response?: string;
      __vg_state_log?: Array<{ state: string; turnId: string | null }>;
      __vg_warnings?: string[];
      __vg_errors?: string[];
    };
    return {
      chunks: w.__vg_tts_chunks ?? 0,
      bytes: w.__vg_tts_bytes ?? 0,
      lastResponse: w.__vg_last_response,
      stateLog: w.__vg_state_log ?? [],
      warnings: w.__vg_warnings ?? [],
      errors: w.__vg_errors ?? [],
    };
  });
}

/**
 * Async-ask the running main process via IPC whether the local STT adapter
 * is in a usable state. Used by audio E2Es to skip cleanly when the dev
 * machine doesn't have whisper-cli installed.
 */
export async function sttReady(page: Page): Promise<{ ok: boolean; message?: string }> {
  return await page.evaluate(async () => {
    const w = globalThis as unknown as {
      vg: { stt: { prepare: () => Promise<{ ok: boolean; message?: string }> } };
    };
    return await w.vg.stt.prepare();
  });
}

/**
 * Symmetric counterpart to sttReady. Waits until the local TTS adapter is
 * installed + the voice model is on disk. On a fresh userData this blocks
 * for ~15-60 s as Piper's venv is built and the voice .onnx downloaded.
 * Callers that don't need synthesised audio (just want chunks to flow)
 * can skip this; tests that race the FSM into SPEAKING need it.
 */
export async function ttsReady(page: Page): Promise<{ ok: boolean; message?: string }> {
  return await page.evaluate(async () => {
    const w = globalThis as unknown as {
      vg: { tts: { prepare: () => Promise<{ ok: boolean; message?: string }> } };
    };
    return await w.vg.tts.prepare();
  });
}

/**
 * Press the call button, hold for `ms` milliseconds, release. The pointer
 * event pair is what the CallButton component listens for (not click). Used
 * by every conversation-flow spec.
 */
export async function holdPtt(page: Page, ms: number): Promise<void> {
  const btn = page.getByTestId('call-button');
  await btn.dispatchEvent('pointerdown');
  await page.waitForTimeout(ms);
  await btn.dispatchEvent('pointerup');
}

/**
 * Wait until the last `state` event recorded by `instrumentTtsCounter`
 * matches one of the given states. Returns the matching state. Throws if
 * the timeout expires without a match — surfaces what we DID see for
 * actionable diagnostics.
 */
export async function waitForState(
  page: Page,
  desired: ReadonlyArray<string>,
  opts: { timeoutMs?: number } = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const desiredSet = new Set(desired);
  const start = Date.now();
  let last: string = '';
  while (Date.now() - start < timeoutMs) {
    const stats = await readVgStats(page);
    last = stats.stateLog.at(-1)?.state ?? '';
    if (desiredSet.has(last)) return last;
    await page.waitForTimeout(100);
  }
  const recent = (await readVgStats(page)).stateLog
    .slice(-10)
    .map((s) => s.state)
    .join(' → ');
  throw new Error(
    `waitForState timed out after ${timeoutMs} ms — wanted [${desired.join(', ')}], last=${last}, recent=${recent}`,
  );
}

/**
 * Trigger a wake event on the **fake** wake runner. Only valid when the app
 * was launched with `VG_WAKE_E2E_FAKE=1` and `activation.mode === 'WAKE_WORD'`.
 * The fake runner emits its wake autonomously after ~1.5 s — this helper
 * just waits for the FSM to land in CAPTURING.
 */
export async function waitForWake(page: Page, timeoutMs = 5_000): Promise<void> {
  await waitForState(page, ['CAPTURING'], { timeoutMs });
}
