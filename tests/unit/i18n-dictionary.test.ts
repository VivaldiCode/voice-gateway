/**
 * Issue #16 (I2 follow-up): runtime guard rails for the i18n dictionary.
 *
 * The `Dictionary` interface in `src/renderer/i18n/pt.ts` already enforces
 * key parity at *compile* time (a missing key in `en` is a TS error). But
 * compile-time alone misses two real-world regressions:
 *
 *   1. Empty-string values — TS happily accepts `''` for a `string` slot,
 *      yet a renderer that displays `''` is a blank label and a UX bug.
 *   2. Function-shaped entries that return undefined / non-string — for
 *      example a refactor that forgets to interpolate the argument. The
 *      TS signature catches the type, not the body.
 *
 * This test walks both dictionaries recursively, asserts every leaf is a
 * non-empty string OR a function whose representative invocation returns
 * a non-empty string, and asserts the two locales have the same set of
 * leaf paths. It's deliberately fast (single-file, no React) so it runs
 * on every push and surfaces translation drift in seconds.
 */
import { describe, expect, it } from 'vitest';
// Relative path — there's no `@renderer` alias in vitest.config.ts, and
// the i18n dictionary is pure data (no JSX) so it imports fine into a
// node test environment.
import { pt, type Dictionary } from '../../src/renderer/i18n/pt';
import { en } from '../../src/renderer/i18n/en';

/** Recursively collect "leaf" paths through the dictionary, with the value
 *  at each leaf. A leaf is anything that isn't a plain object — strings
 *  and functions both count.
 *
 *  We classify functions separately because they need a representative
 *  call to verify (TypeScript can't tell us what shape of argument is
 *  reasonable). The handful of formatter signatures in `Dictionary` all
 *  take either a string, a number, or `number | null` — we pass a value
 *  of the right shape per known key path.
 */
type Leaf = { path: string; value: unknown };
function leaves(obj: Record<string, unknown>, prefix = ''): Leaf[] {
  const out: Leaf[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof v !== 'function') {
      out.push(...leaves(v as Record<string, unknown>, path));
    } else {
      out.push({ path, value: v });
    }
  }
  return out;
}

/** Representative input for each function-shaped key path. Update this
 *  table when adding a new formatter key. */
const FN_ARGS: Record<string, unknown[]> = {
  'app.windowTitle': ['Ready'],
  'transcript.nMessages': [3],
  'hotkeyHint.template': ['or press ⌘H'],
  'hotkeyHint.sayWakePhrase': ['hey hermes'],
  'hotkeyHint.orShortcut': ['⌘H'],
  'connection.connectedWithLatency': [42],
  'connection.connectingAttempt': [2],
  'connection.disconnectedAttempt': [3],
};

function assertLeavesAreUsable(dict: Dictionary, label: string): void {
  const ls = leaves(dict as unknown as Record<string, unknown>);
  expect(ls.length, `${label}: dictionary should have leaves`).toBeGreaterThan(0);
  for (const { path, value } of ls) {
    if (typeof value === 'string') {
      expect(value.length, `${label}: leaf "${path}" should be non-empty`).toBeGreaterThan(0);
    } else if (typeof value === 'function') {
      const args = FN_ARGS[path];
      expect(
        args,
        `${label}: function leaf "${path}" has no representative args defined in FN_ARGS — add one to this test`,
      ).toBeDefined();
      const out = (value as (...a: unknown[]) => unknown)(...(args ?? []));
      expect(typeof out, `${label}: function leaf "${path}" must return a string`).toBe('string');
      expect((out as string).length, `${label}: function leaf "${path}" returned empty string`).toBeGreaterThan(0);
    } else {
      throw new Error(`${label}: leaf "${path}" has unexpected type ${typeof value}`);
    }
  }
}

describe('i18n dictionary integrity', () => {
  it('PT dictionary leaves are all non-empty strings or working formatters', () => {
    assertLeavesAreUsable(pt, 'pt');
  });

  it('EN dictionary leaves are all non-empty strings or working formatters', () => {
    assertLeavesAreUsable(en, 'en');
  });

  it('PT and EN have the exact same set of leaf paths', () => {
    const ptPaths = leaves(pt as unknown as Record<string, unknown>)
      .map((l) => l.path)
      .sort();
    const enPaths = leaves(en as unknown as Record<string, unknown>)
      .map((l) => l.path)
      .sort();
    // Compare as sets rather than arrays for a clearer diff when one
    // side has extras.
    const ptOnly = ptPaths.filter((p) => !enPaths.includes(p));
    const enOnly = enPaths.filter((p) => !ptPaths.includes(p));
    expect({ ptOnly, enOnly }).toEqual({ ptOnly: [], enOnly: [] });
  });

  it('PT and EN values differ for visibly translated copy (sanity)', () => {
    // Spot-checks: if PT and EN ever match on these the migration has
    // regressed back to a single locale. We pick keys that *must* differ
    // by definition.
    expect(pt.app.settingsAria).not.toBe(en.app.settingsAria);
    expect(pt.transcript.copy).not.toBe(en.transcript.copy);
    expect(pt.tutorial.skip).not.toBe(en.tutorial.skip);
    expect(pt.micPermission.request).not.toBe(en.micPermission.request);
  });

  it('exposes the Round-12 keys for MainScreen / TranscriptView / TutorialOverlay', () => {
    // Smoke-test for keys added by Issue #16. These are the only new
    // shapes in this PR beyond what the original I2 round-12 batch
    // shipped, so a regression here means an editor accidentally
    // unwound the migration.
    for (const d of [pt, en]) {
      expect(d.app.cancelCaptureAria).toBeTruthy();
      expect(d.app.notificationReply).toBeTruthy();
      expect(d.transcript.copyAria).toBeTruthy();
      expect(d.transcript.clearAria).toBeTruthy();
      expect(d.transcript.userPrefix).toBeTruthy();
      expect(d.transcript.assistantPrefix).toBeTruthy();
      expect(d.transcript.exportUser).toBeTruthy();
      expect(d.transcript.exportAssistant).toBeTruthy();
      // Tutorial steps the overlay now reads via t.tutorial.*
      expect(d.tutorial.welcomeTitle).toBeTruthy();
      expect(d.tutorial.pressTitle).toBeTruthy();
      expect(d.tutorial.cancelTitle).toBeTruthy();
      expect(d.tutorial.settingsTitle).toBeTruthy();
      expect(d.tutorial.doneTitle).toBeTruthy();
      // MicPermissionBanner copy
      expect(d.micPermission.deniedTitle).toBeTruthy();
      expect(d.micPermission.pendingTitle).toBeTruthy();
      // ConnectionIndicator formatters
      expect(d.connection.connectedWithLatency(120)).toContain('120');
      expect(d.connection.connectingAttempt(4)).toContain('4');
    }
  });
});
