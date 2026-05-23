import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC } from '../shared/constants';
import type { ElevenLabsConfig, PairingInfo, Settings } from '../shared/types';

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
    openWindow: (): void => ipcRenderer.send(IPC.SETTINGS_OPEN_WINDOW),
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
    onWarning: (cb: (m: { code: string; message: string }) => void): (() => void) => on(IPC.CONV_WARNING, cb),
    onConnection: (cb: (m: { status: string; latencyMs: number | null; lastError: string | null }) => void): (() => void) =>
      on(IPC.CONNECTION_STATUS, cb),
    /** Pull the current snapshot — useful on mount so we don't have to wait
     *  up to 15 s for the next heartbeat-driven `onConnection` event. */
    getConnection: (): Promise<{ status: string; latencyMs: number | null; lastError: string | null }> =>
      ipcRenderer.invoke(IPC.CONNECTION_STATUS_GET),
    onHotkey: (cb: (phase: 'press' | 'release') => void): (() => void) => on(IPC.HOTKEY_TRIGGER, cb),
    pttPress: (): void => ipcRenderer.send(IPC.CONV_PTT_PRESS),
    pttRelease: (): void => ipcRenderer.send(IPC.CONV_PTT_RELEASE),
    sendAudioFrame: (frame: ArrayBuffer): void => ipcRenderer.send(IPC.CONV_AUDIO_FRAME, frame),
    cancel: (): void => ipcRenderer.send(IPC.CONV_CANCEL),
    bargeIn: (): void => ipcRenderer.send(IPC.CONV_BARGE_IN),
    reset: (): void => ipcRenderer.send(IPC.CONV_RESET),
  },

  audio: {
    getMicStatus: (): Promise<'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown'> =>
      ipcRenderer.invoke(IPC.AUDIO_MIC_STATUS),
    requestMic: (): Promise<boolean> => ipcRenderer.invoke(IPC.AUDIO_MIC_REQUEST),
    openMicSettings: (): Promise<boolean> => ipcRenderer.invoke(IPC.AUDIO_OPEN_MIC_SETTINGS),
  },

  wake: {
    /** Spin up an ephemeral wake-word runner for the "Testar" button. */
    testStart: (
      req: { mode: 'openww' | 'phrase'; model?: string; phrase?: string; language?: string },
    ): Promise<{ ok: boolean; message?: string }> =>
      ipcRenderer.invoke(IPC.WAKE_TEST_START, req),
    /** Stop the ephemeral runner (called on dialog close / mode toggle). */
    testStop: (): void => ipcRenderer.send(IPC.WAKE_TEST_STOP),
    onTestEvent: (
      cb: (
        e:
          | { event: 'ready'; models?: string[]; phrase?: string }
          | { event: 'wake'; model?: string; phrase?: string; score?: number; transcript?: string }
          | { event: 'transcript'; text: string }
          | { event: 'error'; message: string }
          | { event: 'exit' },
      ) => void,
    ): (() => void) => on(IPC.WAKE_TEST_EVENT, cb),
  },

  stt: {
    onStatus: (
      cb: (
        s:
          | { state: 'idle' }
          | { state: 'preparing'; progress?: { stage: string; fraction: number | null; detail?: string } }
          | { state: 'ready' }
          | { state: 'error'; message: string },
      ) => void,
    ): (() => void) => on(IPC.STT_STATUS, cb),
    prepare: (): Promise<{ ok: boolean; message?: string }> =>
      ipcRenderer.invoke(IPC.STT_PREPARE),
  },

  tts: {
    listVoices: (
      req: { provider: 'elevenlabs'; apiKey: string },
    ): Promise<{ ok: boolean; voices: Array<{ id: string; name: string; language?: string; description?: string; preview_url?: string }>; message?: string }> =>
      ipcRenderer.invoke(IPC.TTS_LIST_VOICES, req),
    test: (
      req: {
        provider: 'piper_local' | 'elevenlabs';
        text: string;
        elevenlabs?: ElevenLabsConfig;
        piperVoiceId?: string;
      },
    ): Promise<{ ok: boolean; message?: string }> => ipcRenderer.invoke(IPC.TTS_TEST, req),
    onTestChunk: (
      cb: (c: { seq: number; format: string; data: string; done?: boolean }) => void,
    ): (() => void) => on(IPC.AUDIO_TEST_TTS_CHUNK, cb),
    prepare: (): Promise<{ ok: boolean; message?: string }> =>
      ipcRenderer.invoke(IPC.TTS_PREPARE),
    onStatus: (
      cb: (
        s:
          | { state: 'idle' }
          | { state: 'preparing'; progress?: { stage: string; fraction: number | null; detail?: string } }
          | { state: 'ready' }
          | { state: 'error'; message: string },
      ) => void,
    ): (() => void) => on(IPC.TTS_STATUS, cb),
  },
} as const;

contextBridge.exposeInMainWorld('vg', api);

export type VgApi = typeof api;

declare global {
  interface Window {
    vg: VgApi;
  }
}
