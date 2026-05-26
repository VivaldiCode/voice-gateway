/**
 * Issue #48: lock in the build-doctor's pre-flight contract.
 *
 * The doctor (`tools/build-doctor.cjs`) is the only thing standing
 * between a corrupted-node_modules failure (which happens silently
 * on external/exFAT volumes — see issue #48) and the user wasting
 * 5–8 s on a doomed `electron-vite build`. Three pieces matter:
 *
 *   1. The exact file that disappeared in issue #48 stays in the
 *      CRITICAL_FILES list as a regression guard.
 *   2. `check()` returns an empty array on a healthy tree — so the
 *      doctor doesn't false-positive on every developer's machine.
 *   3. `suggestFix()` correctly groups deeply-nested paths back to
 *      their top-level package directory, so the printed
 *      `rm -rf <path> && npm install` is minimal (not "rm -rf the
 *      whole world").
 *
 * The script is CommonJS so it can run before any TypeScript
 * pipeline boots; we load it via createRequire so the unit test
 * (ESM under vitest) can still introspect its exports.
 */
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const doctor = require('../../tools/build-doctor.cjs') as {
  check: () => string[];
  suggestFix: (missing: string[]) => string[];
  CRITICAL_FILES: string[];
};

describe('build-doctor', () => {
  it('keeps the issue #48 regression path in CRITICAL_FILES', () => {
    // The exact file that disappeared on 2026-05-26. If someone trims
    // the list during a future refactor, this canary breaks.
    expect(doctor.CRITICAL_FILES).toContain(
      'node_modules/builder-util/node_modules/fs-extra/lib/index.js',
    );
  });

  it('covers the top-level build tooling entry points', () => {
    // These are the packages whose absence would make any build:* script
    // immediately fail; the doctor should always check them.
    const required = [
      'node_modules/electron-builder/package.json',
      'node_modules/electron-vite/package.json',
      'node_modules/builder-util/package.json',
      'node_modules/fs-extra/package.json',
    ];
    for (const f of required) {
      expect(doctor.CRITICAL_FILES, `missing critical file: ${f}`).toContain(f);
    }
  });

  it('check() returns no missing files on a healthy tree', () => {
    // We assume the dev machine running the test suite has a working
    // node_modules — otherwise vitest itself couldn't have loaded.
    // The point is: the doctor must NOT false-positive in that case.
    expect(doctor.check()).toEqual([]);
  });

  it('suggestFix() groups deeply-nested files back to their package root', () => {
    const result = doctor.suggestFix([
      'node_modules/builder-util/node_modules/fs-extra/lib/index.js',
      'node_modules/builder-util/node_modules/fs-extra/lib/copy/index.js',
    ]);
    // Both files share the same nested package, so the suggested
    // remediation should collapse them into one `rm -rf`.
    expect(result).toEqual([
      'node_modules/builder-util/node_modules/fs-extra',
    ]);
  });

  it('suggestFix() handles plain (non-nested) packages', () => {
    const result = doctor.suggestFix([
      'node_modules/electron-builder/out/cli/cli.js',
      'node_modules/electron-builder/package.json',
    ]);
    expect(result).toEqual(['node_modules/electron-builder']);
  });

  it('suggestFix() handles a mix of nested and top-level entries', () => {
    const result = doctor.suggestFix([
      'node_modules/builder-util/node_modules/fs-extra/lib/index.js',
      'node_modules/electron-vite/bin/electron-vite.js',
    ]);
    expect(result.sort()).toEqual([
      'node_modules/builder-util/node_modules/fs-extra',
      'node_modules/electron-vite',
    ]);
  });

  it('suggestFix() handles scoped packages', () => {
    const result = doctor.suggestFix([
      'node_modules/@vitejs/plugin-react/dist/index.js',
    ]);
    // The grouping should keep `@scope/name` together — otherwise we'd
    // print `rm -rf node_modules/@vitejs` and wipe sibling scoped packages.
    expect(result).toEqual(['node_modules/@vitejs/plugin-react']);
  });
});
