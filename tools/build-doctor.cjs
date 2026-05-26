#!/usr/bin/env node
/**
 * Pre-flight check that runs before `npm run build:mac|linux|win`.
 *
 * Surfaces a class of failure where individual files inside
 * `node_modules/` go missing without the parent tree being obviously
 * broken — typically observed when the repo lives on an external
 * volume whose filesystem (exFAT, MS-DOS) doesn't preserve POSIX
 * metadata the way APFS does. The symptom is electron-builder
 * exploding at startup with `MODULE_NOT_FOUND` for a deeply nested
 * file even though `package.json` and most siblings are present.
 *
 * Without this check, `electron-vite build` runs to completion first
 * (5–8 s wasted) and the error message points at builder-util
 * internals — easy to misdiagnose as an electron-builder bug.
 *
 * The check is intentionally narrow: it only inspects the handful of
 * entry points we've actually seen disappear in practice. Adding the
 * full transitive closure would be slow and noisy.
 *
 * Tracking: see https://github.com/VivaldiCode/voice-gateway/issues/48
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// Files we've seen drop out individually. Each entry is a path relative
// to the project root. The list is deliberately short — extend it only
// when a new failure mode is observed in the wild, not speculatively.
const CRITICAL_FILES = [
  // The exact file that disappeared on 2026-05-26 (issue #48).
  'node_modules/builder-util/node_modules/fs-extra/lib/index.js',
  // Entry points of the top-level build tooling. If any of these are
  // missing the build can't even start.
  'node_modules/electron-builder/out/cli/cli.js',
  'node_modules/electron-builder/package.json',
  'node_modules/electron-vite/bin/electron-vite.js',
  'node_modules/electron-vite/package.json',
  'node_modules/builder-util/package.json',
  // Hoisted fs-extra — the parent of the nested copy that broke.
  'node_modules/fs-extra/lib/index.js',
  'node_modules/fs-extra/package.json',
];

function check() {
  const missing = [];
  for (const rel of CRITICAL_FILES) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) {
      missing.push(rel);
    }
  }
  return missing;
}

function suggestFix(missing) {
  // Group by the closest containing `node_modules/<pkg>` directory so a
  // single `rm -rf <pkg> && npm install` covers all the affected entries.
  const groups = new Set();
  for (const rel of missing) {
    // Strip after the second `node_modules` segment if present, else after
    // the first; this turns
    //   node_modules/builder-util/node_modules/fs-extra/lib/index.js
    // into
    //   node_modules/builder-util/node_modules/fs-extra
    const parts = rel.split('/');
    let dir = '';
    let nmCount = 0;
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === 'node_modules') {
        nmCount++;
        // include the package name immediately after this segment
        const pkg = parts[i + 1];
        // handle scoped packages: @scope/name counts as two segments
        const pkgEnd = pkg && pkg.startsWith('@') ? i + 3 : i + 2;
        dir = parts.slice(0, pkgEnd).join('/');
        if (nmCount === 2) break;
      }
    }
    if (!dir) dir = rel;
    groups.add(dir);
  }
  return Array.from(groups).sort();
}

function main() {
  const missing = check();
  if (missing.length === 0) {
    if (process.env['VG_BUILD_DOCTOR_VERBOSE'] === '1') {
      // eslint-disable-next-line no-console
      console.log(`[build-doctor] ${CRITICAL_FILES.length} critical files present — OK`);
    }
    return 0;
  }

  const groups = suggestFix(missing);

  // eslint-disable-next-line no-console
  console.error('');
  // eslint-disable-next-line no-console
  console.error('[build-doctor] node_modules looks corrupted — missing files:');
  for (const rel of missing) {
    // eslint-disable-next-line no-console
    console.error(`  - ${rel}`);
  }
  // eslint-disable-next-line no-console
  console.error('');
  // eslint-disable-next-line no-console
  console.error('[build-doctor] suggested fix (cheaper than rm -rf node_modules):');
  // eslint-disable-next-line no-console
  console.error('');
  // eslint-disable-next-line no-console
  console.error(`  rm -rf ${groups.join(' ')}`);
  // eslint-disable-next-line no-console
  console.error('  npm install');
  // eslint-disable-next-line no-console
  console.error('');
  // eslint-disable-next-line no-console
  console.error('[build-doctor] context: repos on external/exFAT volumes occasionally lose');
  // eslint-disable-next-line no-console
  console.error('  individual files inside node_modules. See docs/Troubleshooting.md');
  // eslint-disable-next-line no-console
  console.error('  ("Build fails fast with MODULE_NOT_FOUND inside node_modules") for the');
  // eslint-disable-next-line no-console
  console.error('  full story.');
  // eslint-disable-next-line no-console
  console.error('');
  return 1;
}

// Exported for the unit test; otherwise side-effect main.
if (require.main === module) {
  process.exit(main());
}

module.exports = { check, suggestFix, CRITICAL_FILES };
