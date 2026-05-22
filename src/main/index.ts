import { app, BrowserWindow, ipcMain, type Tray } from 'electron';
import log from 'electron-log/main';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { IPC } from '@shared/constants';
import { createSettingsStore } from './services/settings-store';
import { registerIpcHandlers } from './ipc-handlers';
import { HermesClient } from './services/hermes-client';
import { createSttAdapter } from './services/stt-service';
import { createTtsAdapter } from './services/tts-service';
import { ConversationOrchestrator } from './services/conversation-orchestrator';
import { WakeWordService } from './services/wake-word-service';
import type { SttAdapter, ProgressEvent as SttProgress } from './services/stt-service';
import { createTray } from './tray';
import { registerHotkey } from './global-shortcut';
import { resolveResource } from './asset-paths';

log.initialize();
log.transports.file.level = 'info';
log.transports.console.level = 'debug';
log.info('[VG] main process boot');

const settings = createSettingsStore();
let mainWindow: BrowserWindow | null = null;
const getMainWindow = (): BrowserWindow | null => mainWindow;
const unregisterIpc = registerIpcHandlers(settings, getMainWindow);
app.on('will-quit', () => unregisterIpc());

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const isDev = !app.isPackaged;

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
let _activeStt: SttAdapter | null = null;
type SttStatus =
  | { state: 'idle' }
  | { state: 'preparing'; progress?: SttProgress }
  | { state: 'ready' }
  | { state: 'error'; message: string };
let sttStatus: SttStatus = { state: 'idle' };

function send(channel: string, payload: unknown): void {
  mainWindow?.webContents.send(channel, payload);
}

function setSttStatus(next: SttStatus): void {
  sttStatus = next;
  send(IPC.STT_STATUS, next);
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

function bootstrapConversation(): void {
  const s = settings.get();
  if (!s.pairing) return;
  if (client) {
    client.disconnect();
    client = null;
  }
  client = new HermesClient();
  // autoInstall: true so a fresh macOS install can self-bootstrap whisper.cpp
  // via Homebrew on first use, without bouncing the user back to a terminal.
  const stt = createSttAdapter(s.stt, { autoInstall: true });
  _activeStt = stt;
  const tts = createTtsAdapter(s.tts);
  orchestrator = new ConversationOrchestrator(client, stt, tts, s);
  void prepareStt(stt);

  client.on('status', (status, info) => {
    send(IPC.CONNECTION_STATUS, { status, ...info });
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

function rebuildWakeWord(): void {
  wake?.stop();
  wake = null;
  const s = settings.get();
  if (s.activation.mode !== 'WAKE_WORD') return;
  if (!orchestrator) return;
  wake = new WakeWordService();
  wake.on('wake', (model) => {
    log.info('[VG] wake detected:', model);
    orchestrator?.wakeDetected();
  });
  wake.on('error', (msg) => {
    log.warn('[VG] wake-word error:', msg);
    send(IPC.WAKE_STATUS, { running: false, error: msg });
  });
  wake.on('ready', (models) => send(IPC.WAKE_STATUS, { running: true, models }));
  try {
    wake.start(s.activation.wakeWord, 0.5);
  } catch (err) {
    log.warn('[VG] wake-word failed to start:', err);
    send(IPC.WAKE_STATUS, {
      running: false,
      error: 'Não consegui iniciar o detector. Verifica se tens o python3 e openwakeword instalados.',
    });
  }
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
    // Resend the current STT status to the freshly-loaded renderer so it
    // never starts with a stale "preparing…" UI on second window opens.
    send(IPC.STT_STATUS, sttStatus);
  });
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  mainWindow = win;
  return win;
}

// IPC: renderer-side audio frames + commands ──────────────────────────────
ipcMain.on(IPC.CONV_PTT_PRESS, () => orchestrator?.pttPress());
ipcMain.on(IPC.CONV_PTT_RELEASE, () => orchestrator?.pttRelease());
ipcMain.on(IPC.CONV_AUDIO_FRAME, (_e, frame: ArrayBuffer | Uint8Array) =>
  orchestrator?.pushAudio(frame instanceof ArrayBuffer ? Buffer.from(frame) : Buffer.from(frame)),
);
ipcMain.on(IPC.CONV_CANCEL, () => orchestrator?.cancel());
ipcMain.on(IPC.CONV_BARGE_IN, () => orchestrator?.bargeIn());
ipcMain.on(IPC.CONV_RESET, () => orchestrator?.reset());

settings.onChange((next) => {
  // Rebuild the pipeline when pairing changes.
  if (next.pairing) bootstrapConversation();
  rebuildHotkey();
  rebuildWakeWord();
});

app.whenReady().then(() => {
  createMainWindow();
  tray = createTray(getMainWindow);
  void tray; // suppress unused warning until extended
  bootstrapConversation();
  rebuildHotkey();
  rebuildWakeWord();

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
