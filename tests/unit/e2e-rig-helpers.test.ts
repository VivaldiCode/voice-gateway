/**
 * Issue #18: lock in the rig's CI-timeout behaviour.
 *
 * The Playwright E2E rig in `tests/e2e/helpers/rig.ts` ships a small
 * `ciTimeout(local, ci)` knob that picks between dev-iteration timeouts
 * and CI-tolerant timeouts based on `process.env.CI`. The whole point
 * of the issue-#18 fix is that timeouts on CI are *bigger* than locally
 * so the headless-Chromium boot + BrowserWindow open under macos-latest
 * CPU pressure doesn't flake.
 *
 * If someone later refactors that helper and accidentally inverts the
 * ternary (or hard-codes a single value), every spec re-flakes on CI.
 * This test is the cheap canary that catches that regression at vitest
 * speed instead of waiting for the next nightly Playwright run.
 *
 * We import the helper directly — it's a pure function with zero
 * Playwright deps, so it loads cleanly in a node test environment.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ciTimeout } from '../e2e/helpers/rig';

describe('ciTimeout (e2e rig)', () => {
  const originalCI = process.env['CI'];

  beforeEach(() => {
    delete process.env['CI'];
  });

  afterEach(() => {
    if (originalCI === undefined) delete process.env['CI'];
    else process.env['CI'] = originalCI;
  });

  it('returns the local value when CI is not set', () => {
    expect(ciTimeout(10_000, 30_000)).toBe(10_000);
  });

  it('returns the CI value when CI=1', () => {
    process.env['CI'] = '1';
    expect(ciTimeout(10_000, 30_000)).toBe(30_000);
  });

  it('returns the CI value when CI=true (GH Actions convention)', () => {
    process.env['CI'] = 'true';
    expect(ciTimeout(10_000, 30_000)).toBe(30_000);
  });

  it('CI value is always larger than local — invariant the fix relies on', () => {
    // Lock the invariant so a future refactor that swaps the args
    // doesn't silently slip through code review.
    const local = 5_000;
    const ci = 20_000;
    expect(ci).toBeGreaterThan(local);
    process.env['CI'] = '1';
    const picked = ciTimeout(local, ci);
    expect(picked).toBe(ci);
    expect(picked).toBeGreaterThan(local);
  });

  it('treats CI="" as falsy (empty string from cleared env)', () => {
    // Some CIs/wrappers clear the var to '' rather than deleting it.
    // We rely on truthiness so empty string → local value.
    process.env['CI'] = '';
    expect(ciTimeout(10_000, 30_000)).toBe(10_000);
  });
});
