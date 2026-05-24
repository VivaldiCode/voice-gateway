import { describe, expect, it } from 'vitest';
import {
  PIPER_VOICES,
  parsePiperVoiceId,
  piperVoiceFileUrl,
  type ParsedVoice,
} from '@shared/piper-voices';

describe('PIPER_VOICES catalogue', () => {
  it('contains at least one PT and one EN voice', () => {
    const locales = new Set(PIPER_VOICES.map((v) => v.locale));
    expect([...locales].some((l) => l.startsWith('pt_'))).toBe(true);
    expect([...locales].some((l) => l.startsWith('en_'))).toBe(true);
  });

  it('every entry has a non-empty id, label, locale, and positive size', () => {
    for (const v of PIPER_VOICES) {
      expect(v.id.length).toBeGreaterThan(0);
      expect(v.label.length).toBeGreaterThan(0);
      expect(v.locale.length).toBeGreaterThan(0);
      expect(v.sizeMb).toBeGreaterThan(0);
    }
  });

  it('every catalogue entry round-trips through parsePiperVoiceId', () => {
    for (const v of PIPER_VOICES) {
      const parsed = parsePiperVoiceId(v.id);
      expect(parsed, `parse failed for ${v.id}`).not.toBeNull();
      // Locale matches what the catalogue claims.
      expect((parsed as ParsedVoice).locale).toBe(v.locale);
    }
  });

  it('every catalogue entry derives a download URL without throwing', () => {
    for (const v of PIPER_VOICES) {
      const onnx = piperVoiceFileUrl(v.id, 'onnx');
      const meta = piperVoiceFileUrl(v.id, 'onnx.json');
      expect(onnx).toMatch(/^https:\/\/huggingface\.co\/rhasspy\/piper-voices\//);
      expect(meta).toMatch(/\.onnx\.json$/);
    }
  });
});

describe('parsePiperVoiceId', () => {
  it('returns null on garbage input', () => {
    expect(parsePiperVoiceId('')).toBeNull();
    expect(parsePiperVoiceId('not-a-voice')).toBeNull();
    expect(parsePiperVoiceId('en-US-lessac-medium')).toBeNull(); // wrong separator
    expect(parsePiperVoiceId('en_US-lessac')).toBeNull(); // missing quality
  });

  it('rejects an unknown quality', () => {
    expect(parsePiperVoiceId('en_US-lessac-supercalifragilistic')).toBeNull();
  });

  it('parses each supported quality', () => {
    for (const q of ['low', 'medium', 'high', 'x_low'] as const) {
      const r = parsePiperVoiceId(`en_US-amy-${q}`);
      expect(r?.quality).toBe(q);
    }
  });

  it('accepts accented characters in the speaker segment', () => {
    const r = parsePiperVoiceId('pt_PT-tugão-medium');
    expect(r).not.toBeNull();
    expect(r?.speaker).toBe('tugão');
    expect(r?.locale).toBe('pt_PT');
  });
});

describe('piperVoiceFileUrl', () => {
  it('throws on invalid voice id', () => {
    expect(() => piperVoiceFileUrl('bogus', 'onnx')).toThrow(/Invalid Piper voice id/);
  });

  it('URL-encodes accented speaker names', () => {
    const url = piperVoiceFileUrl('pt_PT-tugão-medium', 'onnx');
    // "tugão" → %C3%A3 for the ã in path segments AND filename.
    expect(url).toContain('%C3%A3');
    expect(url).toMatch(/\.onnx$/);
  });

  it('builds the canonical en_US-lessac-medium path', () => {
    const url = piperVoiceFileUrl('en_US-lessac-medium', 'onnx');
    expect(url).toBe(
      'https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/lessac/medium/en_US-lessac-medium.onnx',
    );
  });

  it('switches between .onnx and .onnx.json suffix', () => {
    const a = piperVoiceFileUrl('en_US-amy-medium', 'onnx');
    const b = piperVoiceFileUrl('en_US-amy-medium', 'onnx.json');
    expect(b).toBe(`${a}.json`);
  });
});
