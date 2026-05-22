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

# Show --help / -h immediately — works on any OS, without root.
for arg in "$@"; do
  case "$arg" in
    --help|-h)
      cat <<'EOF'
Voice Gateway — Hermes Voice Bridge installer.

Usage:
  curl -fsSL https://raw.githubusercontent.com/VivaldiCode/voice-gateway/main/server/install.sh | bash
  sudo bash install.sh [--yes] [--port PORT] [--hermes-url URL]

Options:
  --yes, -y               Skip interactive prompts (use defaults / env vars).
  --port PORT             Bridge listen port (default 8765).
  --hermes-url URL        Local Hermes API base URL (default http://localhost:8000).
  --help, -h              Show this help.

Environment overrides:
  BRIDGE_PORT, HERMES_URL, ASSUME_YES, INSTALL_SCRIPT_URL.
EOF
      exit 0
      ;;
  esac
done

# ---------- preflight ----------
if [[ "$(uname -s)" != "Linux" ]]; then
  fail "This installer supports Linux only. On macOS run hermes-voice-bridge in a development venv (see server/hermes-voice-bridge/README.md)."
fi

# ---------- privilege escalation ----------
#
# Three valid entry points, all of which must work:
#
#   (a) sudo bash server/install.sh           — running as root from a clone
#   (b) bash server/install.sh                — running as user from a clone
#   (c) curl -fsSL <url> | bash               — running as user, piped via curl
#
# In (b) we re-exec via `sudo bash "$0"`; in (c) `$0` is literally "bash"
# (the shell binary), so `sudo bash "$0"` would try to run the bash ELF as
# a script and fail with "cannot execute binary file". The fix: detect the
# piped case, download a fresh copy to /tmp, then sudo-exec that file
# with the original argv preserved.
escalate_via_tempfile() {
  if ! command -v curl >/dev/null 2>&1; then
    fail "Piped install detected but 'curl' is missing — install curl and retry, or download the script first."
  fi
  local tmp
  tmp="$(mktemp -t vg-install.XXXXXX 2>/dev/null || mktemp /tmp/vg-install.XXXXXX)"
  if ! curl -fsSL "${INSTALL_SCRIPT_URL}" -o "${tmp}"; then
    rm -f "${tmp}"
    fail "Could not re-download installer from ${INSTALL_SCRIPT_URL}"
  fi
  chmod 0700 "${tmp}"
  warn "elevating privileges — sudo will ask for your password if needed"
  exec sudo -E bash "${tmp}" "$@"
}

if [[ $EUID -ne 0 ]]; then
  if ! command -v sudo >/dev/null 2>&1; then
    fail "Root privileges required and no 'sudo' on PATH. Re-run as root:  su -c 'bash install.sh'"
  fi
  if [[ -f "$0" ]] && [[ -r "$0" ]] && [[ "$(basename -- "$0")" != "bash" ]]; then
    # Case (b): real script file on disk — just sudo-re-exec it.
    exec sudo -E bash "$0" "$@"
  fi
  # Case (c): piped install — fetch a temp copy and sudo-exec that.
  escalate_via_tempfile "$@"
fi

# ---------- now running as root ----------

# If we were re-exec'd from a /tmp copy, self-delete on exit so we leave
# nothing behind.
if [[ "$(dirname -- "$0")" == "/tmp" ]] && [[ "$(basename -- "$0")" == vg-install.* ]]; then
  trap 'rm -f -- "$0"' EXIT
fi

# ---------- package manager auto-install ----------
#
# Detect the distro's package manager and offer to install missing
# dependencies. The user is prompted once per package (default Yes) so a
# bare-bones Debian/Ubuntu box can be brought up without leaving the
# installer.

detect_pkg_manager() {
  for cmd in apt-get dnf yum pacman apk zypper; do
    if command -v "$cmd" >/dev/null 2>&1; then
      printf '%s\n' "$cmd"
      return 0
    fi
  done
  return 1
}

PKG_MGR="$(detect_pkg_manager 2>/dev/null || true)"
APT_UPDATED=""

pkg_install_one() {
  local pkg="$1"
  case "$PKG_MGR" in
    apt-get)
      if [[ -z "$APT_UPDATED" ]]; then
        DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null 2>&1 || true
        APT_UPDATED=1
      fi
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$pkg" >/dev/null 2>&1
      ;;
    dnf)    dnf install -y "$pkg" >/dev/null 2>&1 ;;
    yum)    yum install -y "$pkg" >/dev/null 2>&1 ;;
    pacman) pacman -Sy --noconfirm --needed "$pkg" >/dev/null 2>&1 ;;
    apk)    apk add --no-cache "$pkg" >/dev/null 2>&1 ;;
    zypper) zypper --non-interactive install "$pkg" >/dev/null 2>&1 ;;
    *)      return 127 ;;
  esac
}

