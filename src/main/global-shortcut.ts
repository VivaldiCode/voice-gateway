import { globalShortcut } from 'electron';
import log from 'electron-log/main';

/**
 * Register a single global hotkey. Returns an `unregister` function. Logs and
 * returns a no-op if the accelerator is invalid or already taken.
 */
export function registerHotkey(accelerator: string, onTrigger: () => void): () => void {
  try {
    const ok = globalShortcut.register(accelerator, onTrigger);
    if (!ok) {
      log.warn('[VG] global hotkey already in use:', accelerator);
      return () => undefined;
    }
    log.info('[VG] global hotkey registered:', accelerator);
    return () => globalShortcut.unregister(accelerator);
  } catch (err) {
    log.warn('[VG] global hotkey registration failed:', err);
    return () => undefined;
  }
}
