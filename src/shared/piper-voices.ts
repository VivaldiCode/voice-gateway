/**
 * Curated Piper voice catalogue.
 *
 * The full list at https://huggingface.co/rhasspy/piper-voices has hundreds
 * of voices; we surface a small set that covers Portuguese (PT + BR) and
 * English well enough for the desktop UI. The Voice ID matches Piper's
 * canonical naming so the download URL can be derived mechanically.
 *
 * Pattern: `<lang_short>_<LOCALE>-<speaker>-<quality>`
 *   e.g. en_US-lessac-medium, pt_PT-tugão-medium
 */

export interface PiperVoiceInfo {
  /** Canonical Piper voice id, used as the file basename. */
  id: string;
  /** Human-friendly label shown in the picker. */
  label: string;
  /** ISO-style locale (used for grouping + filtering). */
  locale: string;
  /** Approximate `.onnx` size in MB — gives the UI a sensible ETA. */
  sizeMb: number;
}

export const PIPER_VOICES: readonly PiperVoiceInfo[] = [
  // Português
  { id: 'pt_PT-tugão-medium',  label: 'Tugão — Português (PT)', locale: 'pt_PT', sizeMb: 60 },
  { id: 'pt_BR-faber-medium',  label: 'Faber — Português (BR)', locale: 'pt_BR', sizeMb: 60 },
  // English
  { id: 'en_US-lessac-medium', label: 'Lessac — English (US), feminine', locale: 'en_US', sizeMb: 60 },
  { id: 'en_US-amy-medium',    label: 'Amy — English (US), feminine',    locale: 'en_US', sizeMb: 60 },
  { id: 'en_US-ryan-medium',   label: 'Ryan — English (US), masculine',  locale: 'en_US', sizeMb: 60 },
  { id: 'en_GB-alan-medium',   label: 'Alan — English (UK), masculine',  locale: 'en_GB', sizeMb: 60 },
];

/** Parse a Piper voice id into its components, or return null on bad input. */
export interface ParsedVoice {
  short: string;   // e.g. "en"
  locale: string;  // e.g. "en_US"
  speaker: string; // e.g. "lessac" or "tugão"
  quality: 'low' | 'medium' | 'high' | 'x_low';
}

export function parsePiperVoiceId(voiceId: string): ParsedVoice | null {
  const m = /^([a-z]{2})_([A-Z]{2})-(.+)-(low|medium|high|x_low)$/.exec(voiceId);
  if (!m) return null;
  const [, short, country, speaker, quality] = m;
  if (!short || !country || !speaker || !quality) return null;
  return { short, locale: `${short}_${country}`, speaker, quality: quality as ParsedVoice['quality'] };
}

/**
 * Return the Hugging Face download URL for one of a voice's files.
 * Speaker names may contain accented characters (e.g. "tugão"), which the
 * Hugging Face CDN serves unencoded — but we URL-encode anyway to stay safe
 * with intermediate caches.
 */
export function piperVoiceFileUrl(
  voiceId: string,
  file: 'onnx' | 'onnx.json',
): string {
  const parsed = parsePiperVoiceId(voiceId);
  if (!parsed) throw new Error(`Invalid Piper voice id: ${voiceId}`);
  const seg = (s: string): string => encodeURIComponent(s);
  return (
    `https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/` +
    `${seg(parsed.short)}/${seg(parsed.locale)}/${seg(parsed.speaker)}/${seg(parsed.quality)}/` +
    `${seg(voiceId)}.${file}`
  );
}
