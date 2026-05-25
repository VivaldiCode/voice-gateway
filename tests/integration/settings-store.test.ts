import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _deepMerge,
  _mergeSettings,
  createSettingsStore,
  defaultSettings,
} from '@main/services/settings-store';

describe('settings-store — merge helpers', () => {
  it('defaultSettings has no pairing initially', () => {
    expect(defaultSettings().pairing).toBeNull();
  });

  it('deepMerge merges nested objects without losing siblings', () => {
    const merged = _deepMerge(
      { a: { x: 1, y: 2 }, b: 5 },
      { a: { y: 99 } },
    );
    expect(merged).toEqual({ a: { x: 1, y: 99 }, b: 5 });
  });

  it('mergeSettings patches the pairing field without touching others', () => {
    const base = defaultSettings();
    const next = _mergeSettings(base, {
      pairing: { url: 'ws://x', token: 'tok' },
    });
    expect(next.pairing).toEqual({ url: 'ws://x', token: 'tok' });
    expect(next.activation.mode).toBe(base.activation.mode);
    expect(next.tts.piper.modelId).toBe(base.tts.piper.modelId);
  });

  it('mergeSettings patches a deeply nested field', () => {
    const base = defaultSettings();
    const next = _mergeSettings(base, {
      activation: { mode: 'WAKE_WORD' } as never,
    });
    expect(next.activation.mode).toBe('WAKE_WORD');
    expect(next.activation.wakeWord).toBe(base.activation.wakeWord);
  });

  it('arrays in patches replace, do not concat', () => {
    const merged = _deepMerge(
      { caps: ['a', 'b'] as unknown[] },
      { caps: ['c'] },
    );
    expect(merged).toEqual({ caps: ['c'] });
  });

  it('null in patch overrides existing object', () => {
    const merged = _deepMerge({ pairing: { url: 'x', token: 'y' } }, { pairing: null });
    expect(merged).toEqual({ pairing: null });
  });
});

