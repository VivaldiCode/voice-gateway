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
/**
 * Compute the Chromium flags that hide the Electron window. Enabled when
 * `VG_E2E_HEADLESS=1` is set — used by CI (GitHub Actions, etc.) so the
 * test run doesn't pop a visible window on every spec. Locally we leave
 * it off so developers can watch the FSM transitions live while iterating.
 *
 * The `--headless=new` flag is Chromium's current opt-in for the modern
 * headless mode; `--disable-gpu` keeps software rendering reliable on
 * GitHub Actions runners that don't have a GPU. We also disable the
 * sandbox (Electron + headless + sandbox is buggy on Linux CI) and pass
 * `--no-sandbox` only when explicitly headless to avoid weakening local
 * security.
 */
export function headlessArgs(): readonly string[] {
  if (process.env['VG_E2E_HEADLESS'] !== '1') return [];
  // `--use-fake-ui-for-media-stream` auto-grants getUserMedia in headless
  // mode where Chromium has no permission dialog to fall back on — without
  // it any spec that opens a mic stream hangs forever. Pair it with
  // --use-fake-device-for-media-stream (which the rig already adds
  // per-spec when fakeAudioFile is set) for the WAV-backed audio path.
  // Reviewer-suggested nit on PR #8 (round 12).
  return [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--use-fake-ui-for-media-stream',
  ];
}

/**
 * CI-aware timeout knob. Returns `ci` when `process.env.CI` is set (GH
 * Actions, CircleCI, etc. all set it), otherwise returns `local`. Used
 * across the rig so dev iteration stays snappy (low timeouts surface
 * regressions fast) while CI tolerates the slower macos-latest +
 * headless-Chromium boot — the GH runner only has 2 vCPU and headless
 * Chromium's BrowserWindow init can take 12-15 s under cold-cache CPU
 * pressure (issue #18).
 *
 * Do not use this to paper over assertion failures — it's only for
 * pure "wait for the OS / Chromium / Electron to do a thing" gates.
 */
export function ciTimeout(local: number, ci: number): number {
  return process.env['CI'] ? ci : local;
}

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
        // tutorialSeen:true keeps the I5 post-pair overlay out of every
        // E2E so existing specs aren't blocked. Specs that exercise the
        // tutorial flow seed their own settings file.
        ui: { language: 'pt', theme: 'dark', startMinimized: false, autoLaunch: false, tutorialSeen: true },
        connection: { recentUrls: [], draftUrl: '' },
        transcript: { recent: [] },
        schemaVersion: 6,
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
    ...headlessArgs(),
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
    // CI cold-boot for the packaged .app + Electron under load takes 30-45 s.
    // Local runs typically settle in 5-8 s.
    timeout: ciTimeout(30_000, 60_000),
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

  const mainWindow = await app.firstWindow({ timeout: ciTimeout(15_000, 45_000) });
  await mainWindow.waitForLoadState('domcontentloaded');
  // unpaired path also benefits from early instrumentation — wizard
  // flows can still observe state events after pairing completes.
  await waitForVgReady(mainWindow);
  await instrumentTtsCounter(mainWindow);
  // Round-12 follow-up to issue #18: headless Chromium denies the
  // clipboard-write permission. Patch every page so renderer code that
  // calls navigator.clipboard.writeText doesn't surface as a
  // pageerror that masks the real test outcome.
  await grantClipboardWrite(mainWindow);

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
    ...headlessArgs(),
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
    // CI cold-boot — see ciTimeout() doc.
    timeout: ciTimeout(30_000, 60_000),
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

  const mainWindow = await app.firstWindow({ timeout: ciTimeout(15_000, 45_000) });
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
  // Auto-instrument the renderer EARLY so onState listeners attach
  // before the FSM can transition. Round-12 issue #18 traced the
  // wake-event flake to a race where the fake wake runner emitted
  // 'wake' during the 15 s connection wait, BEFORE the spec called
  // instrumentTtsCounter — so the LISTENING_WAKE→CAPTURING transition
  // was missed and waitForState timed out with empty stateLog. Wiring
  // listeners during launch removes the window entirely. Specs that
  // still call instrumentTtsCounter() get a no-op (it's idempotent).
  // (waitForState ALSO polls the renderer's DOM-rendered data-state as
  // a fallback — see waitForState doc.)
  await waitForVgReady(mainWindow);
  await instrumentTtsCounter(mainWindow);
  // Round-12 follow-up to issue #18: see grantClipboardWrite doc.
  await grantClipboardWrite(mainWindow);

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
 * Wait until the preload-exposed `window.vg.conversation` API is defined.
 * Round-12 issue #18: on CI macos-latest with headless Chromium, there's
 * a measurable window between `domcontentloaded` firing and the preload
 * script finishing its contextBridge.exposeInMainWorld() calls. Calling
 * `vg.conversation.onState(...)` before that finishes silently no-ops
 * (the property is undefined), which is what makes instrumentTtsCounter
 * "succeed" without actually attaching any listeners.
 */
