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
#
# Flags:
#   --dry-run                Print what would be copied + committed but don't push.
#   --wiki-remote URL        Override WIKI_REMOTE for testing against a fork.
#   --help, -h               Show this help.

set -euo pipefail

WIKI_REMOTE="${WIKI_REMOTE:-https://github.com/VivaldiCode/voice-gateway.wiki.git}"
DRY_RUN=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --wiki-remote) WIKI_REMOTE="$2"; shift 2 ;;
    --wiki-remote=*) WIKI_REMOTE="${1#--wiki-remote=}"; shift ;;
    --help|-h)
      grep -E '^# ' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *)
      echo "unknown flag: $1" >&2
      exit 2
      ;;
  esac
done

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
# Copy every markdown file in docs/ EXCEPT this README (describes the
# sync flow — irrelevant in the wiki). Walks two levels deep so future
# subdirectories of docs/ don't silently drop pages from the wiki.
copied=0
while IFS= read -r -d '' src; do
  dst_name="$(basename -- "$src")"
  cp -p "$src" "${WORK_DIR}/wiki/${dst_name}"
  echo "    ${dst_name}"
  copied=$((copied + 1))
done < <(
  find "${DOCS_DIR}" -maxdepth 2 -type f -name '*.md' \
    ! -name 'README.md' \
    -print0
)
echo "→ copied ${copied} markdown file(s)"

# Convenience: surface _Sidebar.md / _Footer.md if the project keeps them
# in docs/. GitHub wikis pick these up automatically.
for special in "_Sidebar.md" "_Footer.md"; do
  if [[ -f "${DOCS_DIR}/${special}" ]]; then
    cp -p "${DOCS_DIR}/${special}" "${WORK_DIR}/wiki/${special}"
  fi
done

cd "${WORK_DIR}/wiki"
if [[ -z "$(git status --porcelain)" ]]; then
  echo "✔ wiki already up to date — nothing to commit"
  exit 0
fi

if [[ -n "${DRY_RUN}" ]]; then
  echo "── dry-run: would commit the following changes ──"
  git status --short
  echo "(skipping push because --dry-run)"
  exit 0
fi

git add -A
git -c user.name='voice-gateway-bot' \
    -c user.email='wiki-sync@voice-gateway.local' \
    commit -m "docs: sync from main@${MAIN_SHA}" >/dev/null
git push origin HEAD:master 2>&1 || git push origin HEAD:main 2>&1
echo "✔ pushed docs to ${WIKI_REMOTE}"
