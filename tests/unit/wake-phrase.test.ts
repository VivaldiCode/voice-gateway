import { describe, expect, it } from 'vitest';
import {
  MAX_WAKE_PHRASE_CHARS,
  MIN_WAKE_PHRASE_CHARS,
  matchesWakePhrase,
  normalizeWakePhrase,
  validateWakePhrase,
} from '@shared/wake-phrase';

describe('normalizeWakePhrase', () => {
  it('returns empty for null and undefined', () => {
    expect(normalizeWakePhrase(null)).toBe('');
    expect(normalizeWakePhrase(undefined)).toBe('');
  });

  it('returns empty for empty / whitespace-only input', () => {
    expect(normalizeWakePhrase('')).toBe('');
    expect(normalizeWakePhrase('   \n\t   ')).toBe('');
  });

  it('lowercases', () => {
    expect(normalizeWakePhrase('Hey HERMES')).toBe('hey hermes');
  });

  it('collapses internal whitespace to single spaces', () => {
    expect(normalizeWakePhrase('hey\t\nhermes  amigo')).toBe('hey hermes amigo');
  });

  it('strips ASCII punctuation Whisper tends to emit', () => {
    expect(normalizeWakePhrase('Hey, Hermes! Are you there?')).toBe('hey hermes are you there');
    expect(normalizeWakePhrase('"olá" (oi)')).toBe('ola oi');
  });

  it('strips diacritics so accented and unaccented forms match', () => {
    expect(normalizeWakePhrase('olá')).toBe('ola');
    expect(normalizeWakePhrase('Olá Hermès')).toBe('ola hermes');
    expect(normalizeWakePhrase('café com leite')).toBe('cafe com leite');
  });

  it('is idempotent', () => {
    const once = normalizeWakePhrase('Hey, Hermès!');
    const twice = normalizeWakePhrase(once);
    expect(once).toBe(twice);
  });
});

describe('validateWakePhrase', () => {
  it('rejects empty input', () => {
    const r = validateWakePhrase('');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/escreve|frase/i);
  });

  it('rejects whitespace-only input', () => {
    expect(validateWakePhrase('   ').ok).toBe(false);
  });

  it('rejects sub-MIN_WAKE_PHRASE_CHARS phrases after normalisation', () => {
    const r = validateWakePhrase('ab');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/curta/i);
  });

  it('rejects single short token (would over-trigger)', () => {
    // "oi" normalises to 2 chars → caught by min length; "olá" → "ola" (3 chars,
    // ≥ MIN_WAKE_PHRASE_CHARS) but only one token and only 3 chars → rejected.
    const r = validateWakePhrase('olá');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/simples|duas/i);
  });

  it('accepts a single long word', () => {
    expect(validateWakePhrase('jarvis').ok).toBe(true);
    expect(validateWakePhrase('computer').ok).toBe(true);
  });

  it('accepts a two-word short phrase', () => {
    expect(validateWakePhrase('hey hermes').ok).toBe(true);
    expect(validateWakePhrase('ola amigo').ok).toBe(true);
  });

  it('rejects absurdly long input', () => {
    const long = 'a '.repeat(MAX_WAKE_PHRASE_CHARS).slice(0, MAX_WAKE_PHRASE_CHARS + 50);
    const r = validateWakePhrase(long);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/longa|máximo/i);
  });

  it('exposes the bound constants for the UI', () => {
    expect(MIN_WAKE_PHRASE_CHARS).toBeGreaterThan(0);
    expect(MAX_WAKE_PHRASE_CHARS).toBeGreaterThan(MIN_WAKE_PHRASE_CHARS);
  });
});

describe('matchesWakePhrase', () => {
  it('returns true when transcript contains the phrase verbatim', () => {
    expect(matchesWakePhrase('hey hermes', 'hey hermes')).toBe(true);
  });

  it('returns true on case + punctuation mismatch (the common Whisper case)', () => {
    expect(matchesWakePhrase('Hey, Hermes!', 'hey hermes')).toBe(true);
  });

  it('returns true when the phrase is a substring of a longer transcript', () => {
    expect(matchesWakePhrase('então, hey hermes, podes ouvir?', 'hey hermes')).toBe(true);
  });

  it('returns true across diacritic differences', () => {
    // Whisper produces "hermès" with grave; user typed "hermes".
    expect(matchesWakePhrase('Hey, Hermès.', 'hey hermes')).toBe(true);
    // The reverse: user typed accents, transcript stripped them.
    expect(matchesWakePhrase('olá amigo', 'ola amigo')).toBe(true);
    expect(matchesWakePhrase('ola amigo', 'olá amigo')).toBe(true);
  });

  it('returns false when the phrase is absent', () => {
    expect(matchesWakePhrase('algo completamente diferente', 'hey hermes')).toBe(false);
  });

  it('returns false on empty transcript or empty phrase', () => {
    expect(matchesWakePhrase('', 'hey hermes')).toBe(false);
    expect(matchesWakePhrase('hey hermes', '')).toBe(false);
  });

  it('returns false for a too-short phrase (defence in depth — validateWakePhrase usually catches first)', () => {
    expect(matchesWakePhrase('hey jarvis ah hello', 'a')).toBe(false);
    expect(matchesWakePhrase('xy hello world', 'xy')).toBe(false);
  });

  it('matches transcripts whisper hallucinates with trailing periods', () => {
    expect(matchesWakePhrase('Hey Hermes.', 'hey hermes')).toBe(true);
    expect(matchesWakePhrase('Hey Hermes...', 'hey hermes')).toBe(true);
  });
});
