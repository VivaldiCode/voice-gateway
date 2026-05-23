import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TEST_TEXT,
  MAX_TEST_TEXT_LENGTH,
  canSubmitTestText,
  prepareTestText,
} from '@shared/tts-test-text';

describe('prepareTestText', () => {
  it('returns the fallback when input is null', () => {
    expect(prepareTestText(null)).toBe(DEFAULT_TEST_TEXT);
  });

  it('returns the fallback when input is undefined', () => {
    expect(prepareTestText(undefined)).toBe(DEFAULT_TEST_TEXT);
  });

  it('returns the fallback when input is empty', () => {
    expect(prepareTestText('')).toBe(DEFAULT_TEST_TEXT);
  });

  it('returns the fallback for whitespace-only input', () => {
    expect(prepareTestText('   \n\t  ')).toBe(DEFAULT_TEST_TEXT);
  });

  it('honours a custom fallback', () => {
    expect(prepareTestText('', { fallback: 'olá' })).toBe('olá');
  });

  it('passes a normal sentence through unchanged', () => {
    expect(prepareTestText('Olá mundo')).toBe('Olá mundo');
  });

  it('trims surrounding whitespace', () => {
    expect(prepareTestText('  hello  ')).toBe('hello');
  });

  it('collapses internal newlines and tabs to single spaces', () => {
    // Piper otherwise pauses awkwardly on each newline; ElevenLabs strips them
    // anyway. Collapsing here keeps the two providers consistent.
    expect(prepareTestText('uma\nlinha\ttab\n\n outra')).toBe('uma linha tab outra');
  });

  it('caps long input at MAX_TEST_TEXT_LENGTH characters', () => {
    const long = 'palavra '.repeat(200); // 1600 chars, lots of word boundaries
    const out = prepareTestText(long);
    expect(out.length).toBeLessThanOrEqual(MAX_TEST_TEXT_LENGTH);
  });

  it('breaks at a word boundary when truncating', () => {
    // Build a string that lands a space well within the cap so the heuristic
    // can fire: each word is 9 chars, cap is 500 → last space is at 495.
    const long = 'palavras1 '.repeat(60); // 600 chars
    const out = prepareTestText(long);
    expect(out.length).toBeLessThanOrEqual(MAX_TEST_TEXT_LENGTH);
    // No trailing space, no half-word at the end.
    expect(out.endsWith(' ')).toBe(false);
    expect(out.endsWith('palavras1')).toBe(true);
  });

  it('does a hard truncation when the input has no convenient word boundary', () => {
    // One giant token (URL-like). The heuristic refuses to lop off most of the
    // string just for a stray space, so we accept a hard cut.
    const url = 'https://example.com/' + 'x'.repeat(600);
    const out = prepareTestText(url);
    expect(out.length).toBe(MAX_TEST_TEXT_LENGTH);
    expect(out.startsWith('https://example.com/')).toBe(true);
  });

  it('respects a custom maxLength', () => {
    expect(prepareTestText('um dois três quatro', { maxLength: 7 })).toBe('um dois');
  });

  it('coerces a maxLength of 0 to 1 (never returns empty)', () => {
    const out = prepareTestText('hi', { maxLength: 0 });
    expect(out.length).toBe(1);
  });

  it('numbers coerce to string before processing', () => {
    // Defensive: a misbehaving caller passing a non-string shouldn't crash.
    expect(prepareTestText(42 as unknown as string)).toBe('42');
  });
});

describe('canSubmitTestText', () => {
  it('returns true for null (fallback kicks in)', () => {
    expect(canSubmitTestText(null)).toBe(true);
  });

  it('returns true for whitespace-only input (fallback kicks in)', () => {
    expect(canSubmitTestText('   ')).toBe(true);
  });

  it('returns true for normal input', () => {
    expect(canSubmitTestText('hello')).toBe(true);
  });

  it('returns false when fallback is empty AND input is empty', () => {
    // Pure-rule edge case: if the caller deliberately disables the fallback
    // and the user typed nothing, the button must be disabled.
    expect(canSubmitTestText('', { fallback: '' })).toBe(false);
  });
});
