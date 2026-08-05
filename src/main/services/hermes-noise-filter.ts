/**
 * Strip Server-Sent-Events header lines that the Hermes bridge occasionally
 * leaks into the `text` field of a `response_text` frame.
 *
 * Root cause is upstream: the bridge parses Hermes's `text/event-stream`
 * output but sometimes forwards raw SSE header lines (`event: hermes.tool.*`
 * or bare `hermes.tool.progress` markers) inside the JSON payload of a
 * valid `response_text`. Without a client-side guard the noise reaches
 * both the transcript pane and the TTS pipeline — the user *sees* and
 * *hears* framework metadata instead of the assistant's actual reply.
 *
 * The filter is deliberately narrow:
 *
 *   - drops lines matching `^event:\s*hermes\.`  — the observed leak
 *   - drops lines matching `^hermes\.tool\.progress` on their own line —
 *     the bare-marker variant seen in the same session
 *   - trims surrounding whitespace so the residue is either clean
 *     assistant text or the empty string
 *
 * A `data:` prefix is NOT stripped — that's the SSE payload channel and
 * ANY leak of `data:` into `text` would carry legitimate content we
 * don't want to swallow. The upstream fix is to stop leaking headers at
 * all; this is defence-in-depth for the desktop.
 *
 * Tracked in issue #108. Companion upstream fix belongs on the bridge.
 */

const SSE_HERMES_EVENT_RE = /^event:\s*hermes\./i;
const HERMES_TOOL_PROGRESS_RE = /^hermes\.tool\.progress/i;

/**
 * Strip Hermes SSE-header leak from a `response_text.text` value.
 * Returns the cleaned text (may be empty if the whole payload was noise).
 * Pure function — safe to call any number of times on the same input.
 */
export function stripHermesSseNoise(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (SSE_HERMES_EVENT_RE.test(trimmed)) return false;
      if (HERMES_TOOL_PROGRESS_RE.test(trimmed)) return false;
      return true;
    })
    .join('\n')
    .trim();
}

/**
 * Convenience predicate — true iff every line in `text` would be stripped
 * by {@link stripHermesSseNoise}. Useful when the caller wants to decide
 * whether to skip an emit entirely instead of forwarding an empty string.
 */
export function isHermesSseNoiseOnly(text: string): boolean {
  return stripHermesSseNoise(text) === '';
}
