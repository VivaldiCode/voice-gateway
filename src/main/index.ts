import { app, BrowserWindow } from 'electron';
import log from 'electron-log/main';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createSettingsStore } from './services/settings-store';
import { registerIpcHandlers } from './ipc-handlers';

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
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once('ready-to-show', () => win.show());
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

app.whenReady().then(() => {
  createMainWindow();

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
