import type { PairingInfo, Settings } from '../shared/types';

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

interface VgApi {
  ping: () => Promise<'pong'>;
  settings: {
    get: () => Promise<Settings>;
    set: (patch: Partial<Settings>) => Promise<Settings>;
    reset: () => Promise<Settings>;
    onChange: (cb: (s: Settings) => void) => () => void;
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
    onConnection: (cb: (m: { status: string; latencyMs: number | null; lastError: string | null }) => void) => () => void;
    onHotkey: (cb: (phase: 'press' | 'release') => void) => () => void;
    pttPress: () => void;
    pttRelease: () => void;
    sendAudioFrame: (frame: ArrayBuffer) => void;
    cancel: () => void;
    bargeIn: () => void;
    reset: () => void;
  };
}

declare global {
  interface Window {
    vg: VgApi;
  }
}

export {};
