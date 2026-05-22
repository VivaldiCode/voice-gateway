import { describe, expect, it } from 'vitest';
import { _deepMerge, _mergeSettings, defaultSettings } from '@main/services/settings-store';

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
