# docs/ — source of truth for the Voice Gateway wiki

The files in this folder are the **canonical source** for the
[Voice Gateway wiki](https://github.com/VivaldiCode/voice-gateway/wiki).
We keep them in the main repo so they are pull-requestable, reviewable,
and version-locked to the code they document.

## Layout (GitHub Wiki convention)

| File                  | Role                                                      |
|-----------------------|-----------------------------------------------------------|
| `Home.md`             | Wiki landing page.                                        |
| `Setup.md`            | End-to-end install walkthrough.                           |
| `Architecture.md`     | Module map and design rationale.                          |
| `Protocol.md`         | WebSocket protocol spec.                                  |
| `Troubleshooting.md`  | Common failure modes.                                     |
| `_Sidebar.md`         | Navigation rendered on every wiki page.                   |
| `_Footer.md`          | Footer rendered on every wiki page.                       |

Page filenames map directly to wiki URLs: `Setup.md` →
`/wiki/Setup`. Internal links use the GitHub `[[Page]]` syntax so they
keep working both in the repo (rendered as plain text) and in the wiki.

## Publishing to the wiki

The GitHub wiki is a separate git repo:
`https://github.com/VivaldiCode/voice-gateway.wiki.git`. After enabling
the wiki once on the GitHub UI ("Settings → Features → Wikis"), use the
helper script to push these files:

```bash
./docs/sync-wiki.sh
```

The script clones the wiki repo into a temp directory, rsyncs the `.md`
files from `docs/` into it, commits with a message tying the snapshot to
the current git SHA, and pushes. It is safe to run repeatedly —
re-running just creates a new "docs: sync from main@<sha>" commit on the
wiki repo.

## Editing locally

Just edit the markdown. Two conventions worth keeping:

1. **Inter-page links use wiki syntax**: `[[Setup]]`, `[[Protocol]]`. The
   GitHub web UI also renders them in the repo view, so the two views
   stay consistent.
2. **External URLs use standard markdown**: `[link](https://example.com)`.

## Why not just use the GitHub Wiki UI?

- No code review on documentation changes.
- The wiki repo is separate so it can drift from the code, which is
  exactly what we want to avoid for protocol/architecture docs.
- Contributors can't open PRs against the wiki — only with this layout do
  they get a normal review flow.
