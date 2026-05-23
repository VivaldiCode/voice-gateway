/**
 * Helpers for the "Testar voz" widget in Settings → Voz.
 *
 * Kept here (not in the renderer) for two reasons:
 *   1. Pure functions belong in shared so they're trivially unit-testable
 *      from vitest's node environment — no jsdom, no React, no IPC.
 *   2. The same sanitisation might one day apply to the in-conversation
 *      TTS path (defensive cap on assistant replies), and reusing the
 *      helper avoids drift.
 */

/**
 * The fallback prompt shown as a placeholder and used when the user hasn't
 * typed anything. Portuguese to match the rest of the Settings UI strings.
 */
export const DEFAULT_TEST_TEXT = 'Olá, eu sou o Hermes. Que bom ouvir-te.';

/**
 * Upper bound on the synthesised text. Piper and ElevenLabs both happily
 * accept much longer input, but a multi-thousand-char paste deadlocks the
 * "Test" button for tens of seconds and is almost never what the user
 * meant. Keep the cap generous enough to fit a paragraph but short enough
 * to fail fast on accidental novel-pastes.
 */
export const MAX_TEST_TEXT_LENGTH = 500;

export interface PrepareTestTextOptions {
  /** Text to substitute when input is empty/whitespace. Defaults to the sample sentence. */
  fallback?: string;
  /** Inclusive upper bound on the returned length. Defaults to {@link MAX_TEST_TEXT_LENGTH}. */
  maxLength?: number;
}

/**
 * Normalise raw textarea input into something safe to hand to the TTS adapter.
 *
 * - Trims surrounding whitespace.
 * - Collapses runs of internal whitespace (newlines, tabs, repeated spaces)
 *   to a single space — Piper otherwise inserts awkwardly long pauses for
 *   each `\n`, and ElevenLabs strips them anyway.
 * - Falls back to `opts.fallback` (default: {@link DEFAULT_TEST_TEXT}) when
 *   the trimmed input is empty.
 * - Truncates the result to `opts.maxLength` characters (default
 *   {@link MAX_TEST_TEXT_LENGTH}). Truncation happens at the last word
 *   boundary inside the cap when possible so we don't slice a word in half.
 *
 * Always returns a non-empty string. Always returns the fallback if `input`
 * is null/undefined.
 */
export function prepareTestText(input: string | null | undefined, opts: PrepareTestTextOptions = {}): string {
  const fallback = opts.fallback ?? DEFAULT_TEST_TEXT;
  const maxLength = Math.max(1, opts.maxLength ?? MAX_TEST_TEXT_LENGTH);

  const collapsed = String(input ?? '').replace(/\s+/g, ' ').trim();
  const source = collapsed.length === 0 ? fallback : collapsed;
  if (source.length <= maxLength) return source;

  // Try to break at the last space before the cap so we don't truncate a word.
  const slice = source.slice(0, maxLength);
  const lastSpace = slice.lastIndexOf(' ');
  if (lastSpace >= Math.floor(maxLength * 0.6)) {
    // Only honour the word-boundary heuristic if it doesn't lop off most of
    // the string (the user might have pasted one giant URL).
    return slice.slice(0, lastSpace);
  }
  return slice;
}

/**
 * Pure check used by the UI to decide whether the "Reproduzir" button should
 * be enabled. Always true today (the fallback guarantees a non-empty result),
 * but exported so the rule is unit-testable and any future stricter validation
 * lands in one place.
 */
export function canSubmitTestText(input: string | null | undefined, opts: PrepareTestTextOptions = {}): boolean {
  return prepareTestText(input, opts).length > 0;
}
