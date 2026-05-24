import { app, BrowserWindow, ipcMain, session, systemPreferences, type Tray, screen } from 'electron';
import log from 'electron-log/main';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { IPC } from '@shared/constants';
import { createSettingsStore } from './services/settings-store';
import { registerIpcHandlers } from './ipc-handlers';
import { promises as fs } from 'node:fs';
import { HermesClient } from './services/hermes-client';
import { createSttAdapter, WhisperLocalAdapter } from './services/stt-service';
import { createTtsAdapter } from './services/tts-service';
import { ConversationOrchestrator } from './services/conversation-orchestrator';
import { WakeWordService } from './services/wake-word-service';
import type { SttAdapter, ProgressEvent as SttProgress } from './services/stt-service';
import type { TtsAdapter, TtsProgressEvent } from './services/tts-service';
import { createTray } from './tray';
import { registerHotkey } from './global-shortcut';
import { resolveResource } from './asset-paths';
import { ensureUserShellPath } from './path-fix';

ensureUserShellPath();

// macOS TCC binds the microphone permission to the *process* that opens the
// audio device. With Chromium's default sandbox, audio capture runs in an
// out-of-process "Audio Service" helper whose bundle id is distinct from the
// main app (dev.voicegateway.app.helper). Users grant permission to the
// main app in System Settings → Privacy → Microphone, but the audio service
// helper is a different TCC subject and its check silently fails — surfacing
// as 'The user aborted a request' (AbortError) or an indefinite hang.
//
// Folding the audio service into the browser process makes the OS-level
// permission check run against the main app's bundle id, which the user has
// already granted. This trade-off (no audio-service sandbox) is acceptable
// for a desktop assistant where every audio path is already trusted code.
//
// MUST be set BEFORE app.whenReady so Chromium picks it up at startup.
app.commandLine.appendSwitch('disable-features', 'AudioServiceOutOfProcess,AudioServiceSandbox');

log.initialize();
log.transports.file.level = 'info';
log.transports.console.level = 'debug';
log.info('[VG] main process boot');

const settings = createSettingsStore();
let mainWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
const getMainWindow = (): BrowserWindow | null => mainWindow;

function loadRendererInto(win: BrowserWindow, view?: 'settings'): void {
  const query = view ? { view } : undefined;
  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    const base = new URL(process.env['ELECTRON_RENDERER_URL']);
    if (query) base.searchParams.set('view', query.view);
    void win.loadURL(base.toString());
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { query });
  }
}

function openSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const maxW = Math.min(720, display.workAreaSize.width - 80);
  const maxH = Math.min(820, display.workAreaSize.height - 80);
  const win = new BrowserWindow({
    width: maxW,
    height: maxH,
    minWidth: 540,
    minHeight: 560,
    backgroundColor: '#0b0d10',
    title: 'Definições — Voice Gateway',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    show: false,
    icon: resolveResource('icon.png'),
    parent: mainWindow ?? undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once('ready-to-show', () => {
    win.show();
    // Mirror current STT/TTS/connection status so the panel doesn't have to
    // re-fetch and the connection indicator doesn't sit on "Sem ligação"
    // for up to 15 s waiting for the next heartbeat.
    win.webContents.send(IPC.STT_STATUS, sttStatus);
    win.webContents.send(IPC.TTS_STATUS, ttsStatus);
    win.webContents.send(IPC.CONNECTION_STATUS, lastConnectionInfo);
  });
  win.on('closed', () => {
    if (settingsWindow === win) settingsWindow = null;
  });
  loadRendererInto(win, 'settings');
  settingsWindow = win;
}
const unregisterIpc = registerIpcHandlers(
  settings,
  getMainWindow,
  async () => {
    if (!activeTts) return { ok: false, message: 'TTS adapter not initialised yet.' };
    try {
      await prepareTts(activeTts);
      return { ok: ttsStatus.state === 'ready' };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : 'erro desconhecido' };
    }
  },
  async () => {
    if (!activeStt) return { ok: false, message: 'STT adapter not initialised yet.' };
    try {
      // Force a fresh discovery — the user may have just installed
      // whisper-cpp via Homebrew and wants the app to pick it up without
      // restarting.
      await prepareStt(activeStt);
      return { ok: sttStatus.state === 'ready' };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : 'erro desconhecido' };
    }
  },
);
app.on('will-quit', () => unregisterIpc());

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);


