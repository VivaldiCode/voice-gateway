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
    expect(s.schemaVersion).toBe(3);
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
    expect(s.schemaVersion).toBe(3);

    // The migration is persisted back to disk so the next boot is fast.
    const onDisk = JSON.parse(readFileSync(storeFile(cwd), 'utf-8'));
    expect(onDisk.settings.schemaVersion).toBe(3);
    expect(onDisk.settings.activation.wakeMode).toBe('openww');
  });

  it('migrates a v2 file (no audio.outputMuted) into v3 with mute=false', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'vg-settings-v2-'));
    const v2 = {
      settings: {
        ...defaultSettings(),
        // strip the v3 field so the on-disk shape matches what v2 wrote
        audio: { inputDeviceId: 'mic-x', outputDeviceId: null } as unknown,
        schemaVersion: 2,
      },
    };
    writeFileSync(storeFile(cwd), JSON.stringify(v2));

    const store = createSettingsStore({ cwd });
    const s = store.get();
    expect(s.audio.inputDeviceId).toBe('mic-x');
    expect(s.audio.outputMuted).toBe(false);
    expect(s.schemaVersion).toBe(3);
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
    expect(after.schemaVersion).toBe(3);
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
