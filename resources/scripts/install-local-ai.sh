#!/usr/bin/env bash
# Voice Gateway — local AI setup
# Installs everything needed for 100 % local STT + TTS: whisper.cpp + piper-tts.
# Idempotent: re-running upgrades and never re-installs what's already there.
#
# Standalone usage:
#   curl -fsSL https://raw.githubusercontent.com/VivaldiCode/voice-gateway/main/resources/scripts/install-local-ai.sh | bash
# Or, from a checkout:
#   bash resources/scripts/install-local-ai.sh

set -euo pipefail

BOLD=$'\e[1m'; GREEN=$'\e[32m'; YELLOW=$'\e[33m'; RED=$'\e[31m'; DIM=$'\e[2m'; RESET=$'\e[0m'

ok()    { printf "${GREEN}✔${RESET} %s\n" "$1"; }
note()  { printf "${DIM}  %s${RESET}\n" "$1"; }
warn()  { printf "${YELLOW}!${RESET} %s\n" "$1"; }
fail()  { printf "${RED}✗${RESET} %s\n" "$1" >&2; exit 1; }

PIPER_VENV="${HOME}/Library/Application Support/Voice Gateway/piper/venv"
if [[ "$(uname -s)" != "Darwin" ]]; then
  # XDG on Linux.
  PIPER_VENV="${XDG_DATA_HOME:-${HOME}/.local/share}/voice-gateway/piper/venv"
fi

cat <<EOF
${BOLD}Voice Gateway — local AI installer${RESET}

This script will set up the offline brain of Voice Gateway on this machine:

  • ${BOLD}whisper.cpp${RESET}  — speech-to-text (Homebrew on macOS)
  • ${BOLD}piper-tts${RESET}    — text-to-speech  (Python venv at
                  ${PIPER_VENV})

No system-wide pip/brew packages are touched beyond installing whisper-cpp
on macOS. piper-tts lives inside the venv above and never leaks into your
shell. Voice models are downloaded by the app on first use.

EOF

# ---------- OS detection ----------
OS="$(uname -s)"
case "$OS" in
  Darwin)
    if ! command -v brew >/dev/null 2>&1; then
      fail "Homebrew not found. Install it first: https://brew.sh"
    fi
    ;;
  Linux) ;;
  *)
    fail "Unsupported OS: ${OS}"
    ;;
esac

# ---------- python3 ----------
if ! command -v python3 >/dev/null 2>&1; then
  if [[ "$OS" == "Darwin" ]]; then
    warn "python3 missing, installing via Homebrew"
    brew install python@3
  else
    fail "python3 is required. apt install python3 python3-venv python3-pip   (Debian/Ubuntu)"
  fi
fi

PY_VER=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
ok "python3 ${PY_VER} present"

# On Debian/Ubuntu, ensure the venv module actually works.
if ! python3 -c 'import venv, ensurepip' >/dev/null 2>&1; then
  if [[ "$OS" == "Linux" ]] && command -v apt-get >/dev/null 2>&1; then
    warn "python venv missing, installing python${PY_VER}-venv"
    sudo apt-get update -qq >/dev/null 2>&1 || true
    sudo apt-get install -y "python${PY_VER}-venv" || sudo apt-get install -y python3-venv
  else
    fail "python venv / ensurepip not available. Install the python venv package for your distro."
  fi
fi

# ---------- whisper.cpp ----------
if command -v whisper-cli >/dev/null 2>&1 || command -v whisper-cpp >/dev/null 2>&1; then
  ok "whisper.cpp already installed"
else
  if [[ "$OS" == "Darwin" ]]; then
    warn "Installing whisper.cpp via Homebrew"
    brew install whisper-cpp
    ok "whisper-cli installed"
  else
    warn "whisper.cpp must be built from source on Linux."
    note "Follow https://github.com/ggerganov/whisper.cpp#quick-start"
    note "then put the 'whisper-cli' (or 'main') binary on your PATH."
  fi
fi

# ---------- piper-tts in a venv ----------
if [[ -x "${PIPER_VENV}/bin/piper" ]]; then
  ok "piper-tts already installed at ${PIPER_VENV}"
  warn "Upgrading to latest"
  "${PIPER_VENV}/bin/pip" install --quiet --upgrade piper-tts || true
else
  warn "Creating venv at ${PIPER_VENV}"
  mkdir -p "$(dirname "${PIPER_VENV}")"
  python3 -m venv "${PIPER_VENV}"
  ok "venv ready"
  warn "Installing piper-tts (may take a minute the first time)"
  "${PIPER_VENV}/bin/pip" install --quiet --upgrade pip wheel
  "${PIPER_VENV}/bin/pip" install --quiet piper-tts
  ok "piper-tts installed"
fi

# Symlink piper into ~/.local/bin so the app's PATH-fix finds it without
# having to know about the venv path.
LINK_DIR="${HOME}/.local/bin"
mkdir -p "${LINK_DIR}"
ln -sf "${PIPER_VENV}/bin/piper" "${LINK_DIR}/piper"
ok "Linked piper → ${LINK_DIR}/piper"

cat <<EOF

${BOLD}${GREEN}All set.${RESET}

Re-open Voice Gateway. Settings → Voz will discover both whisper-cli and
piper, and voices download automatically on first use.

EOF