let tray: Tray | null = null;
let unregisterHotkey: () => void = () => undefined;

// Conversation pipeline (built lazily once pairing is present).
let client: HermesClient | null = null;
let orchestrator: ConversationOrchestrator | null = null;
let wake: WakeWordService | null = null;
// Currently we only need to hand the adapter to prepareStt(); rebuilds drop
// the reference. Keep the variable around so future actions (re-prepare on
// settings change, surface the adapter to a "test recognition" button, etc)
// don't need plumbing.
let activeStt: SttAdapter | null = null;
let activeTts: TtsAdapter | null = null;
type PrepareStatus<P> =
  | { state: 'idle' }
  | { state: 'preparing'; progress?: P }
  | { state: 'ready' }
  | { state: 'error'; message: string };
type SttStatus = PrepareStatus<SttProgress>;
type TtsStatus = PrepareStatus<TtsProgressEvent>;
let sttStatus: SttStatus = { state: 'idle' };
let ttsStatus: TtsStatus = { state: 'idle' };
// Last connection status we broadcast — replayed on every new BrowserWindow
// ready-to-show so a renderer that mounted AFTER the WS already connected
// doesn't miss the welcome event and stay "Sem ligação" until the next
// heartbeat (which is up to 15 s away).
let lastConnectionInfo: {
  status: string;
  latencyMs: number | null;
  lastError: string | null;
  reconnectAttempt: number;
} = {
  status: 'disconnected',
  latencyMs: null,
  lastError: null,
  reconnectAttempt: 0,
};

