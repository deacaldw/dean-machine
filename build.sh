#!/usr/bin/env bash
# Tests, then builds bin/windows and bin/linux, each with everything needed to run:
# the executable, res/.env, res/<target>/*, and the skills' strings.yaml for editing.
set -euo pipefail
cd "$(dirname "$0")"

npm install
npm test
rm -rf bin
# No bytecode: V8 bytecode built on one OS is rejected on another, so ship plain source.
npx pkg . --out-path bin --no-bytecode --public-packages "*" --public

mkdir -p bin/windows bin/linux
mv bin/deanmachine-win.exe bin/windows/deanmachine.exe
mv bin/deanmachine-linux bin/linux/deanmachine

for target in windows linux; do
  out="bin/$target"
  if [ -f res/.env ]; then
    cp res/.env "$out/"
  else
    echo "res/.env not found; using res/.env.example. Fill in DISCORD_TOKEN before running." >&2
    cp res/.env.example "$out/.env"
  fi
  if [ -d "res/$target" ]; then cp -r "res/$target/." "$out/"; fi
  for f in Skills/*/strings.yaml; do
    mkdir -p "$out/$(dirname "$f")"
    cp "$f" "$out/$f"
  done
done

echo "Done: bin/windows and bin/linux"
