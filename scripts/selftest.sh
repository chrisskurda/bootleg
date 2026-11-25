#!/usr/bin/env bash
# Headless desktop self-test of a built bootleg binary:  scripts/selftest.sh <path-to-binary>
# Makes fixtures (a tagged flac with cover, a stem render, a mock Subsonic server WITHOUT CORS), launches the app in
# self-test mode (isolated in-memory profile), and fails unless every check passes. Needs ffmpeg + node; on Linux also xvfb.
set -euo pipefail
BIN="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"; cd "$(dirname "$0")/.."
T="$(mktemp -d)"; trap 'kill $MOCK 2>/dev/null; wait $MOCK 2>/dev/null; rm -rf "$T"' EXIT; mkdir -p "$T/L/A" "$T/S"
ffmpeg -v error -y -f lavfi -i color=c=0xcc5533:s=200x200:d=1 -frames:v 1 "$T/c.png"
ffmpeg -v error -y -f lavfi -i sine=frequency=330:duration=6 -i "$T/c.png" -map 0:a -map 1:v -c:a flac -c:v mjpeg -disposition:v attached_pic -metadata title="Self Test" -metadata artist=Tester "$T/L/A/st.flac"
node vendor/bootleg-vizualizer/tests/make-fixture.mjs "$T/L/render" >/dev/null 2>&1
for i in 1 2; do ffmpeg -v error -y -f lavfi -i sine=frequency=$((300+i*100)):duration=5 "$T/S/s$i.flac"; done
NOCORS=1 node tests/mock-subsonic-cli.mjs "$T/S" "$T/c.png" > "$T/mock.log" & MOCK=$!
for _ in $(seq 1 30); do grep -q 'mock:' "$T/mock.log" && break; sleep 0.2; done
export BOOTLEG_SELFTEST="$T/L" BOOTLEG_SELFTEST_OUT="$T/out.json" BOOTLEG_SELFTEST_SUBSONIC="$(sed 's/mock: //' "$T/mock.log")"
RUN=("$BIN"); if [ "$(uname)" = Linux ]; then RUN=(xvfb-run -a -s "-screen 0 1400x900x24" dbus-run-session -- "$BIN"); fi
timeout 150 "${RUN[@]}" >"$T/app.log" 2>&1 || true
[ -f "$T/out.json" ] || { echo "no result — the app never finished its self-test"; tail -30 "$T/app.log"; exit 1; }
cat "$T/out.json"; echo
node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")), need = ["ok", "cachedRescan", "restored", "notesDb"], bad = need.filter(k => !r[k]);
if (!(r.tracks >= 1 && r.renders >= 1 && r.stems === 5 && r.peak > 0.2 && r.remoteTracks === 2 && r.remotePeak > 0.2)) bad.push("playback/stems/remote");
if (bad.length) { console.error("SELF-TEST FAILED:", bad.join(", "), r.error || ""); process.exit(1); } console.log("self-test passed");' "$T/out.json"
