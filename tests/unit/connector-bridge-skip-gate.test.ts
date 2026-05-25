/**
 * Issue #28 — lock in the connector-bridge spec's skip-gate so a
 * future refactor doesn't reintroduce the "python3 present but
 * aiohttp missing → bridge helper crashes" CI failure mode.
 *
 * The spec under test (`tests/integration/connector-bridge.test.ts`)
 * is the actual integration spec. We can't easily exercise its skip
 * path from within vitest itself (we'd need to manipulate PATH /
 * mock spawnSync), so instead we do source-string assertions on the
 * `resolvePythonBin()` function. Same pattern as
 * `tests/unit/settings-header-structure.test.ts` and
 * `tests/unit/logo-a11y.test.ts` — cheap, fast, and catches a
 * refactor that drops the aiohttp probe.
 *
 * The assertions are kept tight enough that:
 *   - reverting to the pre-#28 version (no aiohttp probe) fails
 *     all three "probe" assertions
 *   - swapping `aiohttp` for any other module name fails the
 *     literal-string check
 *   - removing the fall-through-on-failure behaviour fails the
 *     `continue` check
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SPEC_SRC = join(
  HERE,
  '..',
  '..',
  'tests',
  'integration',
  'connector-bridge.test.ts',
);

function readSpec(): string {
  return readFileSync(SPEC_SRC, 'utf-8');
}

describe('connector-bridge skip-gate (issue #28)', () => {
  it('resolvePythonBin probes `import aiohttp` before returning a binary', () => {
    const src = readSpec();
    // The literal probe command — drift here is a real bug, not a
    // cosmetic concern, so the assertion is exact.
    expect(src).toMatch(/spawnSync\(bin,\s*\['-c',\s*'import aiohttp'\]/);
  });

  it('--version check still runs before the aiohttp probe (cheap-first)', () => {
    const src = readSpec();
    // Order matters: --version is the cheapest disqualifier (the bin
    // might not even be a Python). Swapping order would needlessly
    // spawn `bin -c "import aiohttp"` on broken interpreters.
    const versionIdx = src.indexOf("'--version'");
    const aiohttpIdx = src.indexOf("'import aiohttp'");
    expect(versionIdx).toBeGreaterThan(-1);
    expect(aiohttpIdx).toBeGreaterThan(-1);
    expect(versionIdx).toBeLessThan(aiohttpIdx);
  });

  it('falls through to the next candidate when --version fails', () => {
    const src = readSpec();
    // The early `continue` keeps the loop moving to `python` / `py`
    // when `python3` is broken. Without this we'd return null on the
    // first broken bin even if a later one works.
    expect(src).toMatch(/if \(version\.status !== 0\) continue;/);
  });

  it('returns the bin only when BOTH probes succeed', () => {
    const src = readSpec();
    // The conjunction of conditions: --version passes (via continue)
    // AND aiohttp.status === 0. This is what distinguishes a usable
    // Python from a present-but-incomplete one.
    expect(src).toMatch(/if \(aiohttp\.status === 0\) return bin;/);
  });

  it('still uses the original PYTHON_BIN === null skip-gate', () => {
    const src = readSpec();
    // The skip-gate name is the public contract — `describe.skipIf`
    // reads it. If someone renames or removes it the spec loses its
    // skip behaviour. (#28 only TIGHTENS what makes PYTHON_BIN null;
    // it doesn't replace the gate.)
    expect(src).toMatch(/const PYTHON_BIN\s*=\s*resolvePythonBin\(\);/);
    expect(src).toMatch(/const SKIP\s*=\s*PYTHON_BIN === null;/);
  });
});
