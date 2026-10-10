#!/usr/bin/env bash
# Installs (or updates) DeanMachine as a systemd service that starts on boot
# and restarts automatically if it stops.
#   sudo bash install.sh
# Run it from the unpacked dist/linux folder. Re-run it to update.
set -euo pipefail

NAME=deanmachine
INSTALL_DIR="${INSTALL_DIR:-/opt/$NAME}"
SERVICE_FILE="/etc/systemd/system/$NAME.service"
SRC="$(cd "$(dirname "$0")" && pwd)"

[ "$(id -u)" -eq 0 ] || { echo "Please run as root: sudo bash install.sh" >&2; exit 1; }
[ -f "$SRC/$NAME" ] || { echo "Can't find $SRC/$NAME. Run this from the dist/linux folder." >&2; exit 1; }

# Dedicated user with no login shell.
if ! id "$NAME" >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin "$NAME"
fi

# Stop the old version before replacing the binary.
systemctl stop "$NAME" 2>/dev/null || true

mkdir -p "$INSTALL_DIR"
install -m 755 "$SRC/$NAME" "$INSTALL_DIR/$NAME"
cp "$SRC/strings.yaml" "$INSTALL_DIR/"
cp -r "$SRC/Jobs" "$INSTALL_DIR/"
cp "$SRC/uninstall.sh" "$INSTALL_DIR/"
# Keep an existing .env (and the Servers/ data) on updates.
if [ ! -f "$INSTALL_DIR/.env" ]; then
  cp "$SRC/.env" "$INSTALL_DIR/.env"
fi
chmod 600 "$INSTALL_DIR/.env"
chown -R "$NAME:$NAME" "$INSTALL_DIR"

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=DeanMachine Discord bot
Wants=network-online.target
After=network-online.target
# Never stop retrying.
StartLimitIntervalSec=0

[Service]
Type=simple
User=$NAME
WorkingDirectory=$INSTALL_DIR
ExecStart=$INSTALL_DIR/$NAME
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$NAME" >/dev/null
systemctl restart "$NAME"

echo "DeanMachine is installed in $INSTALL_DIR and running as the '$NAME' service."
echo "  Status:    systemctl status $NAME"
echo "  Logs:      journalctl -u $NAME -f"
echo "  Settings:  $INSTALL_DIR/.env (then: systemctl restart $NAME)"
echo "  Uninstall: sudo bash $INSTALL_DIR/uninstall.sh"
