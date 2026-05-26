/**
 * Issue #21 — lock in the branch protection config so an accidental
 * edit (deleting a required status check, flipping `enforce_admins`,
 * allowing force-push) gets caught at vitest speed instead of going
 * unnoticed until the next emergency.
 *
 * The actual GitHub-side rule has to be re-applied with `gh api`
 * after every commit that changes this file — but the JSON is the
 * canonical source of truth, so testing it is testing the policy.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(HERE, '..', '..', '.github', 'branch-protection.json');

interface BranchProtection {
  required_status_checks: { strict: boolean; contexts: string[] };
  enforce_admins: boolean;
  required_pull_request_reviews: {
    dismiss_stale_reviews: boolean;
    required_approving_review_count: number;
  };
  required_linear_history: boolean;
  allow_force_pushes: boolean;
  allow_deletions: boolean;
  required_conversation_resolution: boolean;
}

function load(): BranchProtection {
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as BranchProtection;
}

describe('branch protection config (issue #21)', () => {
  it('requires every CI job as a status check', () => {
    const cfg = load();
    const ctx = cfg.required_status_checks.contexts;
    // Drift here would let a PR with red CI merge — the whole point
    // of the policy. Each context name must match the job's `name:`
    // in .github/workflows/ci.yml exactly.
    expect(ctx).toContain('Lint + typecheck (Node 22)');
    expect(ctx).toContain('Vitest (Node 20)');
    expect(ctx).toContain('Vitest (Node 22)');
    expect(ctx).toContain('Pytest — hermes-voice-bridge');
    expect(ctx).toContain('Playwright E2E (packaged .app, headless)');
  });

  it('strict mode is on — branches must be up to date before merge', () => {
    expect(load().required_status_checks.strict).toBe(true);
  });

  it('linear history is required (no merge commits on main)', () => {
    expect(load().required_linear_history).toBe(true);
  });

  it('force-push and branch deletion are disabled on main', () => {
    const cfg = load();
    expect(cfg.allow_force_pushes).toBe(false);
    expect(cfg.allow_deletions).toBe(false);
  });

  it('admins are not exempt', () => {
    // enforce_admins=true means even the repo owner has to land
    // through a PR. The user policy is explicit about this.
    expect(load().enforce_admins).toBe(true);
  });

  it('stale approvals are dismissed when new commits push', () => {
    expect(load().required_pull_request_reviews.dismiss_stale_reviews).toBe(true);
  });

  it('conversation threads must be resolved before merge', () => {
    expect(load().required_conversation_resolution).toBe(true);
  });
});
