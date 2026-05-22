import { contextBridge, ipcRenderer } from 'electron';

const api = {
  ping: (): Promise<'pong'> => ipcRenderer.invoke('vg:ping'),
} as const;

contextBridge.exposeInMainWorld('vg', api);

export type VgApi = typeof api;

declare global {
  interface Window {
    vg: VgApi;
  }
}
