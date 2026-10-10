#!/usr/bin/env bash
# Removes the DeanMachine service.
#   sudo bash uninstall.sh           # remove the service, keep files and server data
#   sudo bash uninstall.sh --purge   # also delete the install folder (incl. .env and Servers/) and user
set -euo pipefail

NAME=deanmachine
INSTALL_DIR="${INSTALL_DIR:-/opt/$NAME}"
SERVICE_FILE="/etc/systemd/system/$NAME.service"

[ "$(id -u)" -eq 0 ] || { echo "Please run as root: sudo bash uninstall.sh" >&2; exit 1; }

systemctl disable --now "$NAME" 2>/dev/null || true
rm -f "$SERVICE_FILE"
systemctl daemon-reload
echo "Removed the '$NAME' service."

if [ "${1:-}" = "--purge" ]; then
  rm -rf "$INSTALL_DIR"
  userdel "$NAME" 2>/dev/null || true
  echo "Deleted $INSTALL_DIR and the '$NAME' user."
else
  echo "Files and server data are still in $INSTALL_DIR. Use --purge to delete them."
fi
