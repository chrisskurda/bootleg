# bootleg — plan

## What it is
One player, two shells: a web app, and the same app in a Tauri window. It plays ordinary music files and MusicGen stem renders, shows visualizers
from [bootleg-vizualizer](https://git.skurda.org/chris/bootleg-vizualizer.git), and can browse a Subsonic server.

## Formats
- **Standard**: mp3, flac, m4a/aac, ogg/opus, wav. Tags (ID3, Vorbis comments, MP4 atoms) and embedded cover art.
- **Stem render** (folder): `stems/<name>.flac|wav`, `manifest.json` (`bpm`, `key`, `sections`, `stems_gain_db`; the mix is the sum of the stems at those gains), `clips.json` (every loop/hit placed: stem, sample file, kit, bar or second), `provenance.json`, `mix.flac`.
  The stem player mixes the stems itself (WebAudio gain per stem) so mute/solo/trim are real.
- **Subsonic / OpenSubsonic** (client only): browse artists/albums/playlists, stream, cover art. Needs a server; browsers need CORS or a proxy, which Tauri's HTTP layer avoids.

## Visualizers
Packs run in a sandboxed frame (`vendor/bootleg-vizualizer/core/pack-runtime.js`). The player owns the audio graph and feeds the frame with
`vendor/bootleg-vizualizer/core/audio.js`: mix features from an analyser, and **per-stem taps** (`feed.addStem(name, node, {role, label, gainDb})`,
`feed.stemState[name] = {muted, solo, gainDb}` from the faders) so `A.stem('kick')` is real for stem renders and estimated for plain tracks.
Song info comes from the tags / `manifest.json` (`A.meta`, `A.section`). UI: pick a pack, Tweak panel (params + look/FX) generated from `pack.json`, fullscreen.
Known gap: spectrum and waveform are not yet carried over `postMessage`, so a *sandboxed cross-origin* pack frame can't receive them; same-origin frames (the reference host does this) can.

## Milestones
1. **Web player**: library from a folder (File System Access API; Tauri fs on desktop), queue, seek, volume, tags + cover art, keyboard.
2. **Stem player**: open a render folder; per-stem mute/solo/trim and gain; section markers; A/B; loops — ported from the audition page.
3. **Visualizer host**: pack picker, Tweak panel, fullscreen, per-stem feed, text from tags and clips.
4. **Tauri shell**: window, native file dialogs, media keys, persisted library and settings, installers.
5. **Subsonic client**.
6. Polish: playlists, gapless, ReplayGain, theming.

## Open questions
- UI stack: plain ES modules + a bundler, or a small framework?
- Tag parsing in JS: write minimal ID3 / Vorbis / MP4 readers, or call ffprobe in the desktop shell and parse in the browser for the web build?
- Where the library index lives (IndexedDB on web, SQLite via Tauri on desktop?).
- How much of the audition page (queue, A/B deck, markers, grading) is carried over versus rethought.
- Sandboxing third-party packs: iframe `sandbox` with a `postMessage` feature transport (needs the spectrum/wave transport above).

## Library data model, notes and sources (decided 2026-11)

Target user: someone with a **big library** who catalogs it — live-performance memories, stories behind a recording, provenance ("vinyl rip on this date", "retail CD", "mix-CD rip", "recorded at the show on device X"), ratings, organizing notes.

**Annotations** (`src/lib/notes.js`, implemented + tested): per-track rating (half stars), tags, free-form notes, **timeline notes** (`at` seconds, optional `to` for a range → shown on the seek bar), and a structured **provenance** record (kind, date, device, venue, source, note). Keyed by track key (`sourceKind:id`) with an optional content fingerprint so notes survive moves/re-imports. IndexedDB in the app, memory in tests.

**Import / export** (large libraries): notes + playlists as one JSON file (`bootleg-notes` v1, merge on import: newer record wins, notes unioned by id); playlists as M3U/M3U8 (read/write, resolved by file name → artist+title → title). Later: CSV for ratings/notes, and reading other apps' exports.

**Sources are plugins.** A source implements `list()/readTags()/streamUrl()/cover()` (and optionally `stems()`): native files (done), stem renders (done), Subsonic/OpenSubsonic (next), streaming-service plugins written by anyone. The notes/playlist database is source-agnostic, so annotations follow a recording across sources. **Stem formats are plugins too**: a loader turns "a folder/file" into `{stems[], clips?, sections?, meta}`; the MusicGen render format is the first.

Next slices: notes UI (rating widget, note composer at the playhead, markers on the seek bar, provenance editor), import/export buttons, source/stem-format plugin interface, then the Tauri shell.

## Status (v0.1)
Done: library + tags (mp3/flac/m4a), stem renders with live mixer, visualizer host, notes/ratings/provenance/playlists with JSON + M3U import/export, Tauri desktop shell (asset-protocol streaming scoped to what the user picks; headless self-test via `BOOTLEG_SELFTEST`). UI stack: plain ES modules, no bundler.
Later: Subsonic source, source/stem-format plugin interface, spectrum over postMessage for sandboxed packs, signing. After the player is solid: **bootleg-bridge-thing** (separate repo) — plugin that exposes player controls and shows the visualizer elsewhere.

## Desktop platforms
- **macOS (arm64):** `npx tauri build` → `src-tauri/target/release/bundle/macos/bootleg.app`; verified with the headless self-test.
- **Linux (arm64 container, WebKitGTK):** `scripts/linux/test.sh` builds in Docker and runs the self-test under Xvfb — passes. WebKitGTK can't stream from `asset://`, so the player falls back to a blob URL when the media element rejects it. Not yet tried: x86_64 Linux, packaging (.deb/AppImage), real audio output.
- **Android:** later (Tauri 2 mobile); needs a different file-access model (SAF) — the source plugin interface should keep that in mind.
