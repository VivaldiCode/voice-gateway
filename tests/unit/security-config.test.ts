/**
 * Issue #22 — lock in the security configuration so a future
 * "let me clean up the workflows" PR doesn't quietly delete the
 * scanning / audit / SHA-pinning we set up.
 *
 * These are file-shape assertions, not behaviour tests — the actual
 * GitHub-side behaviour (CodeQL findings, Dependabot PRs, blocked
 * pushes for secrets) is tested by sacrificial PRs (see the issue's
 * acceptance criteria) and lives in the repo's Security tab.
 *
 * What we catch here:
 *   - SECURITY.md exists at repo root + is non-trivial
 *   - .github/dependabot.yml exists + covers npm, pip, github-actions
 *   - .github/workflows/codeql.yml exists + analyses
 *     javascript-typescript + python
 *   - .github/workflows/ci.yml has the dependency-review job + npm
 *     audit step + pip-audit step
 *   - Every `uses:` in ci.yml pins to a 40-char hex SHA, NOT a floating
 *     tag (e.g. `actions/checkout@v4` is BAD — a compromised tag
 *     re-point could swap behaviour silently). Comment after the SHA
 *     names the version for human readability.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf-8');
}

describe('security configuration (issue #22)', () => {
  it('SECURITY.md exists at the repo root + documents disclosure channel', () => {
    expect(existsSync(join(ROOT, 'SECURITY.md'))).toBe(true);
    const src = read('SECURITY.md');
    // Required pieces — drift here means the disclosure flow broke.
    expect(src).toMatch(/Security Policy/i);
    expect(src).toMatch(/Reporting a vulnerability/i);
    expect(src).toMatch(/Security Advisories/i);
    expect(src.length).toBeGreaterThan(500);
  });

  it('SECURITY.md is linked from README so users find it', () => {
    const readme = read('README.md');
    expect(readme).toMatch(/SECURITY\.md/);
  });

  it('Dependabot covers all three ecosystems we ship', () => {
    expect(existsSync(join(ROOT, '.github/dependabot.yml'))).toBe(true);
    const src = read('.github/dependabot.yml');
    expect(src).toMatch(/package-ecosystem:\s*['"]npm['"]/);
    expect(src).toMatch(/package-ecosystem:\s*['"]pip['"]/);
    expect(src).toMatch(/package-ecosystem:\s*['"]github-actions['"]/);
    // Weekly cadence is the choice we want to lock in — daily floods
    // the inbox, monthly is too slow for CVE response.
    expect(src).toMatch(/interval:\s*['"]weekly['"]/);
  });

  it('CodeQL workflow analyses both languages we use', () => {
    expect(existsSync(join(ROOT, '.github/workflows/codeql.yml'))).toBe(true);
    const src = read('.github/workflows/codeql.yml');
    expect(src).toMatch(/['"]javascript-typescript['"]/);
    expect(src).toMatch(/['"]python['"]/);
    // security-extended is the query pack we picked. Drift would
    // silently demote the analysis to default.
    expect(src).toMatch(/queries:\s*security-extended/);
  });

  it('ci.yml has the Dependency Review job + npm audit + pip-audit', () => {
    const src = read('.github/workflows/ci.yml');
    expect(src).toContain('dependency-review-action');
    expect(src).toContain('fail-on-severity: high');
    expect(src).toMatch(/npm audit --audit-level=high/);
    // pip-audit is invoked inside the pytest job.
    expect(src).toMatch(/pip-audit/);
  });

  it('every GitHub Action in ci.yml is pinned to a 40-char SHA, not a floating tag', () => {
    const src = read('.github/workflows/ci.yml');
    // Match every `uses:` line (skip self-referential `uses:` inside
    // comments or quoted strings — none exist in this file but stay
    // defensive). Action references look like `owner/repo@<ref>` or
    // `owner/repo/sub@<ref>`.
    const usesRe = /^\s*-?\s*uses:\s*([^\s#]+)/gm;
    const refs: string[] = [];
    for (const m of src.matchAll(usesRe)) {
      const value = m[1];
      if (value !== undefined) refs.push(value);
    }
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      // Each ref must be `owner/repo@<sha>` where sha is 40 hex chars.
      // Tag references (`@v4`) are explicitly rejected to enforce the
      // pinning policy from issue #22.
      expect(ref, `action ref "${ref}" should be pinned to a 40-char commit SHA`).toMatch(
        /^[\w./-]+@[0-9a-f]{40}$/,
      );
    }
  });

  it('codeql.yml uses pinned SHAs for the CodeQL action (same policy)', () => {
    const src = read('.github/workflows/codeql.yml');
    const usesRe = /^\s*-?\s*uses:\s*([^\s#]+)/gm;
    const refs: string[] = [];
    for (const m of src.matchAll(usesRe)) {
      const value = m[1];
      if (value !== undefined) refs.push(value);
    }
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref).toMatch(/^[\w./-]+@[0-9a-f]{40}$/);
    }
  });
});
