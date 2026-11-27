#!/usr/bin/env bash
# Headless desktop self-test of a built bootleg binary:  scripts/selftest.sh <path-to-binary>
# Makes fixtures (a tagged flac with cover, a stem render, a mock Subsonic server WITHOUT CORS), launches the app in
# self-test mode (isolated in-memory profile), and fails unless every check passes. Needs ffmpeg + node; on Linux also xvfb.
set -euo pipefail
# GNU `timeout` is not on stock macOS (nor on GitHub's macOS runners): use it when there, else a small portable stand-in
run_timeout() { local s=$1; shift; if command -v timeout >/dev/null 2>&1; then timeout "$s" "$@"; elif command -v gtimeout >/dev/null 2>&1; then gtimeout "$s" "$@"; else "$@" & local p=$!; ( sleep "$s"; kill "$p" 2>/dev/null ) & local k=$!; wait "$p"; local rc=$?; kill "$k" 2>/dev/null || true; return $rc; fi; }
BIN="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"; cd "$(dirname "$0")/.."
T="$(mktemp -d)"; trap 'kill $MOCK $DLNA ${PLEX:-} 2>/dev/null || true; wait $MOCK $DLNA ${PLEX:-} 2>/dev/null || true; rm -rf "$T"' EXIT; mkdir -p "$T/L/A" "$T/S"
mkdir -p "$T/card/Music/bootleg/Tester" && echo mine > "$T/card/Music/bootleg/Tester/mine.txt"   # a card with a file of the user's on it (device sync must leave it alone)
ffmpeg -v error -y -f lavfi -i color=c=0xcc5533:s=200x200:d=1 -frames:v 1 "$T/c.png"
ffmpeg -v error -y -f lavfi -i sine=frequency=330:duration=6 -i "$T/c.png" -map 0:a -map 1:v -c:a flac -c:v mjpeg -disposition:v attached_pic -metadata title="Self Test" -metadata artist=Tester "$T/L/A/st.flac"
node vendor/bootleg-vizualizer/tests/make-fixture.mjs "$T/L/render" >/dev/null 2>&1
mkdir -p "$T/P" && node --input-type=module -e "import fs from 'node:fs'; import { bstemFrom } from './tests/zipw.mjs'; const d = process.argv[1], f = {}; for (const p of ['mix.flac', 'clips.json', ...fs.readdirSync(d + '/stems').map(s => 'stems/' + s)]) f[p] = fs.readFileSync(d + '/' + p); fs.writeFileSync(process.argv[2], bstemFrom(f, { format: 'bootleg-stem', version: 2, id: '22222222-3333-4444-8555-666666666666', title: 'Packaged Self Test' }));" "$T/L/render" "$T/P/Packaged.bstem"   # a song in one file
for i in 1 2; do ffmpeg -v error -y -f lavfi -i sine=frequency=$((300+i*100)):duration=5 "$T/S/s$i.flac"; done
NOCORS=1 node tests/mock-subsonic-cli.mjs "$T/S" "$T/c.png" > "$T/mock.log" & MOCK=$!
for _ in $(seq 1 30); do grep -q 'mock:' "$T/mock.log" && break; sleep 0.2; done
# music videos: one beside the self-test track (matched by its name), one on a mock Plex server (CORS for app.plex.tv only)
mkdir -p "$T/V"; for f in "$T/L/A/Tester - Self Test (Official Video).mp4" "$T/V/plex.mp4"; do ffmpeg -v error -y -f lavfi -i testsrc=size=320x180:rate=25:duration=5 -f lavfi -i sine=frequency=520:duration=5 -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest -movflags +faststart "$f"; done
node tests/mock-plex.mjs "$T/S/s1.flac" "$T/V/plex.mp4" "$T/c.png" > "$T/plex.log" & PLEX=$!
for _ in $(seq 1 30); do grep -q 'plex:' "$T/plex.log" && break; sleep 0.2; done
export BOOTLEG_SELFTEST_PLEX="$(sed 's/plex: //' "$T/plex.log")"
node tests/mock-dlna.mjs "$T/dlna.log" > "$T/dlna.out" & DLNA=$!
for _ in $(seq 1 30); do grep -q 'dlna:' "$T/dlna.out" && break; sleep 0.2; done
export BOOTLEG_SELFTEST_DLNA="$(sed 's/dlna: //' "$T/dlna.out")"
node scripts/make-cd-sim.mjs "$T/CDSIM" >/dev/null; export BOOTLEG_CD_BACKEND=sim BOOTLEG_CD_SIM="$T/CDSIM" BOOTLEG_CD_OFFLINE=1   # the CD plugin rips a simulated scratched disc
node --input-type=module -e "import fs from 'node:fs'; const r = 44100, parts = [[1.5, 0], [22, 330], [2, 0], [25, 440], [3, 0]], s = []; let x = 7; for (const [d, f] of parts) for (let i = 0; i < d * r; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; const n = (x / 0x7fffffff - 0.5) * 0.004, v = f ? 0.3 * Math.sin(2 * Math.PI * f * i / r) + n : n; s.push(v, v * 0.9); } const b = Buffer.alloc(44 + s.length * 2); b.write('RIFF', 0); b.writeUInt32LE(36 + s.length * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22); b.writeUInt32LE(r, 24); b.writeUInt32LE(r * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(s.length * 2, 40); s.forEach((v, i) => b.writeInt16LE(Math.round(v * 32767), 44 + i * 2)); fs.mkdirSync(process.argv[1], { recursive: true }); fs.writeFileSync(process.argv[1] + '/Turntable.wav', b);" "$T/CAPSIM"
export BOOTLEG_CAPTURE_BACKEND=sim BOOTLEG_CAPTURE_SIM="$T/CAPSIM" BOOTLEG_CAPTURE_SIM_SPEED=40 BOOTLEG_CAPTURE_DIR="$T/caprec"   # the Record plugin records a simulated side
export BOOTLEG_SELFTEST="$T/L" BOOTLEG_SELFTEST_OUT="$T/out.json" BOOTLEG_SELFTEST_SUBSONIC="$(sed 's/mock: //' "$T/mock.log")"
RUN=("$BIN"); if [ "$(uname)" = Linux ]; then RUN=(xvfb-run -a -s "-screen 0 1400x900x24" dbus-run-session -- "$BIN"); fi
# A freshly built macOS binary sometimes refuses its very first autoplay (WebKit policy); one retry is enough in practice.
for attempt in 1 2; do rm -f "$T/out.json" "$T/dlna.log"; run_timeout 150 "${RUN[@]}" >"$T/app.log" 2>&1 || true; grep -q 'autoplayBlocked' "$T/out.json" 2>/dev/null || break; echo "first launch could not autoplay — retrying once"; done
[ -f "$T/out.json" ] || { echo "no result — the app never finished its self-test"; tail -30 "$T/app.log"; exit 1; }
cat "$T/out.json"; echo
node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")), skip = !!r.autoplayBlocked && !!process.env.SELFTEST_ALLOW_NO_AUTOPLAY;
const need = skip ? ["ok", "cachedRescan", "restored", "notesDb", "screenOpened", "nativeTagsMatch", "tagWrite", "miniWindow", "miniClosed", "startup", "package", "deviceSync"] : ["ok", "cachedRescan", "restored", "notesDb", "screenOpened", "nativeTagsMatch", "tagWrite", "miniWindow", "miniClosed", "startup", "package", "deviceSync", "mixFirst", "stemsContinued", "offline"], bad = need.filter(k => !r[k]);
if (skip) console.log("note: autoplay is blocked on this machine; playback-dependent checks were skipped");
if (r.remoteTracks && !(r.secretKept && r.secretMigrated && r.extSecret)) bad.push("secrets");
if (!skip && !(r.tracks >= 1 && r.renders >= 1 && r.stems === 5 && r.peak > 0.2 && r.remoteTracks === 2 && r.remotePeak > 0.2)) bad.push("playback/stems/remote");
const log = (require("fs").existsSync(process.argv[2]) ? require("fs").readFileSync(process.argv[2], "utf8") : "").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)), has = f => log.some(f);
if (!skip && !(has(l => l.action === "SetAVTransportURI" && /^http:\/\/[^/]+\/m\/[0-9a-f]{32}\.flac$/.test(l.uri) && l.title === "Self Test" && l.artist === "Tester" && l.mime === "audio/flac") && has(l => l.action === "Play") && has(l => l.fetched === 206 && l.bytes === 100 && /flac/.test(l.type)) && has(l => l.action === "Pause") && has(l => l.action === "Seek" && l.target === "00:00:03") && has(l => l.action === "SetVolume" && l.volume === 50) && has(l => l.artFetched === 200 && l.bytes > 100 && /^image\//.test(l.type)) && has(l => l.action === "Stop") && r.dlnaLocalRestored)) bad.push("dlna: " + JSON.stringify(log).slice(0, 400));
if (!(r.cd && (r.cd.ok || r.cd.skipped === "not in this build"))) bad.push("cd: " + JSON.stringify(r.cd));
if (!(r.checker && (r.checker.ok || r.checker.skipped === "not in this build"))) bad.push("checker: " + JSON.stringify(r.checker));
if (!(r.acoustid && (r.acoustid.ok || r.acoustid.skipped))) bad.push("acoustid: " + JSON.stringify(r.acoustid));
if (!(r.capture && (r.capture.ok || r.capture.skipped))) bad.push("capture: " + JSON.stringify(r.capture));
if (!skip && !(r.video && r.video.ok)) bad.push("video: " + JSON.stringify(r.video));
if (!skip && !(r.plex && r.plex.ok)) bad.push("plex: " + JSON.stringify(r.plex));
const fs = require("fs"), card = process.argv[3]; if (!(fs.readFileSync(card + "/Music/bootleg/Tester/mine.txt", "utf8").trim() === "mine" && fs.existsSync(card + "/.bootleg/device.toml") && !fs.existsSync(card + "/Music/bootleg/Playlists/Road.m3u8"))) bad.push("device sync touched the wrong files");
if (bad.length) { console.error("SELF-TEST FAILED:", bad.join(", "), r.error || ""); process.exit(1); } console.log("self-test passed");' "$T/out.json" "$T/dlna.log" "$T/card"
