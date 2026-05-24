import { Menu, Tray, app, nativeImage, type BrowserWindow } from 'electron';
import log from 'electron-log/main';
import { resolveResource } from './asset-paths';

export interface TrayCallbacks {
  /** Open or focus the dedicated Settings BrowserWindow. */
  openSettings: () => void;
}

/**
 * System tray icon with Show/Hide, Open Settings, Quit. Uses the 32×32 PNG
 * variant (macOS template-resized at the OS level) and falls back to an
 * empty image with a text label if the asset is missing.
 */
export function createTray(
  getWindow: () => BrowserWindow | null,
  callbacks: TrayCallbacks = { openSettings: () => undefined },
): Tray {
  const iconPath = resolveResource('icons', 'icon-32.png');
  let image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) {
    log.warn('[VG] tray icon not found at', iconPath, '— using placeholder');
    image = nativeImage.createEmpty();
  } else if (process.platform === 'darwin') {
    // Resize down for retina menubar (16pt height, 32px @2x).
    image = image.resize({ width: 18, height: 18 });
  }
  const tray = new Tray(image);
  tray.setToolTip('Voice Gateway');
  if (image.isEmpty() && process.platform === 'darwin') tray.setTitle('VG');

  const refreshMenu = (): void => {
    const win = getWindow();
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: win?.isVisible() ? 'Esconder janela' : 'Mostrar janela',
          click: () => {
            const w = getWindow();
            if (!w) return;
            if (w.isVisible()) w.hide();
            else {
              w.show();
              w.focus();
            }
            refreshMenu();
          },
        },
        {
          label: 'Definições…',
          accelerator: process.platform === 'darwin' ? 'Cmd+,' : undefined,
          click: () => {
            callbacks.openSettings();
          },
        },
        { type: 'separator' },
        {
          label: 'Sair',
          accelerator: process.platform === 'darwin' ? 'Cmd+Q' : undefined,
          click: () => {
            log.info('[VG] tray quit');
            app.quit();
          },
        },
      ]),
    );
  };

  tray.on('click', () => {
    const w = getWindow();
    if (!w) return;
    if (w.isVisible()) w.hide();
    else {
      w.show();
      w.focus();
    }
    refreshMenu();
  });

  refreshMenu();
  return tray;
}
