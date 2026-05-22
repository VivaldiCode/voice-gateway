#!/usr/bin/env bash
# docs/sync-wiki.sh — push the contents of docs/ to the GitHub wiki repo.
#
# Requires:
#   - git
#   - write access to https://github.com/VivaldiCode/voice-gateway.wiki.git
#     (the wiki must be enabled once on the repo settings page, otherwise
#     the wiki repo doesn't exist yet and the clone fails)
#
# Re-run as often as you like; each run produces one commit on the wiki
# repo tying it to the current main-repo SHA.

set -euo pipefail

WIKI_REMOTE="${WIKI_REMOTE:-https://github.com/VivaldiCode/voice-gateway.wiki.git}"
DOCS_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null && pwd)"
REPO_ROOT="$(cd -- "${DOCS_DIR}/.." >/dev/null && pwd)"

if ! command -v git >/dev/null 2>&1; then
  echo "git is required" >&2
  exit 1
fi

cd "${REPO_ROOT}"
MAIN_SHA="$(git rev-parse --short HEAD)"

WORK_DIR="$(mktemp -d -t vg-wiki-XXXXXX)"
trap 'rm -rf "${WORK_DIR}"' EXIT

echo "→ cloning ${WIKI_REMOTE}"
if ! git clone --depth=1 "${WIKI_REMOTE}" "${WORK_DIR}/wiki" 2>&1; then
  cat >&2 <<EOF

Could not clone the wiki repo. Most common cause: the wiki hasn't been
initialised yet. To fix:

  1. Open https://github.com/VivaldiCode/voice-gateway/wiki
  2. Click "Create the first page" and save it (any content is fine).
  3. Re-run this script.
EOF
  exit 1
fi

echo "→ syncing markdown into wiki working copy"
# Copy every markdown file in docs/ EXCEPT this README (which describes the
# sync flow itself — irrelevant in the wiki) and this script.
find "${DOCS_DIR}" -maxdepth 1 -type f -name '*.md' \
  ! -name 'README.md' \
  -exec cp -p {} "${WORK_DIR}/wiki/" \;

cd "${WORK_DIR}/wiki"
if [[ -z "$(git status --porcelain)" ]]; then
  echo "✔ wiki already up to date — nothing to commit"
  exit 0
fi

git add -A
git -c user.name='voice-gateway-bot' \
    -c user.email='wiki-sync@voice-gateway.local' \
    commit -m "docs: sync from main@${MAIN_SHA}" >/dev/null
git push origin HEAD:master 2>&1 || git push origin HEAD:main 2>&1
echo "✔ pushed docs to ${WIKI_REMOTE}"
