#!/usr/bin/env bash
# Build the Linux desktop app in Docker and run the headless self-test under Xvfb (same script CI uses).   usage: scripts/linux/test.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
docker build -q -t bootleg-linux scripts/linux >/dev/null
docker run --rm -v "$PWD":/src:ro -v bootleg-linux-cargo:/root/.cargo/registry -v bootleg-linux-target:/work/src-tauri/target bootleg-linux bash -ec '
  mkdir -p /work && cd /src && tar --exclude=node_modules --exclude=./dist --exclude=src-tauri/target --exclude=./cache -cf - . | tar -xf - -C /work && cd /work
  npm ci --no-audit --no-fund >/dev/null 2>&1 || npm install --no-audit --no-fund >/dev/null
  node scripts/build.mjs
  (cd src-tauri && cargo build --release 2>&1 | tail -2)
  (pulseaudio --start --exit-idle-time=-1 >/dev/null 2>&1 || true)
  scripts/selftest.sh src-tauri/target/release/bootleg
'
