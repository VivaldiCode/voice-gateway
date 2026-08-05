/**
 * Issue #108: user reported the TTS speaking `event: hermes.tool.progressevent`
 * lines that the Hermes bridge leaks into the `text` field of `response_text`
 * frames. Root cause is upstream (bridge is leaking SSE headers into JSON
 * payload); this filter is the client-side defence-in-depth.
 *
 * These tests pin the filter's exact contract so a future refactor can't
 * silently regress into either extreme:
 *
 *   - too aggressive → strips real assistant text that happens to mention
 *     the word "hermes" or starts with something SSE-shaped
 *   - too permissive → lets the noise back into TTS + UI
 */
import { describe, expect, it } from 'vitest';
import { isHermesSseNoiseOnly, stripHermesSseNoise } from '../../src/main/services/hermes-noise-filter';

describe('stripHermesSseNoise', () => {
  it('returns clean assistant text untouched', () => {
    const input = 'Office AC is already set to 16°C on cool mode, love — current temp 29.5°C. Sorted.';
    expect(stripHermesSseNoise(input)).toBe(input);
  });

  it('strips a single `event: hermes.tool.progressevent` line', () => {
    const input = 'event: hermes.tool.progressevent';
    expect(stripHermesSseNoise(input)).toBe('');
  });

  it('strips repeated noise lines interleaved with real text', () => {
    const input = [
      'event: hermes.tool.progressevent',
      'event: hermes.tool.progressevent',
      'Office AC is already set to 16°C.',
      'hermes.tool.progress',
    ].join('\n');
    expect(stripHermesSseNoise(input)).toBe('Office AC is already set to 16°C.');
  });

  it("strips the concatenated single-line form observed on the user's setup", () => {
    // The literal payload seen in the transcript pane during human testing
    // (issue #108 screenshots). Everything on this line is noise; residue
    // should be empty.
    const input =
      'event: hermes.tool.progressevent:\nhermes.tool.progressevent: hermes.tool.progressevent:\nhermes.tool.progressevent: hermes.tool.progressevent:\nhermes.tool.progress';
    // Some of these lines don't start with `event:` and aren't bare progress
    // markers — they're mid-line-concatenated payloads. The filter should
    // still handle the clean cases + leave the residual concatenation intact
    // so we don't false-positive on assistant text that mentions the word.
    const out = stripHermesSseNoise(input);
    // `event: hermes.tool.progressevent:` — matches SSE_HERMES_EVENT_RE → dropped
    // `hermes.tool.progressevent: hermes.tool.progressevent:` — matches
    //   HERMES_TOOL_PROGRESS_RE (starts with `hermes.tool.progress`) → dropped
    // `hermes.tool.progress` — matches → dropped
    // Everything dropped → residue is empty.
    expect(out).toBe('');
  });

  it('does NOT strip an assistant sentence that mentions "hermes.tool" mid-line', () => {
    // False-positive guard: if the assistant *tells* the user about the
    // hermes.tool namespace mid-sentence, we must not delete the line.
    const input = 'The hermes.tool APIs are internal — you should never see them.';
    expect(stripHermesSseNoise(input)).toBe(input);
  });

  it("does NOT strip `data:` lines (bridge's payload channel — legit)", () => {
    // Only `event:` headers are the observed leak. `data:` at the start of
    // a line MUST survive because it might be legitimate assistant content
    // (e.g. code, JSON, or the word "data" in a colon-listed answer).
    const input = 'data: check the report';
    expect(stripHermesSseNoise(input)).toBe(input);
  });

  it('trims surrounding whitespace after stripping', () => {
    const input = '\n\nevent: hermes.tool.progressevent\n\nHi there.\n\n';
    expect(stripHermesSseNoise(input)).toBe('Hi there.');
  });

  it('is idempotent (safe to call any number of times)', () => {
    const input = 'event: hermes.tool.progress\nActual reply.';
    const once = stripHermesSseNoise(input);
    expect(stripHermesSseNoise(once)).toBe(once);
    expect(stripHermesSseNoise(stripHermesSseNoise(once))).toBe(once);
  });

  it('handles Windows-style line endings (\\r\\n)', () => {
    const input = 'event: hermes.tool.progressevent\r\nReal text.';
    expect(stripHermesSseNoise(input)).toBe('Real text.');
  });

  it('handles an empty string', () => {
    expect(stripHermesSseNoise('')).toBe('');
  });

  it('handles whitespace-only input', () => {
    expect(stripHermesSseNoise('   \n\n\t  ')).toBe('');
  });

  it('is case-insensitive for the header prefix', () => {
    const input = 'Event: Hermes.Tool.ProgressEvent';
    expect(stripHermesSseNoise(input)).toBe('');
  });
});

describe('isHermesSseNoiseOnly', () => {
  it('returns true when the entire payload is noise', () => {
    expect(isHermesSseNoiseOnly('event: hermes.tool.progressevent')).toBe(true);
    expect(isHermesSseNoiseOnly('hermes.tool.progress')).toBe(true);
    expect(
      isHermesSseNoiseOnly('event: hermes.tool.progressevent\nhermes.tool.progress'),
    ).toBe(true);
  });

  it('returns false when there is any real content', () => {
    expect(isHermesSseNoiseOnly('event: hermes.tool.progressevent\nHi')).toBe(false);
    expect(isHermesSseNoiseOnly('Actual reply.')).toBe(false);
  });

  it('returns true for empty / whitespace-only input', () => {
    expect(isHermesSseNoiseOnly('')).toBe(true);
    expect(isHermesSseNoiseOnly('  \n\n')).toBe(true);
  });
});
