# Contributing to Voice Gateway

## Pipeline (V2 — non-negotiable)

Every change lands through this five-step flow. Direct pushes to `main`
are blocked by branch protection (see [Repository rules](#repository-rules)
below). Quoted verbatim from the project rules to preserve intent:

> 1. Crie uma issue no GitHub e quero que detalhe ao máximo possível o
>    problema ou melhoria nesta issue — **apenas uma issue por problema**.
> 2. Depois crie uma branch no padrão de **gitflow** para resolver a
>    task em questão.
> 3. Depois faça o **PR para a main e associe ao issue**, dispare o
>    **sub-agente** para fazer o PR review do código. Se for encontrado
>    algum problema o sub-agente deve corrigir ele até estar resolvido
>    e **todos os testes passarem — Unit Test e E2E**. Resolva todos
>    os erros até tudo passar.
> 4. Gere uma **nova tag de versão** a cada vez que um PR for merged
>    com a main.
> 5. Gere uma **nova release** com base na main descrevendo a
>    atualização dela — **Windows, mac, linux**, tanto versões
>    **amd64 como arm** também.

### Operational rules

- **One issue per problem.** No grab-bag PRs.
- **Gitflow naming**:
  - `feature/<topic>-issue-<n>` — new functionality
  - `fix/<topic>-issue-<n>` — bug fix
  - `chore/<topic>-issue-<n>` — infrastructure / tooling
  - `docs/<topic>-issue-<n>` — documentation-only
- **PR body must contain `Closes #<n>`** so the issue auto-closes on merge.
- **Sub-agent verdict-and-fix loop**: a code-review sub-agent walks the
  diff, opens additional commits on the same branch to fix findings,
  and re-runs tests until everything is green. See
  [`docs/Agents.md`](docs/Agents.md) for the sub-agent contract.
- **Squash-merge** is the default. Keeps `main`'s history one-commit-per-PR.
- **Steps 4 + 5 are automated** by
  [`.github/workflows/auto-tag.yml`](.github/workflows/auto-tag.yml)
  (bumps semver from the squash-commit message and pushes `v<next>`)
  and [`.github/workflows/release.yml`](.github/workflows/release.yml)
  (6-way build matrix + single Release publish). The committer doesn't
  have to think about either.

### Exception: multi-context features → parent + sub-issues + ONE PR

Some features are coherent but span several sub-areas. Splitting them
across multiple PRs creates artificial coupling (PR B blocks on A,
B's CI runs against incomplete A, reviewer needs both diffs open).

The pattern:

1. **Parent issue** describes the whole feature in user-visible terms.
2. **Sub-issues** (one per sub-area) created and linked via GitHub's
   native sub-issue feature:
   ```bash
   SUB=$(gh issue create --title "feat(x): ..." --body "..." | grep -oP '/issues/\K\d+$')
   SUB_ID=$(gh api repos/{owner}/{repo}/issues/$SUB --jq .id)
   gh api -X POST repos/{owner}/{repo}/issues/$PARENT/sub_issues -F sub_issue_id=$SUB_ID
   ```
   Use `-F` (integer), not `-f` (string), for `sub_issue_id`.
3. **One PR** that closes the parent **and** all sub-issues
   (`Closes #N`, `Closes #N+1`, …). Commits inside the PR map to
   sub-issues so the diff stays reviewable in chunks.

Real example: PR #64 / issue #55 (multi-LLM) groups sub-issues #56–#63.

### When you receive a Kanban card link

Cards live on the
[Voice Gateway Project board](https://github.com/users/VivaldiCode/projects/1/).
When the user drops a card link in chat, the agent:

1. Reads the card (title, body, comments, labels).
2. Creates a GitHub issue mirroring the card, with an idempotency
   marker (`<!-- project:card-id -->`) so re-runs don't duplicate.
3. Cross-links — comments the issue number on the card; the issue body
   links the card URL.
4. Decides: single issue or parent + sub-issues (the exception above).
5. Proceeds with steps 2 → 5 of the pipeline.

The agent never asks for the pipeline rules to be repeated — they live
in this file and in `docs/Agents.md`, both of which every sub-agent
loads as a pre-flight requirement.

### Bump rule (auto-tag)

`auto-tag.yml` reads the squash-commit subject:

| Subject pattern | Bump |
|---|---|
| `feat:` / `feat(scope):` | minor |
| `feat!:` / commit body contains `BREAKING CHANGE` | major |
| `fix:` / `chore:` / `docs:` / `refactor:` / anything else | patch |

To skip the tag for a specific merge (e.g. a doc-only fix that doesn't
deserve a release), include `[skip-tag]` anywhere in the squash commit
message.

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
