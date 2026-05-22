import { create } from 'zustand';
import type { ConnectionInfo, Settings } from '../../shared/types';

interface AppState {
  settings: Settings | null;
  connection: ConnectionInfo;
  setSettings: (s: Settings) => void;
  setConnection: (c: Partial<ConnectionInfo>) => void;
}

const initialConnection: ConnectionInfo = {
  status: 'disconnected',
  url: null,
  latencyMs: null,
  sessionId: null,
  lastError: null,
};

export const useAppStore = create<AppState>((set) => ({
  settings: null,
  connection: initialConnection,
  setSettings: (settings) => set({ settings }),
  setConnection: (patch) =>
    set((state) => ({ connection: { ...state.connection, ...patch } })),
}));
