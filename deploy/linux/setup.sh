#!/usr/bin/env bash
# Sets up the deanmachine executable next to this script as a systemd service
# that starts on boot and restarts automatically.
#   sudo bash setup.sh
set -euo pipefail

NAME=deanmachine
DIR="$(cd "$(dirname "$0")" && pwd)"

[ "$(id -u)" -eq 0 ] || { echo "Please run as root: sudo bash setup.sh" >&2; exit 1; }
chmod +x "$DIR/$NAME"

cat > "/etc/systemd/system/$NAME.service" <<EOF
[Unit]
Description=DeanMachine Discord bot
Wants=network-online.target
After=network-online.target
StartLimitIntervalSec=0

[Service]
User=${SUDO_USER:-root}
WorkingDirectory=$DIR
ExecStart=$DIR/$NAME
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$NAME"
systemctl restart "$NAME"
echo "Service '$NAME' is running. Logs: journalctl -u $NAME -f"
