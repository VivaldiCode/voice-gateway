import { Menu, Tray, app, nativeImage, type BrowserWindow } from 'electron';
import log from 'electron-log/main';

/**
 * Minimal system-tray icon with show / hide / quit menu items.
 * Falls back to a 16x16 transparent placeholder when no icon is bundled.
 */
export function createTray(getWindow: () => BrowserWindow | null): Tray {
  const icon = nativeImage.createEmpty();
  // Tray icons must not be the empty image on macOS in production; for our
  // dev scaffold the empty image is fine and the OS shows the label.
  const tray = new Tray(icon);
  tray.setToolTip('Voice Gateway');
  if (process.platform === 'darwin') tray.setTitle('VG');

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
            else w.show();
            refreshMenu();
          },
        },
        { type: 'separator' },
        {
          label: 'Sair',
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
