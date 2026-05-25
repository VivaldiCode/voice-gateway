/**
 * Issue #26 — Logo wordmark variant must not double-announce the
 * brand name to screen readers.
 *
 * Pre-fix: the wordmark variant rendered `<LogoMark>` (an
 * `<svg role="img" aria-label="Voice Gateway">`) AND a sibling
 * `<span>Voice Gateway</span>`. VoiceOver / NVDA / TalkBack all
 * announced "Voice Gateway, Voice Gateway" because both carried
 * the accessible name.
 *
 * Post-fix: the wordmark path passes `decorative` to `LogoMark`, which
 * makes the SVG `aria-hidden="true"` and drops the role/aria-label.
 * The icon-only variant (no wordmark) is unchanged — without a sibling
 * text element the SVG's aria-label IS the accessible name and is
 * still required.
 *
 * The repo doesn't ship `@testing-library/react`, so we assert on the
 * source string (same pattern as
 * `tests/unit/settings-header-structure.test.ts`). The assertions are
 * tight enough that a future refactor reverting the fix fails loudly.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOGO_SRC = join(
  HERE,
  '..',
  '..',
  'src',
  'renderer',
  'components',
  'Logo.tsx',
);

function readLogo(): string {
  return readFileSync(LOGO_SRC, 'utf-8');
}

describe('Logo a11y (issue #26)', () => {
  it('LogoMark accepts a `decorative` prop in its signature', () => {
    const src = readLogo();
    // The prop name + type — a regression that drops it loses the
    // mechanism we use to hide the SVG in the wordmark cluster.
    expect(src).toMatch(/decorative\?:\s*boolean/);
  });

  it('wordmark variant passes `decorative` to LogoMark', () => {
    const src = readLogo();
    // The literal JSX call we care about — direct match catches a
    // refactor that accidentally drops the prop.
    expect(src).toMatch(/<LogoMark\s+size={size}\s+decorative\s*\/>/);
  });

  it('LogoMark emits aria-hidden when decorative=true', () => {
    const src = readLogo();
    // The ternary that switches the a11y props based on `decorative`.
    // Both halves must be present so neither variant silently regresses.
    expect(src).toMatch(/decorative\s*\?\s*\(\{\s*'aria-hidden':\s*true/);
  });

  it('LogoMark keeps role="img" + aria-label when decorative=false', () => {
    const src = readLogo();
    // The else-branch of the same ternary — without this the icon-only
    // variant loses its accessible name.
    expect(src).toMatch(/role:\s*'img'\s*as\s*const,\s*'aria-label':\s*'Voice Gateway'/);
  });

  it('the visible wordmark <span> is still present (provides the accessible name)', () => {
    const src = readLogo();
    expect(src).toMatch(/<span\s+className="text-base font-semibold[^"]*">\s*Voice Gateway\s*<\/span>/);
  });
});
