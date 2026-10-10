#!/usr/bin/env bash
# Builds Windows x64 and Linux x64 executables, each in its own folder with
# everything needed to run it:
#   dist/windows/  deanmachine.exe + .env + strings
#   dist/linux/    deanmachine     + .env + strings
set -euo pipefail
cd "$(dirname "$0")"

command -v npm >/dev/null || { echo "npm not found. Install Node.js 22+ first." >&2; exit 1; }

npm install
rm -rf dist
npm run build

echo
echo "Done. Copy dist/windows or dist/linux to the target machine and run the executable."