function send(channel: string, payload: unknown): void {
  // Broadcast to every open BrowserWindow so the separate Settings window
  // gets STT_STATUS / TTS_STATUS / conversation events in real time. With a
  // single-window broadcast the Settings panel would only see the snapshot
  // taken at ready-to-show and then silently drift out of sync.
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

function setSttStatus(next: SttStatus): void {
  sttStatus = next;
  send(IPC.STT_STATUS, next);
}

function setTtsStatus(next: TtsStatus): void {
  ttsStatus = next;
  send(IPC.TTS_STATUS, next);
}

async function prepareStt(stt: SttAdapter): Promise<void> {
  if (await stt.isReady()) {
    setSttStatus({ state: 'ready' });
    return;
  }
  setSttStatus({ state: 'preparing' });
  try {
    await stt.prepare((p) => {
      sttStatus = { state: 'preparing', progress: p };
      send(IPC.STT_STATUS, sttStatus);
      send(IPC.STT_PROGRESS, p);
    });
    setSttStatus({ state: 'ready' });
    log.info('[VG] stt ready');
  } catch (err) {
    const message = err instanceof Error ? err.message : 'erro desconhecido';
    log.warn('[VG] stt prepare failed:', message);
    setSttStatus({ state: 'error', message });
  }
}

async function prepareTts(tts: TtsAdapter): Promise<void> {
  if (!tts.prepare) {
    // ElevenLabs etc. have no preparation step.
    setTtsStatus((await tts.isReady()) ? { state: 'ready' } : { state: 'idle' });
    return;
  }
  if (await tts.isReady()) {
    setTtsStatus({ state: 'ready' });
    return;
  }
  setTtsStatus({ state: 'preparing' });
  try {
    await tts.prepare((p) => {
      ttsStatus = { state: 'preparing', progress: p };
      send(IPC.TTS_STATUS, ttsStatus);
      send(IPC.TTS_PROGRESS, p);
    });
    setTtsStatus({ state: 'ready' });
    log.info('[VG] tts ready');
  } catch (err) {
    const message = err instanceof Error ? err.message : 'erro desconhecido';
    log.warn('[VG] tts prepare failed:', message);
    setTtsStatus({ state: 'error', message });
  }
}

function bootstrapConversation(): void {
  const s = settings.get();
  if (!s.pairing) return;
  if (client) {
    client.disconnect();
    client = null;
  }
  client = new HermesClient();
  // autoInstall: true so a fresh macOS install can self-bootstrap whisper.cpp
  // and piper-tts via Homebrew on first use, without bouncing the user back
  // to a terminal.
  const fakeTranscript = process.env['VG_E2E_FAKE_TRANSCRIPT'];
  const stt = fakeTranscript
    ? // Test-only path: skip real STT, always return the env var as the
      // transcript. Lets the conversation-flows E2Es exercise the orchestrator
      // without depending on whisper-cli being installed.
      ({
        id: 'e2e_fake_stt',
        async isReady() {
          return true;
        },
        async prepare() {
          return;
        },
        async transcribe() {
          return { text: fakeTranscript, durationMs: 1 };
        },
      } satisfies SttAdapter)
    : createSttAdapter(s.stt, { autoInstall: true });
  activeStt = stt;
  const tts = createTtsAdapter(s.tts, { autoInstall: true });
  activeTts = tts;
  orchestrator = new ConversationOrchestrator(client, stt, tts, s);
  void prepareStt(stt);
  void prepareTts(tts);

  client.on('status', (status, info) => {
    lastConnectionInfo = { status, ...info };
    send(IPC.CONNECTION_STATUS, lastConnectionInfo);
  });

  orchestrator.on('state', (ctx) => send(IPC.CONV_STATE, ctx));
  orchestrator.on('transcript_final', (text, turnId) =>
    send(IPC.CONV_TRANSCRIPT, { text, turnId, role: 'user' }),
  );
  orchestrator.on('response_text', (text, final, turnId) =>
    send(IPC.CONV_RESPONSE_TEXT, { text, final, turnId }),
  );
  orchestrator.on('tts_chunk', (chunk, turnId) => {
    // Buffers travel over IPC as Uint8Array.
    send(IPC.CONV_TTS_CHUNK, {
      seq: chunk.seq,
      format: chunk.format,
      turnId,
      data: chunk.data.toString('base64'),
    });
  });
  orchestrator.on('error', (code, message) => send(IPC.CONV_ERROR, { code, message }));
  orchestrator.on('warning', (code, message) => send(IPC.CONV_WARNING, { code, message }));

  client.connect(s.pairing);
}

function rebuildHotkey(): void {
  unregisterHotkey();
  const hotkey = settings.get().activation.globalHotkey;
  unregisterHotkey = registerHotkey(hotkey, () => {
    if (!orchestrator) return;
    // Toggle press/release so a single keypress maps to one full turn.
    const st = orchestrator.getState().state;
    if (st === 'IDLE' || st === 'LISTENING_WAKE' || st === 'SPEAKING') {
      orchestrator.pttPress();
      send(IPC.HOTKEY_TRIGGER, 'press');
    } else if (st === 'CAPTURING') {
      orchestrator.pttRelease();
      send(IPC.HOTKEY_TRIGGER, 'release');
    }
  });
}

/**
 * Resolve the (binary, model) pair the phrase-mode wake runner needs. Returns
 * a string error when something is missing so callers can surface it as a
 * friendly UI hint. Tries whatever local whisper adapter we already built; if
 * STT is on OpenAI we still construct a transient `WhisperLocalAdapter` so the
 * user can use phrase wake mode independently of their STT choice.
 */
async function resolveWhisperPathsForWake(): Promise<
  { ok: true; binary: string; model: string } | { ok: false; reason: string }
> {
  const adapter =
    activeStt instanceof WhisperLocalAdapter
      ? activeStt
      : new WhisperLocalAdapter({
          config: { model: 'base' },
          autoInstall: true,
        });
  const binary = await adapter.resolveBinaryPath();
  if (!binary) {
    return {
      ok: false,
      reason:
        'Para usar uma frase personalizada, instala primeiro o whisper.cpp ' +
        '(macOS: `brew install whisper-cpp`).',
    };
  }
  const model = adapter.resolveModelPath();
  try {
    await fs.access(model);
  } catch {
    return {
      ok: false,
      reason:
        'O modelo do whisper ainda não está descarregado. Abre Definições → Reconhecimento e ' +
        'carrega "Descarregar modelo" antes de usar a frase personalizada.',
    };
  }
  return { ok: true, binary, model };
}

async function rebuildWakeWord(): Promise<void> {
  wake?.stop();
  wake = null;
  const s = settings.get();
  if (s.activation.mode !== 'WAKE_WORD') return;
  if (!orchestrator) return;
  wake = makeWakeService();
  const curr = wake;
  curr.on('wake', (info) => {
    log.info('[VG] wake detected:', info);
    orchestrator?.wakeDetected();
  });
  curr.on('error', (msg) => {
    log.warn('[VG] wake-word error:', msg);
    send(IPC.WAKE_STATUS, { running: false, error: msg });
  });
  curr.on('ready', (info) => send(IPC.WAKE_STATUS, { running: true, ...info }));

  if (s.activation.wakeMode === 'phrase') {
    const paths = await resolveWhisperPathsForWake();
    if (!paths.ok) {
      send(IPC.WAKE_STATUS, { running: false, error: paths.reason });
      return;
    }
    await curr.start({
      mode: 'phrase',
      phrase: s.activation.wakePhrase,
      whisperBin: paths.binary,
      whisperModel: paths.model,
      language: s.stt.language === 'auto' ? 'auto' : s.stt.language,
    });
  } else {
    await curr.start({
      mode: 'openww',
      model: s.activation.wakeWord,
      threshold: 0.5,
    });
  }
}

// ───────── Test-button runner ─────────
// A second WakeWordService instance dedicated to the Settings → Ativação
// "Testar" button. Kept separate from the production `wake` so toggling test
// mode never interrupts a live wake-word session.

let testWake: WakeWordService | null = null;

function stopTestWake(): void {
  testWake?.stop();
  testWake = null;
}

/**
 * Build a WakeWordService for production OR — when `VG_WAKE_E2E_FAKE=1` is set
 * in the environment — for the Playwright wake-word E2E. The E2E variant points
 * the service at `fake_wake_runner.py` which emits deterministic JSON-line
 * events without touching the mic or whisper. Kept in main so production code
 * paths don't gain test-only branches.
 */
function makeWakeService(): WakeWordService {
  if (process.env['VG_WAKE_E2E_FAKE'] === '1') {
    const scriptPath = app.isPackaged
      ? join(process.resourcesPath, 'python', 'fake_wake_runner.py')
      : join(process.cwd(), 'resources', 'python', 'fake_wake_runner.py');
    log.info('[VG] wake-word E2E fake runner active at', scriptPath);
    return new WakeWordService({ scriptPath, autoInstall: false });
  }
  return new WakeWordService();
}

async function startTestWake(req: {
  mode: 'openww' | 'phrase';
  model?: string;
  phrase?: string;
  language?: string;
}): Promise<{ ok: boolean; message?: string }> {
  stopTestWake();
  const svc = makeWakeService();
  testWake = svc;
  svc.on('ready', (info) =>
    send(IPC.WAKE_TEST_EVENT, { event: 'ready', ...info }),
  );
  svc.on('wake', (info) => send(IPC.WAKE_TEST_EVENT, { event: 'wake', ...info }));
  svc.on('transcript', (text) =>
    send(IPC.WAKE_TEST_EVENT, { event: 'transcript', text }),
  );
  svc.on('error', (message) =>
    send(IPC.WAKE_TEST_EVENT, { event: 'error', message }),
  );
  svc.on('exit', () => {
    if (testWake === svc) testWake = null;
    send(IPC.WAKE_TEST_EVENT, { event: 'exit' });
  });

  if (req.mode === 'phrase') {
    if (!req.phrase || !req.phrase.trim()) {
      stopTestWake();
      return { ok: false, message: 'Escreve uma frase primeiro.' };
    }
    const paths = await resolveWhisperPathsForWake();
    if (!paths.ok) {
      stopTestWake();
      return { ok: false, message: paths.reason };
    }
    await svc.start({
      mode: 'phrase',
      phrase: req.phrase,
      whisperBin: paths.binary,
      whisperModel: paths.model,
      language: req.language ?? 'auto',
    });
    return { ok: true };
  }
  if (!req.model) {
    stopTestWake();
    return { ok: false, message: 'Escolhe uma palavra-chave primeiro.' };
  }
  await svc.start({
    mode: 'openww',
    // The runner accepts any string here; the TS type is narrower than what's
    // actually valid (community models exist). We cast for the test path only.
    model: req.model as never,
    threshold: 0.5,
  });
  return { ok: true };
}

function createMainWindow(): BrowserWindow {
  mainWindow?.close();
  const win = new BrowserWindow({
    width: 480,
    height: 720,
    minWidth: 380,
    minHeight: 560,
    backgroundColor: '#0b0d10',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    show: false,
    icon: resolveResource('icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once('ready-to-show', () => {
    win.show();
    // Resend the current STT + TTS + connection status to the freshly-loaded
    // renderer so it never starts with a stale "preparing…" or "Sem ligação"
    // UI when the WS was already connected before this window mounted.
    send(IPC.STT_STATUS, sttStatus);
    send(IPC.TTS_STATUS, ttsStatus);
    send(IPC.CONNECTION_STATUS, lastConnectionInfo);
  });
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  // When the user returns to the app (laptop wake, Cmd+Tab back, etc.) and
  // the WS happens to be disconnected, retry NOW instead of waiting for the
  // current exponential-backoff slot — which could be up to 30 s away after
  // a long offline period.
  win.on('focus', () => {
    if (client && !client.isConnected()) {
      log.info('[VG] main window focused while disconnected — forcing reconnect');
      client.reconnectNow();
    }
  });

  loadRendererInto(win);

  mainWindow = win;
  return win;
}

ipcMain.on(IPC.SETTINGS_OPEN_WINDOW, () => openSettingsWindow());

// IPC: renderer-side audio frames + commands ──────────────────────────────
ipcMain.on(IPC.CONV_PTT_PRESS, () => orchestrator?.pttPress());
ipcMain.on(IPC.CONV_PTT_RELEASE, () => orchestrator?.pttRelease());
ipcMain.on(IPC.CONV_AUDIO_FRAME, (_e, frame: ArrayBuffer | Uint8Array) =>
  orchestrator?.pushAudio(frame instanceof ArrayBuffer ? Buffer.from(frame) : Buffer.from(frame)),
);
ipcMain.on(IPC.CONV_CANCEL, () => orchestrator?.cancel());
ipcMain.on(IPC.CONV_BARGE_IN, () => orchestrator?.bargeIn());
ipcMain.on(IPC.CONV_RESET, () => orchestrator?.reset());

ipcMain.handle(IPC.CONNECTION_STATUS_GET, async () => lastConnectionInfo);

ipcMain.handle(
  IPC.WAKE_TEST_START,
  async (
    _e,
    req: { mode: 'openww' | 'phrase'; model?: string; phrase?: string; language?: string },
  ) => startTestWake(req),
);
ipcMain.on(IPC.WAKE_TEST_STOP, () => stopTestWake());

let lastSettingsSnapshot = JSON.stringify(settings.get());
settings.onChange((next) => {
  // Rebuild the pipeline when pairing OR STT/TTS provider configuration
  // changes — otherwise the user can switch from Piper to ElevenLabs in
  // settings and the conversation keeps using the stale Piper adapter.
  const snap = JSON.stringify({ stt: next.stt, tts: next.tts, pairing: next.pairing });
  if (next.pairing && snap !== lastSettingsSnapshot) {
    bootstrapConversation();
  }
  lastSettingsSnapshot = snap;
  rebuildHotkey();
  void rebuildWakeWord();
});

/**
 * Wire microphone permissions exactly once at app boot.
 *
 * - macOS hardened-runtime apps cannot access the mic at all without
 *   NSMicrophoneUsageDescription + the audio-input entitlement (both
 *   declared in electron-builder.yml / build/entitlements.mac.plist).
 * - Electron's renderer additionally has to be granted the 'media'
 *   permission via the session; without this, getUserMedia rejects with
 *   AbortError even when System Preferences shows the app as allowed.
 */
function wireMediaPermissions(): void {
  const GRANTED = new Set(['media', 'audioCapture', 'microphone']);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(GRANTED.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) =>
    GRANTED.has(permission),
  );

  // On macOS we can also pre-ask the OS so the system-level prompt shows up
  // *now* rather than when the user clicks the call button. Best-effort —
  // ignore the returned boolean.
  if (process.platform === 'darwin') {
    try {
      void systemPreferences.askForMediaAccess('microphone');
    } catch (err) {
      log.warn('[VG] askForMediaAccess failed', err);
    }
  }
}

app.whenReady().then(() => {
  wireMediaPermissions();
  createMainWindow();
  tray = createTray(getMainWindow, { openSettings: openSettingsWindow });
  void tray; // kept around so we can extend later (icon tint on wake / error)
  bootstrapConversation();
  rebuildHotkey();
  void rebuildWakeWord();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  unregisterHotkey();
  wake?.stop();
  client?.disconnect();
});
