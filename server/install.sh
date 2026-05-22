#!/usr/bin/env bash
# Voice Gateway — Hermes Voice Bridge installer.
# Idempotent: re-running upgrades the package and preserves the existing token.

set -euo pipefail

# Canonical raw URL for piped installs (`curl ... | bash`). Used to re-fetch
# this script under sudo when we cannot exec ourselves directly.
INSTALL_SCRIPT_URL="${INSTALL_SCRIPT_URL:-https://raw.githubusercontent.com/VivaldiCode/voice-gateway/main/server/install.sh}"

# ---------- pretty printing ----------
BOLD=$'\e[1m'
DIM=$'\e[2m'
RESET=$'\e[0m'
GREEN=$'\e[32m'
YELLOW=$'\e[33m'
RED=$'\e[31m'

banner() {
  cat <<EOF
${BOLD}Voice Gateway — Hermes Voice Bridge installer${RESET}

This script will:

  • Install a small Python service in /opt/hermes-voice-bridge
  • Write a config file at /etc/hermes-voice-bridge/config.toml
  • Create a system user 'hermes-voice' (no shell)
  • Enable a systemd service called hermes-voice-bridge
  • Print a one-line pairing token for the desktop app

Running on:  $(uname -s) $(uname -r)
Working dir: $(pwd)

EOF
}

ok()    { printf "${GREEN}✔${RESET} %s\n" "$1"; }
warn()  { printf "${YELLOW}!${RESET} %s\n" "$1"; }
fail()  { printf "${RED}✗${RESET} %s\n" "$1" >&2; exit 1; }
note()  { printf "${DIM}%s${RESET}\n" "$1"; }

# ---------- preflight ----------
if [[ "$(uname -s)" != "Linux" ]]; then
  fail "This installer supports Linux only. On macOS run hermes-voice-bridge in a development venv (see server/hermes-voice-bridge/README.md)."
fi

if [[ $EUID -ne 0 ]]; then
  if ! command -v sudo >/dev/null 2>&1; then
    fail "Root privileges required (no sudo found)."
  fi
  # When invoked via `curl ... | bash`, $0 is literally "bash" (or the path
  # of the shell), not a script file. `exec sudo -E bash "$0"` would then
  # try to execute the bash binary as a script and fail with
  # "cannot execute binary file". Detect that case and re-fetch ourselves
  # over the wire instead of trying to re-exec a missing file.
  if [[ -f "$0" ]] && [[ -r "$0" ]] && [[ "$(basename "$0")" != "bash" ]]; then
    exec sudo -E bash "$0" "$@"
  fi
  if ! command -v curl >/dev/null 2>&1; then
    fail "Detected a piped install but curl is missing — install curl and retry, or download the script first."
  fi
  warn "re-fetching installer under sudo (piped install detected)"
  exec sudo -E env "INSTALL_SCRIPT_URL=${INSTALL_SCRIPT_URL}" bash -c \
    "bash <(curl -fsSL \"\$INSTALL_SCRIPT_URL\") $(printf '%q ' "$@")"
fi

if ! command -v systemctl >/dev/null 2>&1; then
  fail "systemd is required. (Found no 'systemctl' in PATH.)"
fi

check_python() {
  if ! command -v python3 >/dev/null 2>&1; then
    fail "python3 is required. Install it first: apt install python3 python3-venv python3-pip"
  fi
  local ver
  ver=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
  case "$ver" in
    3.10|3.11|3.12|3.13|3.14) ok "python3 ${ver} found";;
    *) fail "python3 >=3.10 required, found ${ver}";;
  esac
  python3 -c "import venv" 2>/dev/null || fail "python3-venv missing. Install: apt install python3-venv"
}

# ---------- args / prompts ----------
DEFAULT_BRIDGE_PORT=8765
DEFAULT_HERMES_URL="http://localhost:8000"

BRIDGE_PORT="${BRIDGE_PORT:-$DEFAULT_BRIDGE_PORT}"
HERMES_URL="${HERMES_URL:-$DEFAULT_HERMES_URL}"
ASSUME_YES="${ASSUME_YES:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes|-y) ASSUME_YES=1; shift;;
    --port) BRIDGE_PORT="$2"; shift 2;;
    --hermes-url) HERMES_URL="$2"; shift 2;;
    --help|-h)
      sed -n '1,30p' "$0"
      exit 0;;
    *) fail "Unknown argument: $1";;
  esac
done

banner
check_python

