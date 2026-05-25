import Store from 'electron-store';
import log from 'electron-log/main';
import {
  DEFAULT_GLOBAL_HOTKEY_MAC,
  DEFAULT_GLOBAL_HOTKEY_OTHER,
  VAD_SILENCE_MS,
  VAD_THRESHOLD_DEFAULT,
} from '@shared/constants';
import type { Settings } from '@shared/types';

// v6: added ui.tutorialSeen (post-pair interactive tutorial flag, I5).
// v5: added transcript.recent (persisted conversation window). v4 added
// ui.autoLaunch + connection.{recentUrls,draftUrl}. v3 added
// audio.outputMuted. v2 added activation.wakeMode + activation.wakePhrase.
// Old configs are silently merged with the defaults on first boot.
const SCHEMA_VERSION = 6;

export function defaultSettings(): Settings {
  const isMac = process.platform === 'darwin';
  return {
    pairing: null,
    activation: {
      mode: 'PUSH_TO_TALK',
      wakeWord: 'hey_jarvis',
      wakeMode: 'openww',
      wakePhrase: 'hey hermes',
      globalHotkey: isMac ? DEFAULT_GLOBAL_HOTKEY_MAC : DEFAULT_GLOBAL_HOTKEY_OTHER,
      vadThreshold: VAD_THRESHOLD_DEFAULT,
      vadSilenceMs: VAD_SILENCE_MS,
      minAudioMs: 300,
    },
    stt: {
      provider: 'whisper_local',
      language: 'auto',
      whisperLocal: { model: 'base' },
      openai: { apiKey: '', model: 'whisper-1' },
    },
    tts: {
      provider: 'piper_local',
      piper: { modelId: 'en_US-lessac-medium' },
      elevenlabs: {
        apiKey: '',
        voiceId: '',
        modelId: 'eleven_turbo_v2_5',
      },
    },
    audio: { inputDeviceId: null, outputDeviceId: null, outputMuted: false },
    ui: { language: 'pt', theme: 'dark', startMinimized: false, autoLaunch: false, tutorialSeen: false },
    connection: { recentUrls: [], draftUrl: '' },
    transcript: { recent: [] },
    schemaVersion: SCHEMA_VERSION,
  };
}

/** Recursively merge a partial onto the defaults. Pure. */
function mergeSettings(base: Settings, patch: DeepPartial<Settings>): Settings {
  return deepMerge(base as unknown as Record<string, unknown>, patch as Record<string, unknown>) as unknown as Settings;
}

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object | null | undefined
    ? T[K] extends null | undefined
      ? T[K]
      : DeepPartial<NonNullable<T[K]>> | null
    : T[K];
};

function deepMerge<T extends Record<string, unknown>>(
  a: T,
  b: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const prev = out[k];
    if (
      v !== null &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      prev !== null &&
      typeof prev === 'object' &&
      !Array.isArray(prev)
    ) {
      out[k] = deepMerge(prev as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export interface SettingsStore {
  get(): Settings;
  set(patch: DeepPartial<Settings>): Settings;
  reset(): Settings;
  onChange(cb: (next: Settings) => void): () => void;
}

export interface CreateSettingsStoreOptions {
  /**
   * Override the directory `electron-store` writes to. Production passes
   * nothing and gets `app.getPath('userData')`; tests pass a `mkdtemp()`
   * directory so each case is isolated.
   */
  cwd?: string;
}

export function createSettingsStore(opts: CreateSettingsStoreOptions = {}): SettingsStore {
  const store = new Store<{ settings: Settings }>({
    name: 'voice-gateway-settings',
    defaults: { settings: defaultSettings() },
    clearInvalidConfig: true,
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
  });

  // Migration: if the saved schemaVersion is lower than current, merge with
  // defaults to pick up any new fields.
  const existing = store.get('settings');
  if (existing.schemaVersion !== SCHEMA_VERSION) {
    log.info('[VG] migrating settings', { from: existing.schemaVersion, to: SCHEMA_VERSION });
    const migrated = mergeSettings(defaultSettings(), existing as DeepPartial<Settings>);
    migrated.schemaVersion = SCHEMA_VERSION;
    store.set('settings', migrated);
  }

  const listeners = new Set<(next: Settings) => void>();

  const api: SettingsStore = {
    get() {
      return store.get('settings');
    },
    set(patch) {
      const next = mergeSettings(store.get('settings'), patch);
      store.set('settings', next);
      for (const l of listeners) l(next);
      return next;
    },
    reset() {
      const next = defaultSettings();
      store.set('settings', next);
      for (const l of listeners) l(next);
      return next;
    },
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };

  return api;
}

// Re-export pure helpers for tests.
export { mergeSettings as _mergeSettings, deepMerge as _deepMerge };
