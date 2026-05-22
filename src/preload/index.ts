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

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: IpcRendererEvent, payload: T): void => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api = {
  ping: (): Promise<'pong'> => ipcRenderer.invoke(IPC.PING),

  settings: {
    get: (): Promise<Settings> => ipcRenderer.invoke(IPC.SETTINGS_GET),
    set: (patch: SettingsPatch): Promise<Settings> => ipcRenderer.invoke(IPC.SETTINGS_SET, patch),
    reset: (): Promise<Settings> => ipcRenderer.invoke(IPC.SETTINGS_RESET),
    onChange: (cb: (s: Settings) => void): (() => void) => on(IPC.SETTINGS_CHANGED, cb),
  },

  pair: {
    test: (info: PairingInfo): Promise<PairResult> => ipcRenderer.invoke(IPC.PAIR_TEST, info),
    save: (info: PairingInfo): Promise<PairResult> => ipcRenderer.invoke(IPC.PAIR_SAVE, info),
  },

  conversation: {
    onState: (cb: (state: unknown) => void): (() => void) => on(IPC.CONV_STATE, cb),
    onTranscript: (cb: (m: { text: string; turnId: string; role: 'user' | 'assistant' }) => void): (() => void) =>
      on(IPC.CONV_TRANSCRIPT, cb),
    onResponseText: (cb: (m: { text: string; final: boolean; turnId: string }) => void): (() => void) =>
      on(IPC.CONV_RESPONSE_TEXT, cb),
    onTtsChunk: (cb: (m: { seq: number; format: string; turnId: string; data: string }) => void): (() => void) =>
      on(IPC.CONV_TTS_CHUNK, cb),
    onError: (cb: (m: { code: string; message: string }) => void): (() => void) => on(IPC.CONV_ERROR, cb),
    onConnection: (cb: (m: { status: string; latencyMs: number | null; lastError: string | null }) => void): (() => void) =>
      on(IPC.CONNECTION_STATUS, cb),
    onHotkey: (cb: (phase: 'press' | 'release') => void): (() => void) => on(IPC.HOTKEY_TRIGGER, cb),
    pttPress: (): void => ipcRenderer.send(IPC.CONV_PTT_PRESS),
    pttRelease: (): void => ipcRenderer.send(IPC.CONV_PTT_RELEASE),
    sendAudioFrame: (frame: ArrayBuffer): void => ipcRenderer.send(IPC.CONV_AUDIO_FRAME, frame),
    cancel: (): void => ipcRenderer.send(IPC.CONV_CANCEL),
    bargeIn: (): void => ipcRenderer.send(IPC.CONV_BARGE_IN),
    reset: (): void => ipcRenderer.send(IPC.CONV_RESET),
  },
} as const;

contextBridge.exposeInMainWorld('vg', api);

export type VgApi = typeof api;

declare global {
  interface Window {
    vg: VgApi;
  }
}