if [[ -z "$ASSUME_YES" ]]; then
  read -r -p "Bridge listen port [${BRIDGE_PORT}]: " answer || true
  [[ -n "${answer:-}" ]] && BRIDGE_PORT="$answer"
  read -r -p "Local Hermes API URL [${HERMES_URL}]: " answer || true
  [[ -n "${answer:-}" ]] && HERMES_URL="$answer"
  printf "\nProceed with install? [y/N] "
  read -r confirm
  [[ "$confirm" =~ ^[yY] ]] || { warn "Aborted."; exit 0; }
fi

# ---------- prepare layout ----------
INSTALL_DIR=/opt/hermes-voice-bridge
CONFIG_DIR=/etc/hermes-voice-bridge
CONFIG_FILE=${CONFIG_DIR}/config.toml
LOG_DIR=/var/log/hermes-voice-bridge
SERVICE_USER=hermes-voice

if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
  ok "created system user ${SERVICE_USER}"
else
  ok "system user ${SERVICE_USER} already exists"
fi

mkdir -p "$INSTALL_DIR" "$CONFIG_DIR" "$LOG_DIR"
chown -R "$SERVICE_USER":"$SERVICE_USER" "$LOG_DIR"

# ---------- copy source ----------
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null && pwd)"
SRC_PKG="${SCRIPT_DIR}/hermes-voice-bridge"

if [[ ! -d "$SRC_PKG" ]]; then
  # Allow piped install: clone into a temp dir.
  warn "package sources not co-located; cloning repository"
  TMPDIR=$(mktemp -d)
  git clone --depth=1 https://github.com/VivaldiCode/voice-gateway "$TMPDIR" 2>/dev/null \
    || fail "git clone failed; pass --src-dir or run from a checkout"
  SRC_PKG="$TMPDIR/server/hermes-voice-bridge"
fi

cp -R "$SRC_PKG/." "$INSTALL_DIR/"

# ---------- python venv ----------
VENV="$INSTALL_DIR/venv"
if [[ ! -d "$VENV" ]]; then
  python3 -m venv "$VENV"
  ok "created virtualenv"
fi
"$VENV/bin/pip" install --upgrade pip wheel >/dev/null
"$VENV/bin/pip" install --upgrade "$INSTALL_DIR" >/dev/null
ok "installed hermes-voice-bridge"

# ---------- config ----------
if [[ -f "$CONFIG_FILE" ]]; then
  EXISTING_TOKEN=$(grep -E '^token *=' "$CONFIG_FILE" | head -n1 | sed -E 's/.*"([^"]+)".*/\1/')
  ok "reusing existing token from ${CONFIG_FILE}"
else
  EXISTING_TOKEN=$(python3 - <<'PY'
import secrets, base64
print(base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode())
PY
  )
  ok "generated new pairing token"
fi

cat > "$CONFIG_FILE" <<EOF
# Generated by install.sh — re-runs preserve the token.
[bridge]
host = "0.0.0.0"
port = ${BRIDGE_PORT}
token = "${EXISTING_TOKEN}"

[hermes]
base_url = "${HERMES_URL}"
request_timeout = 30
EOF
chmod 600 "$CONFIG_FILE"
chown root:"$SERVICE_USER" "$CONFIG_FILE"

# ---------- systemd ----------
UNIT_SRC="$INSTALL_DIR/systemd/hermes-voice-bridge.service"
UNIT_DST=/etc/systemd/system/hermes-voice-bridge.service
install -m 644 "$UNIT_SRC" "$UNIT_DST"
systemctl daemon-reload
systemctl enable hermes-voice-bridge >/dev/null
systemctl restart hermes-voice-bridge
sleep 1
if systemctl is-active --quiet hermes-voice-bridge; then
  ok "service is running"
else
  warn "service did not start cleanly; check 'journalctl -u hermes-voice-bridge -n 80'"
fi

# ---------- pairing token banner ----------
HOST_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
[[ -z "$HOST_IP" ]] && HOST_IP=$(hostname)

cat <<EOF

${BOLD}╔══════════════════════════════════════════════════════════════╗${RESET}
${BOLD}║              PAIRING TOKEN — copy to the desktop app              ║${RESET}
${BOLD}╚══════════════════════════════════════════════════════════════╝${RESET}

  Bridge URL:  ${BOLD}ws://${HOST_IP}:${BRIDGE_PORT}${RESET}
  Token:       ${BOLD}${EXISTING_TOKEN}${RESET}

Useful commands:
  systemctl status hermes-voice-bridge
  journalctl -fu hermes-voice-bridge
  sudo ${SCRIPT_DIR}/uninstall.sh

EOF
