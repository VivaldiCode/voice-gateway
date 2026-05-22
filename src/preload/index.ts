import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC } from '../shared/constants';
import type { PairingInfo, Settings } from '../shared/types';

type SettingsPatch = Partial<Settings>;

interface PairResult {
  ok: boolean;
  message: string;
  serverVersion?: string;
  sessionId?: string;
}

const api = {
  ping: (): Promise<'pong'> => ipcRenderer.invoke(IPC.PING),

  settings: {
    get: (): Promise<Settings> => ipcRenderer.invoke(IPC.SETTINGS_GET),
    set: (patch: SettingsPatch): Promise<Settings> => ipcRenderer.invoke(IPC.SETTINGS_SET, patch),
    reset: (): Promise<Settings> => ipcRenderer.invoke(IPC.SETTINGS_RESET),
    onChange: (cb: (s: Settings) => void): (() => void) => {
      const handler = (_e: IpcRendererEvent, s: Settings): void => cb(s);
      ipcRenderer.on(IPC.SETTINGS_CHANGED, handler);
      return () => ipcRenderer.removeListener(IPC.SETTINGS_CHANGED, handler);
    },
  },

  pair: {
    test: (info: PairingInfo): Promise<PairResult> => ipcRenderer.invoke(IPC.PAIR_TEST, info),
    save: (info: PairingInfo): Promise<PairResult> => ipcRenderer.invoke(IPC.PAIR_SAVE, info),
  },
} as const;

contextBridge.exposeInMainWorld('vg', api);

export type VgApi = typeof api;

declare global {
  interface Window {
    vg: VgApi;
  }
}
