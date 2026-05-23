/**
 * Helpers for the custom-phrase wake-word path.
 *
 * The Python runner streams audio into whisper.cpp; whisper produces a noisy
 * transcript that almost-but-not-quite matches what the user said. This file
 * holds the pure normalisation + matching logic used both:
 *   - on the TS side to validate the user-typed phrase before persisting it,
 *     and to decide whether the "Test" button can be enabled,
 *   - on the Python side: the same rules are mirrored in `wake_phrase.py`
 *     (kept in sync by tests in both languages).
 *
 * No imports — must stay safe in every Electron process.
 */

/**
 * Lower bound on phrase length. Anything shorter trips on every transcript
 * (e.g. `"oi"` matches half of what Whisper hallucinates from background
 * noise). The bound is intentionally lenient so phrases like `"olá"` and
 * `"hey"` work, but a single letter is rejected.
 */
export const MIN_WAKE_PHRASE_CHARS = 3;

/**
 * Upper bound. Wake phrases are short by nature; capping prevents the
 * settings UI from accepting "type a paragraph" and the runner from
 * comparing huge strings on every window.
 */
export const MAX_WAKE_PHRASE_CHARS = 60;

/**
 * Canonicalise a phrase or a transcript for matching:
 *
 * - lowercase via `String.toLowerCase()` (Unicode-aware in modern JS engines)
 * - strip leading/trailing whitespace
 * - collapse runs of whitespace to a single space
 * - drop ASCII punctuation that whisper sometimes emits (`.`, `,`, `?`, `!`,
 *   parens, quotes…) — they almost never appear in the phrase the user
 *   typed but routinely appear in the transcript ("Hey, Hermes.")
 * - drop common diacritics by NFD-decomposing then stripping combining marks
 *   so "olá" matches "ola" — Whisper isn't always consistent on accents
 *
 * Returns the canonicalised string. Empty in / empty out.
 */
export function normalizeWakePhrase(input: string | null | undefined): string {
  if (input == null) return '';
  const s = String(input);
  // NFD splits "á" into "a" + combining acute, then we drop the combining
  // marks. Works for Portuguese / Spanish / French / German for our purposes.
  const stripped = s.normalize('NFD').replace(/[̀-ͯ]/g, '');
  return stripped
    .toLowerCase()
    .replace(/[.,!?;:()[\]{}"'`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface ValidationResult {
  ok: boolean;
  /** When ok is false, a short user-facing message in Portuguese. */
  reason?: string;
}

/** Quick check that `phrase` is a usable wake phrase. UI uses this to gate
 *  the Save / Test buttons. */
export function validateWakePhrase(phrase: string | null | undefined): ValidationResult {
  const norm = normalizeWakePhrase(phrase);
  if (norm.length === 0) {
    return { ok: false, reason: 'Escreve uma frase para a deteção.' };
  }
  if (norm.length < MIN_WAKE_PHRASE_CHARS) {
    return {
      ok: false,
      reason: `Frase demasiado curta — mínimo ${MIN_WAKE_PHRASE_CHARS} caracteres depois de normalizar.`,
    };
  }
  if (norm.length > MAX_WAKE_PHRASE_CHARS) {
    return {
      ok: false,
      reason: `Frase demasiado longa — máximo ${MAX_WAKE_PHRASE_CHARS} caracteres.`,
    };
  }
  // Whisper occasionally hallucinates whole sentences from background noise.
  // Single-character "phrases" after normalisation (e.g. just "a") would fire
  // constantly. Require at least two distinct word tokens OR a single longer
  // token (>= 5 chars). Heuristic; tests pin the behaviour.
  const tokens = norm.split(' ').filter((t) => t.length > 0);
  const longestToken = tokens.reduce((m, t) => Math.max(m, t.length), 0);
  if (tokens.length < 2 && longestToken < 5) {
    return {
      ok: false,
      reason: 'Frase demasiado simples — usa pelo menos duas palavras ou uma palavra com 5+ letras.',
    };
  }
  return { ok: true };
}

/**
 * Substring match after canonicalisation. The matcher is intentionally
 * lenient: Whisper's transcript is often slightly off ("hey hermès." for the
 * phrase "hey hermes"), so we compare normalised forms and accept any
 * occurrence. Returns true iff `transcript` contains `phrase`.
 */
export function matchesWakePhrase(transcript: string, phrase: string): boolean {
  const t = normalizeWakePhrase(transcript);
  const p = normalizeWakePhrase(phrase);
  if (!t || !p) return false;
  if (p.length < MIN_WAKE_PHRASE_CHARS) return false;
  return t.includes(p);
}
