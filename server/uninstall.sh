#!/usr/bin/env bash
# Voice Gateway — Hermes Voice Bridge uninstaller.

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  exec sudo bash "$0" "$@"
fi

systemctl stop hermes-voice-bridge 2>/dev/null || true
systemctl disable hermes-voice-bridge 2>/dev/null || true
rm -f /etc/systemd/system/hermes-voice-bridge.service
systemctl daemon-reload
rm -rf /opt/hermes-voice-bridge
rm -rf /etc/hermes-voice-bridge
rm -rf /var/log/hermes-voice-bridge
if id -u hermes-voice >/dev/null 2>&1; then
  userdel hermes-voice
fi
echo "removed hermes-voice-bridge"
