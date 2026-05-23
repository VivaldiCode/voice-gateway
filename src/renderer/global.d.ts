import type { ElevenLabsConfig, PairingInfo, Settings } from '../shared/types';

export interface VoiceInfo {
  id: string;
  name: string;
  language?: string;
  description?: string;
  preview_url?: string;
}

interface PairResult {
  ok: boolean;
  message: string;
  serverVersion?: string;
  sessionId?: string;
}

interface ConversationStateMsg {
  state: 'IDLE' | 'LISTENING_WAKE' | 'CAPTURING' | 'STREAMING' | 'THINKING' | 'SPEAKING' | 'ERROR';
  mode: 'PUSH_TO_TALK' | 'WAKE_WORD';
  turnId: string | null;
  transcript: string | null;
  lastError: { code: string; message: string } | null;
}

export type SttProgress = {
  stage: 'downloading' | 'extracting' | 'verifying' | 'installing' | 'ready';
  fraction: number | null;
  detail?: string;
};

export type SttStatus =
  | { state: 'idle' }
  | { state: 'preparing'; progress?: SttProgress }
  | { state: 'ready' }
  | { state: 'error'; message: string };

export type TtsProgress = SttProgress;
export type TtsStatus =
  | { state: 'idle' }
  | { state: 'preparing'; progress?: TtsProgress }
  | { state: 'ready' }
  | { state: 'error'; message: string };

interface VgApi {
  ping: () => Promise<'pong'>;
  settings: {
    get: () => Promise<Settings>;
    set: (patch: Partial<Settings>) => Promise<Settings>;
    reset: () => Promise<Settings>;
    onChange: (cb: (s: Settings) => void) => () => void;
    openWindow: () => void;
  };
  pair: {
    test: (info: PairingInfo) => Promise<PairResult>;
    save: (info: PairingInfo) => Promise<PairResult>;
  };
  conversation: {
    onState: (cb: (state: ConversationStateMsg) => void) => () => void;
    onTranscript: (cb: (m: { text: string; turnId: string; role: 'user' | 'assistant' }) => void) => () => void;
    onResponseText: (cb: (m: { text: string; final: boolean; turnId: string }) => void) => () => void;
    onTtsChunk: (cb: (m: { seq: number; format: string; turnId: string; data: string }) => void) => () => void;
    onError: (cb: (m: { code: string; message: string }) => void) => () => void;
    onWarning: (cb: (m: { code: string; message: string }) => void) => () => void;
    onConnection: (cb: (m: { status: string; latencyMs: number | null; lastError: string | null }) => void) => () => void;
    getConnection: () => Promise<{ status: string; latencyMs: number | null; lastError: string | null }>;
    onHotkey: (cb: (phase: 'press' | 'release') => void) => () => void;
    pttPress: () => void;
    pttRelease: () => void;
    sendAudioFrame: (frame: ArrayBuffer) => void;
    cancel: () => void;
    bargeIn: () => void;
    reset: () => void;
  };
  audio: {
    getMicStatus: () => Promise<'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown'>;
    requestMic: () => Promise<boolean>;
    openMicSettings: () => Promise<boolean>;
  };
  stt: {
    onStatus: (cb: (s: SttStatus) => void) => () => void;
    prepare: () => Promise<{ ok: boolean; message?: string }>;
  };
  tts: {
    listVoices: (req: {
      provider: 'elevenlabs';
      apiKey: string;
    }) => Promise<{ ok: boolean; voices: VoiceInfo[]; message?: string }>;
    test: (req: {
      provider: 'piper_local' | 'elevenlabs';
      text: string;
      elevenlabs?: ElevenLabsConfig;
      piperVoiceId?: string;
    }) => Promise<{ ok: boolean; message?: string }>;
    onTestChunk: (
      cb: (c: { seq: number; format: string; data: string; done?: boolean }) => void,
    ) => () => void;
    prepare: () => Promise<{ ok: boolean; message?: string }>;
    onStatus: (cb: (s: TtsStatus) => void) => () => void;
  };
  wake: {
    testStart: (req: {
      mode: 'openww' | 'phrase';
      model?: string;
      phrase?: string;
      language?: string;
    }) => Promise<{ ok: boolean; message?: string }>;
    testStop: () => void;
    onTestEvent: (
      cb: (
        e:
          | { event: 'ready'; models?: string[]; phrase?: string }
          | { event: 'wake'; model?: string; phrase?: string; score?: number; transcript?: string }
          | { event: 'transcript'; text: string }
          | { event: 'error'; message: string }
          | { event: 'exit' },
      ) => void,
    ) => () => void;
  };
}

declare global {
  interface Window {
    vg: VgApi;
  }
}

export {};
