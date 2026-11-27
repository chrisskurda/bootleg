# bootleg — plan

## What it is
One player, two shells: a web app, and the same app in a Tauri window. It plays ordinary music files and stem sets (the bootleg stem format), shows visualizers
from [bootleg-vizualizer](https://github.com/chrisskurda/bootleg-vizualizer), and can browse a Subsonic server.

## Formats
- **Standard**: mp3, flac, m4a/aac, ogg/opus, wav. Tags (ID3, Vorbis comments, MP4 atoms) and embedded cover art.
- **Stem set** (folder; the *bootleg stem format*, see [STEM-FORMAT.md](STEM-FORMAT.md)): `stems/<name>.flac|wav`, `manifest.json` (`bpm`, `key`, `sections`, `stems_gain_db`; the mix is the sum of the stems at those gains), `clips.json` (every loop/hit placed: stem, sample file, kit, bar or second), `provenance.json`, `mix.flac`.
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

**Sources are plugins.** A source implements `list()/readTags()/streamUrl()/cover()` (and optionally `stems()`): native files (done), stem sets (done), Subsonic/OpenSubsonic (next), streaming-service plugins written by anyone. The notes/playlist database is source-agnostic, so annotations follow a recording across sources. **Stem formats are plugins too**: a loader turns "a folder/file" into `{stems[], clips?, sections?, meta}`; the bootleg stem format is the first.

Next slices: notes UI (rating widget, note composer at the playhead, markers on the seek bar, provenance editor), import/export buttons, source/stem-format plugin interface, then the Tauri shell.

## Status (v0.1)
Done: library + tags (mp3/flac/m4a), stem renders with live mixer, visualizer host, notes/ratings/provenance/playlists with JSON + M3U import/export, Tauri desktop shell (asset-protocol streaming scoped to what the user picks; headless self-test via `BOOTLEG_SELFTEST`). UI stack: plain ES modules, no bundler.
Later: Subsonic source, source/stem-format plugin interface, spectrum over postMessage for sandboxed packs, signing. After the player is solid: **bootleg-bridge-thing** (separate repo) — plugin that exposes player controls and shows the visualizer elsewhere.

## Desktop platforms
- **macOS (arm64):** `npx tauri build` → `src-tauri/target/release/bundle/macos/bootleg.app`; verified with the headless self-test.
- **Linux (arm64 container, WebKitGTK):** `scripts/linux/test.sh` builds in Docker and runs the self-test under Xvfb — passes. WebKitGTK can't stream from `asset://`, so the player falls back to a blob URL when the media element rejects it. Not yet tried: x86_64 Linux, packaging (.deb/AppImage), real audio output.
- **Android / iOS:** see *Mobile (Android, iOS)* below.

## Scanning, cache and .nfo (v0.2)
- **Import progress:** folder scans report files/folders found (8 parallel readers); tag reading shows "N of M" with a bar.
- **Cached, incremental library:** IndexedDB remembers tags, 512px cover thumbnails, parsed .nfo and each root's file index (validated by size + mtime). On startup the desktop app shows the whole library from the cache at once, then checks for added/changed/removed files in the background (`syncAll`). Unchanged files are never re-read.
- **Settings view:** remember library, check on startup, re-check every N minutes, tag-read parallelism, read .nfo, fill missing tags from .nfo, check now, clear cache.
- **.nfo:** Kodi-style album.nfo/artist.nfo and plain-text .nfo in track folders (or above) fill *missing* tags only and show on the Now-playing panel; "Import .nfo text as notes" and "Save album.nfo…" (writes Kodi XML from the album, rating and whole-recording notes). Build: `tauri build` now runs `scripts/build.mjs` first (it previously packaged a stale `dist/`).

## Libraries and modes (v0.3)
Several named **libraries**, each with its own folders and a **mode**: *Listening* (ratings, memories, stories, "where the recording came from") or *Studio* (status idea→released, ideas, to-dos, mix notes, versions/takes, "how it was recorded"). Modes are defaults, not walls: notes, ratings, tags and status belong to the **recording** and follow it across libraries (the same file can be in several libraries); the active library's mode decides which fields and note kinds are offered. Tags are global (the Notes view filters by tag across everything). Header switcher + "All libraries"; managed in Settings. Existing single-library setups migrate to a default "Music" library.
Possible later: per-library feature toggles beyond the two presets, studio extras (versions timeline, reference tracks, A/B), per-library notes templates.

## Source plugins (v0.4)
Subsonic/OpenSubsonic is the first **library source plugin** and the template for others — see `docs/SOURCE-PLUGINS.md`. Libraries hold folders and/or plugin connections; remote tracks arrive pre-tagged, are cached for instant/offline start, and rescanned incrementally. Desktop uses the Tauri HTTP plugin (no CORS) with a blob fallback for playback. Next: OS-keychain secret storage, a `play()` hook for streaming-only services, Jellyfin/Plex-style plugins.

## Plugin spec 2.0 and the CD plugin (planned, 2026-11-26)
Plugins get a versioned spec (`docs/PLUGIN-SPEC.md`): one package (`plugins/<id>/plugin.json`) for every kind, optional native Rust compiled in behind a Cargo feature, with one backend per platform behind a shared trait plus an always-built simulator backend, and per-target status (`supported` needs a recorded hardware test; `experimental` = CI against the simulator). New APIs: native commands and cancellable jobs, media streams, transient sources, metadata providers, library import, and **defects** (damaged/uncertain stretches shown on tracks and timelines). First user: the CD plugin (`docs/plugins/CD.md`), macOS first: secure error-correcting rips verified with AccurateRip/CTDB, CTDB repair, salvage of damaged discs with the damage flagged in the library, FLAC by default.

## Albums, details, CI (v0.5)
- **Album views:** grid, list, cover flow (persistent compositor-animated covers; reflection only on the centre cover, no `box-reflect`), and **split** — album list left, right pane with cover, details **merged from every source with a chip saying where each fact came from** (tags / server / .nfo / files / library), review and artist text from .nfo, album-level rating/tags/notes (keyed `album:Artist|Album`, shared across libraries), tracks. Metadata plugins (MusicBrainz, Last.fm, …) will contribute more candidate facts to the same merge (`src/lib/album-details.js`) — a second plugin kind next to source plugins.
- **CI (`.github/workflows/build.yml`):** every push/PR runs the tests, builds the macOS arm64 app and Linux x64 (.deb + AppImage), runs `scripts/selftest.sh` on each built binary (scan, tags, playback, stems, cache, notes, Subsonic), and uploads artifacts named by commit; tags `v*` attach builds to a release. Works on GitHub Actions; Gitea/Forgejo Actions can run the same file with matching runner labels. The build stamp (commit/date) shows in Settings → About.

## Performance (v0.6)
Measured with `npm run perf` (20,000 synthetic tracks, CPU throttled 4× to imitate a weaker machine; CI enforces the budgets) and the desktop self-test on a 30,000-file library:

| | before | after |
|---|---|---|
| DOM nodes with 20k tracks | 220,000 | ~600 |
| first track rows (throttled) | 1,364 ms | ~290 ms |
| switching back to Tracks (throttled) | 1,080 ms | ~10 ms |
| search keystroke (throttled) | 287 ms | ~15 ms |
| longest UI-blocking task (throttled) | 627 ms | ~80 ms |
| folder scan, 30k files | seconds (one IPC call per file) | 90 ms (Rust, parallel) |
| first import tag reading, 30k files | 24.8 s | 2.3 s (native `lofty`, batched, threaded) |
| start from cache, 30k tracks | — | 0.4 s (loaded in slices) |

What changed: virtualized lists (tracks, album list, split list; grid renders in chunks), memoized sort/albums/search keyed by a data version, adaptive redraw throttle while tags stream in, lazy `convertFileSrc`, the cache loads in chunks after the first paint, the visualizer pack page loads only when first shown, hidden views don't repaint, Rust scanner + Rust tag reader. The page-side tag reader remains for the web build and as the fallback for formats lofty can't read.
Not done yet: queue and Notes cards aren't virtualized; web build still reads tags on the main thread (a Worker would help); tag/cover reading could be prioritised for what is on screen.

## Stem sets in the library (v0.7)
A folder of stems is **one library item** — the piece of music — never its parts. Detected layouts: (1) a `stems/` folder of audio (manifest.json / clips.json / mix.* beside it optional), including nested ones with no manifest; (2) a loose folder whose audio is mostly stem-named (kick, bass, pad, bed, drums, …), optionally with musicset.json and mix.*. Ordinary albums are left alone (stem words must be the whole file name, and ≥60% of the folder). Sets appear in Tracks (with a ♫ stems badge), the Stem renders view and search; a lone `mix.wav` takes its folder's name.
**Playback is mix-first:** a set starts instantly from its `mix` file; its stems (decoded — big) load on demand: when a stem-aware visualizer (`usesStems` in pack.json, SPEC 0.9.3) is shown (default), when you press *Load stems*, or always (Settings → Stem sets), and then take over at the same position; *Unload* hands the memory back. Stem decoding is bounded (3 at a time). Set metadata (manifest + mix tags) is cached like track tags; clips.json loads when played.
On a 800-set production library: 57 stray "tracks" (stems/mixes) → 13 real tracks + 804 sets.

## Portable players and device sync
Decided 2026-11-26. Sync the library to portable players: USB-storage players, SD cards and bootleg-pod handhelds. The on-device format (a `.bootleg/` folder at the root of the card: `device.toml` with the sync settings, a manifest of every file bootleg wrote, a journal, and an outbox for plays/ratings/notes coming back) is specified in bootleg-pod's `contracts/device_format.md` and implemented by its `bootleg-sync` crate, which the desktop links too.
- **Pairing:** a volume is only written to after the user pairs it. The desktop keeps paired **players** (the hardware: USB ids, or the id a pod reports) and **playback media** (a card or drive, identified by the id in its `device.toml`). A medium remembers the player it was last seen in, and the player's profile (codecs, playlist style, art size) applies while it is there.
- **Modes:** `add` (copy in, never delete), `mirror` (the managed folder matches the selection), `fill` (fill up to a space budget, rotating). In every mode only files in bootleg's manifest are ever replaced or deleted.
- **Device handlers** (plugin spec 2.0 §6.1): `generic`, `rockbox` and `pod` are built in. Stem renders go as mix + metadata unless stems are chosen.
- **Order:** bootleg-pod's `bootleg-sync` crate and CLI first, then the desktop sync view on top of it, then the Rockbox play-count import, then two-way notes with pod devices.
- **Built (unreleased):** `vendor/bootleg-sync` (git subtree from bootleg-pod's `crates/bootleg-sync`; change it there and `git subtree pull --prefix=vendor/bootleg-sync <bootleg-pod> <split branch> --squash`), `src-tauri/src/devices.rs` (commands), `src/lib/devices.js` (selection → files, outbox merge; `tests/devices.test.mjs`), `src/lib/devices-ui.js` (the Devices page), and a `deviceSync` step in the desktop self-test. The card's selection (`playlists`, `[select] min_rating / starred`) lives in its `device.toml`, so it travels with the card. Next: transcoding (the core `Transcode`), USB vendor/product ids for players without bootleg-pod, `.bstem` packages as mix + metadata, Windows free space.

- **Transports (2026-11-27):** the Devices page and the device format are written for any medium, not only SD cards. Today: SD cards and USB drives / players mounted as storage. Next: phones and players over **MTP** (no mounted file system: the same plan applied through an MTP backend), and **Wi-Fi sync** with bootleg-pod devices (the same device format over the LAN; bootleg-pod's first Wi-Fi feature). Every copy is read back from the medium past the OS cache and rewritten on a mismatch (a test card silently lost a 128 KiB block).

### Offline store (built, unreleased)
Server tracks (and files on network shares) kept on this computer by rules: playlists, albums, tracks, rating, starred, in priority order, with a space limit and a quality (original, or MP3 320 / 128 converted by a Subsonic server). Optional "also keep what I play" (off by default, own limit). Device sync gets server tracks through it (kept by default; "temporary only" is a setting), at the card's own quality. Files: `src-tauri/src/offline.rs` (downloads, copies, index), `src/lib/offline.js` (rules and planning, `tests/offline.test.mjs`), `src/lib/offline-ui.js` (Settings → Offline, ⤓ buttons), `src/lib/offline-hook.js` (sources play the kept copy). Plugins opt in with `offline: true` + `download()`.
Next: per-library default rules; showing ⤓ state on tracks in lists; a stem-server "convert" endpoint so stem sets can be kept smaller; local transcoding for files on shares (needs the core `Transcode`).

### Roadmap: iPod plugin (experimental, no guarantees)
A separate plugin, not part of the supported player sync and not in the default build. Needs plugin spec 2.1 (helper processes, `stability: experimental`).
- **Scope:** click-wheel iPods only. iPods running Rockbox use the built-in `rockbox` handler instead.
- **How:** a `device` handler whose helper process uses libgpod (LGPL, hence a helper rather than linked code) to write `iPod_Control/iTunes/iTunesDB` and the scrambled `iPod_Control/Music/Fxx` files. Playlists go into the database, not M3U files. FLAC is transcoded to ALAC (or AAC to save space). The iPod's "Play Counts" file is read back as plays and ratings.
- **Models, in order:** no-checksum generations (1G–5.5G, mini, nano 1G–2G, shuffles) → classic 6G/7G and nano 3G–4G (hash58, through libgpod) → maybe nano 5G (needs a key from an earlier iTunes sync). nano 6G/7G and iPod touch are refused when detected.
- **Safety:** back up the database into `.bootleg/backup/` before every write; refuse unknown database versions; warn when the Music app on a Mac is set to sync the iPod automatically; Linux writes only to FAT-formatted iPods (HFS+ write support is unreliable there).
- **Not before:** the supported player sync has shipped and spec 2.1 is implemented.

## Mobile (Android, iOS)
Planned 2026-11-26, nothing built. Phones and tablets could run everything the desktop does, but much of it isn't practical there, so mobile is a **profile of this codebase** (Tauri 2 mobile, same JS UI, plugins and Rust core), not a new app and not bootleg-pod. Pod stays the lean player for Linux handhelds and weak devices.
- **What mobile is:** a client of the music server (192.168.1.26) plus an **offline subset** stored on the phone. Heavy work (transcoding, analysis, stem renders, imports, converters) stays on the server or desktop. Responsive touch layout; tablets may keep the compose/studio views, phones are view-and-play.
- **Left out:** the CD plugin (`plugin-cd` off for mobile targets), USB device sync (possible on Android over OTG with SAF, impossible on iOS; not worth it at first), `tauri-plugin-single-instance` (desktop only), anything that depends on `tiny_http` staying alive in the background.
- **Background audio (the main problem):** webview audio stops when the app is backgrounded, iOS most of all, and Web Audio stem mixing won't keep running. A music player needs native playback: Android MediaSession + foreground service, iOS AVAudioSession, lock-screen and headset controls, audio focus. Plan: a native Rust audio engine (decode + mix + output, cpal/oboe) behind a Tauri mobile plugin, the UI only controls it. bootleg-pod's `pod-core` audio engine is meant to be the same engine. Decide this before any other mobile work.
- **Storage:** Android uses SAF (document trees, no real paths); iOS keeps everything in the app sandbox, document pickers for anything outside. Source and stem-format plugins must not assume file paths.
- **The phone as a sync target:** the device format already works on any folder, so the app's own storage gets a `.bootleg/device.toml` and is paired like any medium. What's new is a **network transport**: the desktop or server sends the same plan over the LAN and the phone applies it with `bootleg-sync`; outbox events (plays, ratings, notes, tags) come back the same way.
- **Plugins:** JS plugins run unchanged. Native plugins are compiled per target (NDK, iOS). Spec 2.1 helper processes (§9.1) can't run on iOS, and on Android only from binaries shipped in the APK's native library folder. The spec needs a `platforms` field in `plugin.json` so a plugin declares where it works and the host hides the rest.
- **Should build as is:** `lofty`, `ureq`, `bootleg-sync` (statvfs); the dialog, fs and http plugins work but behave differently on mobile.
- **Distribution:** Android is an APK (sideload; F-Droid or Play later). iOS needs signing: free personal signing expires after 7 days, TestFlight or ad-hoc installs need the paid developer account. App Store rule 2.5.2 limits downloaded code that changes behaviour, which conflicts with installable plugins, so a public App Store build would ship with plugins locked to a bundled set.
- **Order:** (1) native audio engine shared with pod, (2) Android build of the mobile profile with server streaming, (3) phone as a network sync target with the offline subset, (4) iOS for personal installs only, until the audio engine and plugin story are proven.
- **Test devices:** the Android range already listed in bootleg-pod's plan (Snapdragon 600-series to ~Gen 1).
- **Open:** whether bootleg-pod keeps an Android shell at all (see its plan), and whether tablets get the full studio views.
