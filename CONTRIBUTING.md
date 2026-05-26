# Contributing to Voice Gateway

## Pipeline

Every change lands through a PR. Direct pushes to `main` are blocked
by branch protection (see [Repository rules](#repository-rules) below).

For each piece of work — bug, improvement, refactor:

1. **Open a GitHub issue** describing the problem or improvement in
   detail. One issue per problem.
2. **Branch from `main`** using gitflow naming:
   - `feature/<topic>-issue-<n>` for new functionality
   - `fix/<topic>-issue-<n>` for bug fixes
   - `chore/<topic>` for infrastructure / tooling
   - `docs/<topic>` for documentation-only changes
3. **Open a PR** to `main`, link the issue with `Closes #<n>` in the
   description so it auto-closes on merge.
4. **Review pass**: a code-review sub-agent (or human reviewer) walks
   the diff, flags issues, fixes them in additional commits on the
   same branch, and re-runs tests until everything is green.
5. **Merge**: only when **every** required CI check is green AND every
   review thread is resolved. Squash-merge is the default — keeps
   `main`'s history linear.

## Repository rules

`main` is protected:

| Rule | Why |
|------|-----|
| **Require status checks** — all 5 CI jobs (Lint+typecheck, Vitest 20, Vitest 22, Pytest, Playwright) must pass before merge | The "all tests green" gate from the user pipeline. Pre-existing flakes get skipped on CI with explicit `test.skip(VG_E2E_HEADLESS, ...)` markers — never left as silent failures. |
| **Strict mode** — branches must be up-to-date with `main` before merge | Catches semantic conflicts that a textual merge wouldn't (e.g. type rename that one branch missed). |
| **Require PR** before merging | No direct pushes to `main`. Every change is traceable through a PR. |
| **Linear history** | Disallows merge commits. Forces squash or rebase merges. Makes `git log --oneline` actually useful. |
| **Require conversation resolution** | All review comments must be marked resolved before merge. |
| **Dismiss stale approvals on push** | If new commits land after a PR was approved, the approval is dismissed so the reviewer sees the updated diff. |
| **Disallow force-push and branch deletion** on `main` | Defence in depth against accidents + supply-chain attacks. |
| **Enforce on admins** | Even the project owner has to land through a PR. Flip to `false` in an emergency (e.g. broken `main`). |

The exact JSON config is committed at
[`.github/branch-protection.json`](./.github/branch-protection.json)
so the policy can be re-applied (or audited) at any time with:

```bash
gh api -X PUT repos/VivaldiCode/voice-gateway/branches/main/protection \
  --input .github/branch-protection.json
```

## Skipping tests

We **never** delete a flaky test as a fix. The two acceptable
mitigations are:

1. **Fix the root cause** — the right answer when feasible.
2. **`test.skip(condition, 'see issue #N')`** — when the root cause
   needs deeper investigation and would block unrelated work. The
   condition gates the skip to a specific environment (typically
   `process.env.VG_E2E_HEADLESS === '1'` for headless-only flakes)
   so the spec still runs locally; the issue reference makes the
   deferred work tracked, not forgotten.

A blanket `test.skip()` with no condition or issue reference will
not pass review.

## Running the tests locally

```bash
npm run typecheck   # tsc --noEmit on main + renderer
npm run lint        # eslint --max-warnings=0
npm test            # vitest (unit + integration)
npm run test:e2e    # playwright + electron (needs `npm run build:mac` first)
```

For the bridge:

```bash
cd server/hermes-voice-bridge
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
pytest -q
```

## Security

Don't open public issues for security problems — see
[SECURITY.md](./SECURITY.md) for the private disclosure flow.
