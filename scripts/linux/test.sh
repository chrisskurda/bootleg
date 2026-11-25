#!/usr/bin/env bash
# Build the Linux desktop app in Docker and run the headless self-test under Xvfb.   usage: scripts/linux/test.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
docker build -q -t bootleg-linux scripts/linux >/dev/null
docker run --rm -v "$PWD":/src:ro -v bootleg-linux-cargo:/root/.cargo/registry -v bootleg-linux-target:/work/src-tauri/target bootleg-linux bash -ec '
  mkdir -p /work && cd /src && tar --exclude=node_modules --exclude=./dist --exclude=src-tauri/target --exclude=./cache -cf - . | tar -xf - -C /work && cd /work
  npm ci --no-audit --no-fund >/dev/null 2>&1 || npm install --no-audit --no-fund >/dev/null
  node scripts/build.mjs
  cd src-tauri && cargo build --release 2>&1 | tail -3 && cd ..
  # fixtures
  T=/tmp/music; mkdir -p $T/A; ffmpeg -v error -y -f lavfi -i color=c=0xcc5533:s=200x200:d=1 -frames:v 1 /tmp/c.png
  ffmpeg -v error -y -f lavfi -i sine=frequency=330:duration=6 -i /tmp/c.png -map 0:a -map 1:v -c:a flac -c:v mjpeg -disposition:v attached_pic -metadata title="Self Test" -metadata artist=Tester $T/A/st.flac
  node vendor/bootleg-vizualizer/tests/make-fixture.mjs $T/render >/dev/null 2>&1
  # a mock Subsonic server WITHOUT CORS headers (like most real ones): exercises the HTTP plugin + blob fallback
  mkdir -p /tmp/srv; for i in 1 2; do ffmpeg -v error -y -f lavfi -i sine=frequency=$((300+i*100)):duration=5 /tmp/srv/s$i.flac; done
  NOCORS=1 node tests/mock-subsonic-cli.mjs /tmp/srv /tmp/c.png > /tmp/mock.log & sleep 2
  export BOOTLEG_SELFTEST=$T BOOTLEG_SELFTEST_OUT=/tmp/out.json BOOTLEG_SELFTEST_SUBSONIC=$(sed "s/mock: //" /tmp/mock.log)
  (pulseaudio --start --exit-idle-time=-1 >/dev/null 2>&1 || true)
  timeout 120 xvfb-run -a -s "-screen 0 1400x900x24" dbus-run-session -- src-tauri/target/release/bootleg > /tmp/app.log 2>&1 || true
  echo "--- result"; cat /tmp/out.json 2>/dev/null || { echo "NO RESULT"; tail -30 /tmp/app.log; exit 1; }; echo
'
