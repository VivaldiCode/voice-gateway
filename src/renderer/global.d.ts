import type { PairingInfo, Settings } from '../shared/types';

interface PairResult {
  ok: boolean;
  message: string;
  serverVersion?: string;
  sessionId?: string;
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
}

declare global {
  interface Window {
    vg: VgApi;
  }
}

export {};