export async function waitForVgReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const w = globalThis as unknown as {
        vg?: { conversation?: { onState?: unknown } };
      };
      return Boolean(w.vg?.conversation?.onState);
    },
    undefined,
    { timeout: ciTimeout(10_000, 30_000) },
  );
}

/**
 * Open the dedicated Settings BrowserWindow via the same IPC that the gear
 * icon uses, wait for it to be ready, install standard log forwarding.
 *
 * The waitForEvent('window') timeout was 10 s historically — empirically
 * too tight on the GH macos-latest runner under CPU pressure where a
 * cold BrowserWindow open can take 12-15 s. ciTimeout bumps it to 30 s
 * on CI without slowing local iteration. (Round-12 issue #18.)
 */
export async function openSettingsWindow(rig: TestRig): Promise<Page> {
  const open = rig.app.waitForEvent('window', { timeout: ciTimeout(10_000, 30_000) });
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
 *
 * Idempotent (round-12 issue #18): `launchPackaged` now auto-instruments
 * during boot so listeners attach BEFORE any FSM transition can fire.
 * Existing test calls to this function pass an `__vg_instrumented` flag
 * check and become no-ops. Without the guard, calling twice would
 * register duplicate listeners — fine for counting but it would also
 * RESET the state log to empty, hiding any transitions captured during
 * launch (which is exactly the bug we're fixing).
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
      __vg_instrumented?: boolean;
    }
    const w = globalThis as unknown as W;
    if (w.__vg_instrumented) return;
    w.__vg_instrumented = true;
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

/**
 * Monkey-patch `navigator.clipboard.writeText` in the renderer so
 * `Clipboard.writeText("...")` calls always resolve, even on macos-latest
 * headless Chromium where the clipboard-write permission is denied by
 * default (no user-gesture, no permissions dialog).
 *
 * Specs that need to ASSERT on the copied value can read
 * `window.__vg_last_clip` after the click; specs that just need the
 * click handler not to crash get a silent swallow.
 *
 * Called automatically from `launchPackaged` / `launchUnpaired` so every
 * spec is protected — round-12 follow-up to issue #18, where three
 * specs (Cmd+S transcript export, "copiar" button, "Copiar
 * diagnóstico" toast) intermittently failed with
 * `[main pageerror] Failed to execute 'writeText' on 'Clipboard': Write
 * permission denied.` on the GH macos-latest runner. The renderer's
 * error toast was treating the pageerror as a test failure even though
 * the user-facing copy still worked locally.
 *
 * Idempotent — second call is a no-op.
 */
export async function grantClipboardWrite(page: Page): Promise<void> {
  await page.evaluate(() => {
    interface W {
      __vg_clipboard_patched?: boolean;
      __vg_last_clip?: string | null;
      navigator: { clipboard?: { writeText?: (s: string) => Promise<void> } };
    }
    const w = globalThis as unknown as W;
    if (w.__vg_clipboard_patched) return;
    w.__vg_clipboard_patched = true;
    w.__vg_last_clip = null;
    // navigator.clipboard may be undefined when the page hasn't fully
    // hydrated (rare, but possible during a reload). Guard against it
    // so the helper itself doesn't throw and break the test setup.
    if (!w.navigator.clipboard) {
      w.navigator.clipboard = { writeText: async () => undefined };
    }
    const orig = w.navigator.clipboard.writeText?.bind(w.navigator.clipboard);
    w.navigator.clipboard.writeText = async (s: string): Promise<void> => {
      w.__vg_last_clip = s;
      if (!orig) return;
      try {
        await orig(s);
      } catch {
        // Headless Chromium denies the write — swallow so the renderer's
        // try/catch doesn't surface as a pageerror.
      }
    };
  });
}

/**
 * Read whatever was most recently written via the patched
 * `navigator.clipboard.writeText`. Returns null if nothing has been
 * written yet (or `grantClipboardWrite` wasn't called).
 */
export async function readLastClipboard(page: Page): Promise<string | null> {
  return await page.evaluate(
    () => (globalThis as unknown as { __vg_last_clip: string | null }).__vg_last_clip,
  );
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
 * Wait until either the last `state` event recorded by `instrumentTtsCounter`
 * OR the renderer's own DOM-rendered state (data-testid="state-orb"
 * data-state="...") matches one of the given states.
 *
 * Why two sources? The state-log path depends on the auto-instrument
 * listener catching the IPC `state` event. On CI macos-latest the FSM
 * can transition (e.g. fake-wake LISTENING_WAKE→CAPTURING fires at
 * ~1.5 s post-spawn) BEFORE the auto-instrument listener attached:
 * preload exposes `vg.conversation` shortly after `domcontentloaded`,
 * but `webContents.send` is fire-and-forget — any state event sent
 * during the small (T_domcontentloaded, T_listener_attached) window is
 * lost to the auto-instrument array. The renderer's own
 * `useConversation` hook is mounted INSIDE the React tree and catches
 * those same events into React state, which is then rendered on the
 * StateOrb's `data-state` attribute. The DOM reflects the current
 * FSM state regardless of when our test-side listener attached.
 *
 * Returns the matching state. Throws if neither source surfaces a
 * match within the timeout — error message includes BOTH the recent
 * state log and the current DOM-rendered state for diagnostics.
 */
export async function waitForState(
  page: Page,
  desired: ReadonlyArray<string>,
  opts: { timeoutMs?: number } = {},
): Promise<string> {
  // Per-call timeout still wins (specs that need a tight bound — e.g.
  // "should NOT transition within 500 ms" — keep their explicit value).
  // Defaults bumped to 30 s on CI for headless-Chromium FSM latency.
  // (Round-12 issue #18.)
  const timeoutMs = opts.timeoutMs ?? ciTimeout(10_000, 30_000);
  const desiredSet = new Set(desired);
  const start = Date.now();
  let last: string = '';
  let domLast: string = '';
  while (Date.now() - start < timeoutMs) {
    const stats = await readVgStats(page);
    last = stats.stateLog.at(-1)?.state ?? '';
    if (desiredSet.has(last)) return last;
    // Fallback: read the renderer's DOM-rendered FSM state. Catches the
    // race where the auto-instrument missed an early transition.
    domLast = await readRendererState(page);
    if (desiredSet.has(domLast)) return domLast;
    await page.waitForTimeout(100);
  }
  const recent = (await readVgStats(page)).stateLog
    .slice(-10)
    .map((s) => s.state)
    .join(' → ');
  throw new Error(
    `waitForState timed out after ${timeoutMs} ms — wanted [${desired.join(', ')}], last=${last}, dom=${domLast}, recent=${recent}`,
  );
}

/**
 * Read the current FSM state from the renderer's StateOrb component
 * (`data-testid="state-orb"` → `data-state="..."`). Returns '' if the
 * orb isn't on the page yet (PairingWizard mode, mid-reload, etc.).
 *
 * This is the renderer's React state, which is the most reliable
 * signal of "what the FSM currently thinks it is" — the
 * `useConversation` hook subscribes during React mount, BEFORE any
 * post-domcontentloaded test code can attach listeners, so it
 * doesn't suffer the same attach-timing race that the auto-instrument
 * array does.
 */
export async function readRendererState(page: Page): Promise<string> {
  try {
    return await page.evaluate(() => {
      // tsconfig.node.json doesn't include the DOM lib — `document` only
      // exists at runtime inside the page context. Cast through
      // globalThis so the typechecker doesn't blow up while the runtime
      // behaviour is unchanged.
      const w = globalThis as unknown as {
        document: { querySelector: (sel: string) => { getAttribute: (k: string) => string | null } | null };
      };
      const el = w.document.querySelector('[data-testid="state-orb"]');
      return el?.getAttribute('data-state') ?? '';
    });
  } catch {
    // Page navigated mid-eval or context destroyed — caller will retry.
    return '';
  }
}

/**
 * Trigger a wake event on the **fake** wake runner. Only valid when the app
 * was launched with `VG_WAKE_E2E_FAKE=1` and `activation.mode === 'WAKE_WORD'`.
 * The fake runner emits its wake autonomously after ~1.5 s — this helper
 * just waits for the FSM to land in CAPTURING. Default bumped to 15 s
 * on CI for headless-Chromium boot latency (round-12 issue #18).
 */
export async function waitForWake(page: Page, timeoutMs?: number): Promise<void> {
  await waitForState(page, ['CAPTURING'], { timeoutMs: timeoutMs ?? ciTimeout(5_000, 15_000) });
}
