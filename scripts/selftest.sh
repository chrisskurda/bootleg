#!/usr/bin/env bash
# Headless desktop self-test of a built bootleg binary:  scripts/selftest.sh <path-to-binary>
# Makes fixtures (a tagged flac with cover, a stem render, a mock Subsonic server WITHOUT CORS), launches the app in
# self-test mode (isolated in-memory profile), and fails unless every check passes. Needs ffmpeg + node; on Linux also xvfb.
set -euo pipefail
# GNU `timeout` is not on stock macOS (nor on GitHub's macOS runners): use it when there, else a small portable stand-in
run_timeout() { local s=$1; shift; if command -v timeout >/dev/null 2>&1; then timeout "$s" "$@"; elif command -v gtimeout >/dev/null 2>&1; then gtimeout "$s" "$@"; else "$@" & local p=$!; ( sleep "$s"; kill "$p" 2>/dev/null ) & local k=$!; wait "$p"; local rc=$?; kill "$k" 2>/dev/null || true; return $rc; fi; }
BIN="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"; cd "$(dirname "$0")/.."
T="$(mktemp -d)"; trap 'kill $MOCK $DLNA 2>/dev/null || true; wait $MOCK $DLNA 2>/dev/null || true; rm -rf "$T"' EXIT; mkdir -p "$T/L/A" "$T/S"
ffmpeg -v error -y -f lavfi -i color=c=0xcc5533:s=200x200:d=1 -frames:v 1 "$T/c.png"
ffmpeg -v error -y -f lavfi -i sine=frequency=330:duration=6 -i "$T/c.png" -map 0:a -map 1:v -c:a flac -c:v mjpeg -disposition:v attached_pic -metadata title="Self Test" -metadata artist=Tester "$T/L/A/st.flac"
node vendor/bootleg-vizualizer/tests/make-fixture.mjs "$T/L/render" >/dev/null 2>&1
for i in 1 2; do ffmpeg -v error -y -f lavfi -i sine=frequency=$((300+i*100)):duration=5 "$T/S/s$i.flac"; done
NOCORS=1 node tests/mock-subsonic-cli.mjs "$T/S" "$T/c.png" > "$T/mock.log" & MOCK=$!
for _ in $(seq 1 30); do grep -q 'mock:' "$T/mock.log" && break; sleep 0.2; done
node tests/mock-dlna.mjs "$T/dlna.log" > "$T/dlna.out" & DLNA=$!
for _ in $(seq 1 30); do grep -q 'dlna:' "$T/dlna.out" && break; sleep 0.2; done
export BOOTLEG_SELFTEST_DLNA="$(sed 's/dlna: //' "$T/dlna.out")"
export BOOTLEG_SELFTEST="$T/L" BOOTLEG_SELFTEST_OUT="$T/out.json" BOOTLEG_SELFTEST_SUBSONIC="$(sed 's/mock: //' "$T/mock.log")"
RUN=("$BIN"); if [ "$(uname)" = Linux ]; then RUN=(xvfb-run -a -s "-screen 0 1400x900x24" dbus-run-session -- "$BIN"); fi
# A freshly built macOS binary sometimes refuses its very first autoplay (WebKit policy); one retry is enough in practice.
for attempt in 1 2; do rm -f "$T/out.json" "$T/dlna.log"; run_timeout 150 "${RUN[@]}" >"$T/app.log" 2>&1 || true; grep -q 'autoplayBlocked' "$T/out.json" 2>/dev/null || break; echo "first launch could not autoplay — retrying once"; done
[ -f "$T/out.json" ] || { echo "no result — the app never finished its self-test"; tail -30 "$T/app.log"; exit 1; }
cat "$T/out.json"; echo
node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")), skip = !!r.autoplayBlocked && !!process.env.SELFTEST_ALLOW_NO_AUTOPLAY;
const need = skip ? ["ok", "cachedRescan", "restored", "notesDb", "screenOpened", "nativeTagsMatch", "tagWrite", "miniWindow", "miniClosed"] : ["ok", "cachedRescan", "restored", "notesDb", "screenOpened", "nativeTagsMatch", "tagWrite", "miniWindow", "miniClosed", "mixFirst", "stemsContinued"], bad = need.filter(k => !r[k]);
if (skip) console.log("note: autoplay is blocked on this machine; playback-dependent checks were skipped");
if (!skip && !(r.tracks >= 1 && r.renders >= 1 && r.stems === 5 && r.peak > 0.2 && r.remoteTracks === 2 && r.remotePeak > 0.2)) bad.push("playback/stems/remote");
const log = (require("fs").existsSync(process.argv[2]) ? require("fs").readFileSync(process.argv[2], "utf8") : "").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)), has = f => log.some(f);
if (!skip && !(has(l => l.action === "SetAVTransportURI" && /^http:\/\/[^/]+\/m\/[0-9a-f]{32}\.flac$/.test(l.uri) && l.title === "Self Test" && l.artist === "Tester" && l.mime === "audio/flac") && has(l => l.action === "Play") && has(l => l.fetched === 206 && l.bytes === 100 && /flac/.test(l.type)) && has(l => l.action === "Pause") && has(l => l.action === "Seek" && l.target === "00:00:03") && has(l => l.action === "SetVolume" && l.volume === 50) && has(l => l.artFetched === 200 && l.bytes > 100 && /^image\//.test(l.type)) && has(l => l.action === "Stop") && r.dlnaLocalRestored)) bad.push("dlna: " + JSON.stringify(log).slice(0, 400));
if (bad.length) { console.error("SELF-TEST FAILED:", bad.join(", "), r.error || ""); process.exit(1); } console.log("self-test passed");' "$T/out.json" "$T/dlna.log"