describe('settings-store — schema migration', () => {
  /** Path on disk where electron-store writes for a given cwd. */
  const storeFile = (cwd: string): string =>
    join(cwd, 'voice-gateway-settings.json');

  it('seeds defaults on a fresh disk (no existing file)', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'vg-settings-fresh-'));
    const store = createSettingsStore({ cwd });
    const s = store.get();
    expect(s.pairing).toBeNull();
    expect(s.activation.wakeMode).toBe('openww');
    expect(s.activation.wakePhrase).toBe('hey hermes');
    expect(s.audio.outputMuted).toBe(false);
    expect(s.ui.autoLaunch).toBe(false);
    expect(s.connection.recentUrls).toEqual([]);
    expect(s.connection.draftUrl).toBe('');
    expect(s.transcript.recent).toEqual([]);
    expect(s.schemaVersion).toBe(5);
  });

  it('migrates a v1 file (no wakeMode/wakePhrase) into the current shape', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'vg-settings-v1-'));
    // v1: an older app version that didn't know about wakeMode + wakePhrase.
    const v1 = {
      settings: {
        pairing: { url: 'ws://10.0.0.5:8765/ws', token: 'tok-from-v1' },
        activation: {
          mode: 'WAKE_WORD',
          wakeWord: 'computer',
          globalHotkey: 'CommandOrControl+Shift+H',
          vadThreshold: 0.5,
          vadSilenceMs: 800,
          minAudioMs: 400,
        },
        stt: {
          provider: 'whisper_local',
          language: 'pt',
          whisperLocal: { model: 'base' },
          openai: { apiKey: '', model: 'whisper-1' },
        },
        tts: {
          provider: 'piper_local',
          piper: { modelId: 'en_US-lessac-medium' },
          elevenlabs: { apiKey: '', voiceId: '', modelId: 'eleven_turbo_v2_5' },
        },
        audio: { inputDeviceId: null, outputDeviceId: null },
        ui: { language: 'pt', theme: 'dark', startMinimized: false },
        schemaVersion: 1,
      },
    };
    writeFileSync(storeFile(cwd), JSON.stringify(v1));

    const store = createSettingsStore({ cwd });
    const s = store.get();

    // Migration kept everything the user had configured.
    expect(s.pairing).toEqual({ url: 'ws://10.0.0.5:8765/ws', token: 'tok-from-v1' });
    expect(s.activation.mode).toBe('WAKE_WORD');
    expect(s.activation.wakeWord).toBe('computer');
    expect(s.activation.minAudioMs).toBe(400);
    expect(s.stt.language).toBe('pt');

    // …and filled in the newer-schema fields with defaults.
    expect(s.activation.wakeMode).toBe('openww');
    expect(s.activation.wakePhrase).toBe('hey hermes');
    expect(s.audio.outputMuted).toBe(false);
    expect(s.ui.autoLaunch).toBe(false);
    expect(s.connection).toEqual({ recentUrls: [], draftUrl: '' });
    expect(s.transcript).toEqual({ recent: [] });
    expect(s.schemaVersion).toBe(5);

    // The migration is persisted back to disk so the next boot is fast.
    const onDisk = JSON.parse(readFileSync(storeFile(cwd), 'utf-8'));
    expect(onDisk.settings.schemaVersion).toBe(5);
    expect(onDisk.settings.activation.wakeMode).toBe('openww');
  });

  it('migrates a v2 file (no audio.outputMuted) into the current shape', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'vg-settings-v2-'));
    const v2 = {
      settings: {
        ...defaultSettings(),
        // strip the v3+ fields so the on-disk shape matches what v2 wrote
        audio: { inputDeviceId: 'mic-x', outputDeviceId: null } as unknown,
        schemaVersion: 2,
      },
    };
    writeFileSync(storeFile(cwd), JSON.stringify(v2));

    const store = createSettingsStore({ cwd });
    const s = store.get();
    expect(s.audio.inputDeviceId).toBe('mic-x');
    expect(s.audio.outputMuted).toBe(false);
    expect(s.schemaVersion).toBe(5);
  });

  it('migrates a v3 file (no ui.autoLaunch / no connection) into v5 with the new defaults', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'vg-settings-v3-'));
    const v3 = {
      settings: {
        ...defaultSettings(),
        // strip the v4+ surfaces so the on-disk shape matches what v3 wrote
        ui: { language: 'pt', theme: 'dark', startMinimized: false } as unknown,
        connection: undefined as unknown,
        transcript: undefined as unknown,
        schemaVersion: 3,
      },
    };
    writeFileSync(storeFile(cwd), JSON.stringify(v3));

    const store = createSettingsStore({ cwd });
    const s = store.get();
    expect(s.ui.autoLaunch).toBe(false);
    expect(s.connection.recentUrls).toEqual([]);
    expect(s.connection.draftUrl).toBe('');
    expect(s.transcript.recent).toEqual([]);
    expect(s.schemaVersion).toBe(5);
  });

  it('migrates a v4 file (no transcript) into v5 with empty recent', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'vg-settings-v4-'));
    const v4 = {
      settings: {
        ...defaultSettings(),
        transcript: undefined as unknown,
        schemaVersion: 4,
      },
    };
    writeFileSync(storeFile(cwd), JSON.stringify(v4));
    const store = createSettingsStore({ cwd });
    const s = store.get();
    expect(s.transcript.recent).toEqual([]);
    expect(s.schemaVersion).toBe(5);
  });

  it('round-trips persisted transcript lines through set() + reload', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'vg-settings-transcript-'));
    const first = createSettingsStore({ cwd });
    first.set({
      transcript: {
        recent: [
          { id: '1-u', role: 'user', text: 'olá' },
          { id: '1-a', role: 'assistant', text: 'olá tu' },
        ],
      },
    });
    const second = createSettingsStore({ cwd });
    expect(second.get().transcript.recent).toEqual([
      { id: '1-u', role: 'user', text: 'olá' },
      { id: '1-a', role: 'assistant', text: 'olá tu' },
    ]);
  });

  it('leaves a current-schema file untouched (no migration roundtrip)', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'vg-settings-current-'));
    const userPhrase = 'do something different';
    const current = {
      settings: {
        ...defaultSettings(),
        activation: { ...defaultSettings().activation, wakePhrase: userPhrase },
      },
    };
    writeFileSync(storeFile(cwd), JSON.stringify(current));

    const store = createSettingsStore({ cwd });
    expect(store.get().activation.wakePhrase).toBe(userPhrase);
  });

  it('set() persists across re-creation of the store with the same cwd', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'vg-settings-persist-'));
    const first = createSettingsStore({ cwd });
    first.set({
      activation: { ...first.get().activation, wakePhrase: 'persisted across boot' },
    });
    const second = createSettingsStore({ cwd });
    expect(second.get().activation.wakePhrase).toBe('persisted across boot');
  });

  it('reset() wipes pairing and reverts schemaVersion to current', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'vg-settings-reset-'));
    const store = createSettingsStore({ cwd });
    store.set({ pairing: { url: 'ws://x', token: 'y' } });
    expect(store.get().pairing).not.toBeNull();
    const after = store.reset();
    expect(after.pairing).toBeNull();
    expect(after.schemaVersion).toBe(5);
  });

  it('onChange listeners fire on set() and unregister cleanly', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'vg-settings-onchange-'));
    const store = createSettingsStore({ cwd });
    const heard: string[] = [];
    const off = store.onChange((s) => heard.push(s.activation.wakePhrase));
    store.set({
      activation: { ...store.get().activation, wakePhrase: 'one' },
    });
    store.set({
      activation: { ...store.get().activation, wakePhrase: 'two' },
    });
    off();
    store.set({
      activation: { ...store.get().activation, wakePhrase: 'three (not heard)' },
    });
    expect(heard).toEqual(['one', 'two']);
  });
});
