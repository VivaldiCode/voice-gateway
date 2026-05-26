/**
 * Issue #19 — lock in the SettingsPanel header structure so a future
 * refactor doesn't accidentally revert to the pre-round-12 single-row
 * layout that collided with the macOS traffic lights.
 *
 * The codebase doesn't ship `@testing-library/react`, so we can't
 * mount the component in a DOM-aware test. Instead we read the source
 * directly and assert the structural invariants we care about:
 *
 *   1. Logo is imported (so the new wordmark renders)
 *   2. The header carries `data-testid="settings-header"` (matches the
 *      E2E spec that probes for it)
 *   3. The 28 px traffic-light spacer (`h-7` + `aria-hidden`) appears
 *      and is conditional on the `window` layout
 *   4. The legacy `pl-[88px]` workaround for traffic-lights is gone
 *      — the new two-row layout makes it unnecessary
 *   5. The header uses `flex flex-col` (two rows) instead of the old
 *      single-row `flex items-center`
 *
 * These assertions are deliberately strict: if the file ever drifts
 * back to the old shape this test screams loudly with a clear delta.
 * It runs in vitest's default node env (no DOM needed).
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_SRC = join(
  HERE,
  '..',
  '..',
  'src',
  'renderer',
  'components',
  'SettingsPanel.tsx',
);

function readPanel(): string {
  return readFileSync(PANEL_SRC, 'utf-8');
}

describe('SettingsPanel header structure (issue #19)', () => {
  it('imports the Logo component used by the new two-row header', () => {
    const src = readPanel();
    expect(src).toMatch(/from '\.\/Logo'/);
    expect(src).toMatch(/<Logo\b/);
  });

  it('header carries data-testid="settings-header" so E2E specs can probe it', () => {
    const src = readPanel();
    expect(src).toContain('data-testid="settings-header"');
  });

  it('uses the two-row flex-col layout (not the old single-row)', () => {
    const src = readPanel();
    // The new pattern lives inside the header element. We assert both
    // shape pieces: flex-col (rows stack) AND the [&_button]:vg-no-drag
    // selector that keeps controls clickable while the row is draggable.
    expect(src).toMatch(/<header\s+className="vg-drag flex flex-col[^"]*\[&_button\]:vg-no-drag"/);
  });

  it('renders the 28 px traffic-light spacer only in the window layout', () => {
    const src = readPanel();
    // The spacer is conditional on layout === 'window' so the side
    // drawer (which has no titlebar) doesn't get extra empty space.
    expect(src).toMatch(/layout === 'window' && <div className="h-7" aria-hidden="true" \/>/);
  });

  it('drops the legacy pl-[88px] traffic-light workaround', () => {
    const src = readPanel();
    expect(src).not.toContain('pl-[88px]');
  });

  it('keeps the savedFlash and close button on the right edge', () => {
    const src = readPanel();
    // The savedFlash indicator is a regression-prone bit — verify it
    // didn't get dropped during the layout swap.
    expect(src).toContain('data-testid="settings-saved-indicator"');
    expect(src).toContain('data-testid="settings-close"');
  });
});