# ensure_installed FRIENDLY_NAME CHECK_CMD PACKAGE [ALTERNATIVE_PACKAGE...]
# CHECK_CMD must succeed (exit 0) when FRIENDLY_NAME is already satisfied.
# Each PACKAGE is tried in order; the first one whose install makes
# CHECK_CMD pass wins. Prompts the user before installing unless
# ASSUME_YES is set.
ensure_installed() {
  local name="$1" check="$2"
  shift 2
  if eval "$check" >/dev/null 2>&1; then
    return 0
  fi
  if [[ -z "$PKG_MGR" ]]; then
    fail "Required: ${name}. Couldn't detect a supported package manager — install '$*' manually and re-run."
  fi
  warn "missing required dependency: ${name}"
  if [[ -z "${ASSUME_YES:-}" ]]; then
    local ans
    printf "  install via %s now? [Y/n] " "$PKG_MGR"
    if ! read -r ans </dev/tty 2>/dev/null; then
      ans="Y"   # no tty (piped) → assume yes
    fi
    case "${ans:-Y}" in
      [yY]*|"") ;;
      *) fail "cannot continue without ${name}. Install '$*' and re-run." ;;
    esac
  fi
  local pkg attempted=()
  for pkg in "$@"; do
    attempted+=("$pkg")
    printf "  → installing %s … " "$pkg"
    if pkg_install_one "$pkg"; then
      if eval "$check" >/dev/null 2>&1; then
        printf "ok\n"
        ok "${name} ready"
        return 0
      fi
      printf "installed but check still fails\n"
    else
      printf "not available\n"
    fi
  done
  fail "couldn't install ${name} after trying: ${attempted[*]}. Please install manually and re-run."
}

# systemctl is a hard requirement we won't auto-install (would mean
# bootstrapping a different init system). Fail with a friendly message.
if ! command -v systemctl >/dev/null 2>&1; then
  fail "systemd is required (no 'systemctl' on PATH). This installer doesn't support non-systemd distros."
fi

ensure_python_version() {
  if ! command -v python3 >/dev/null 2>&1; then
    return 1
  fi
  python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null
}

ensure_python_venv_ready() {
  # Both checks must pass: venv module importable AND ensurepip data present
  # (the second is what fails on Debian/Ubuntu without python3-venv).
  python3 -c 'import venv, ensurepip' >/dev/null 2>&1
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
    --port)
      [[ $# -ge 2 ]] || fail "--port requires a value"
      BRIDGE_PORT="$2"; shift 2;;
    --hermes-url)
      [[ $# -ge 2 ]] || fail "--hermes-url requires a value"
      HERMES_URL="$2"; shift 2;;
    --help|-h)
      # Handled earlier (before sudo). Safe to ignore here.
      shift;;
    "") shift;;   # tolerate stray empty arg from over-quoted re-exec
    *) fail "Unknown argument: $1";;
  esac
done

banner

# ---------- dependency check (auto-install with confirmation) ----------
ensure_installed "curl" "command -v curl" "curl"
ensure_installed "git"  "command -v git"  "git"

ensure_installed "python3 (>= 3.10)" "ensure_python_version" \
  "python3" "python3.12" "python3.11" "python3.10"

PY_VER=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
ensure_installed "python venv + ensurepip" "ensure_python_venv_ready" \
  "python${PY_VER}-venv" "python3-venv" "python3-virtualenv"

ok "python3 ${PY_VER} ready"

if [[ -z "$ASSUME_YES" ]]; then
  read -r -p "Bridge listen port [${BRIDGE_PORT}]: " answer </dev/tty || true
  [[ -n "${answer:-}" ]] && BRIDGE_PORT="$answer"
  read -r -p "Local Hermes API URL [${HERMES_URL}]: " answer </dev/tty || true
  [[ -n "${answer:-}" ]] && HERMES_URL="$answer"
  printf "\nProceed with install? [y/N] "
  read -r confirm </dev/tty || confirm="n"
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
