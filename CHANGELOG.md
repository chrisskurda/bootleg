# Changelog

All notable changes to bootleg are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Settings → Playing**: choose what clicking an album does (show its tracks — the new default — or play it), and how playing treats the queue: *replace* (the album, playlist or list becomes the queue; as before) or *build a queue* (double-click adds to the end and starts if nothing is playing; ▶ plays now, inserted after the current track, keeping the rest).
- Album grid: a click unfolds the album's tracks in a panel under its row (Esc or ✕ closes it); a double-click plays it and keeps the tracks open. List, cover flow and split views follow the same click / double-click rule.
- Desktop: open audio files from Finder or Explorer (“Open With → bootleg”, or bootleg as the default player) or the command line; they play straight away, even on a cold start. bootleg registers as an alternate handler for mp3, flac, m4a/aac, ogg/opus, wav, aiff and caf, so it never takes over the default player on its own. On Windows and Linux a second launch hands its files to the running app.
- README screenshots, a synthetic demo library (`npm run demo-library`) and a script that drives the app to capture them (`npm run screenshots`).

### Changed
- The stem-folder layout is now documented as the **bootleg stem format** (`docs/STEM-FORMAT.md`): version 1, with an optional `"format": "bootleg-stem", "version": 1` in `manifest.json`. The app calls these **stem sets**. Nothing changes for existing folders.
- The README describes what bootleg is and how to run it.

### Fixed
- Tracks played through the download fallback (servers without CORS, e.g. Navidrome, and WebKit/Linux) now carry their audio type; without it WebKit could refuse the file and nothing played.
- The notes panel no longer rebuilds while you are typing in one of its fields (a rating, status or tag change elsewhere could wipe what you had just typed).

## [0.1.0] - 2026-11-25

First release: a music player for large libraries, with stem mixing, notes and live visualizers. Runs in a browser and as a desktop app (macOS, Linux) built with Tauri.

### Added
- **Library**: add folders or files (drag and drop too); tags and cover art read from mp3, flac and m4a; sorted by artist, album and track; search; queue, shuffle and repeat. Folder scans and tag reading run natively in the desktop app and show progress.
- **Cached, incremental library**: tags, covers and each folder's file list are remembered so the library appears instantly on startup, then new, changed and removed files are picked up in the background (on startup, on a timer, or on demand). Settings control scanning behaviour.
- **Multiple libraries** with a *Listening* or *Studio* mode. A library's mode chooses which fields are offered (ratings, memories and provenance for listening; status, to-dos, mix notes and versions for studio). Notes, ratings and tags belong to the recording and follow it across libraries.
- **Notes**: half-star ratings, tags, notes on a moment, a range or the whole recording (markers on the seek bar), where-it-came-from provenance, album-level notes, a Notes browser with filters. Export and import all notes as JSON; playlists with M3U/M3U8 import and export.
- **Albums**: grid, list, cover-flow and split views. The split view merges details from every source (tags, server, `.nfo`, files) and shows where each fact came from.
- **Stem sets**: a folder of stems is one library item (with its mix); stems and mixes never appear as separate tracks. Sets start playing from their mix at once; stems load on demand (for a stem-aware visualizer, on request, or always) and take over at the same position, with a live mixer (mute, solo, trim).
- **`.nfo` files** (Kodi-style `album.nfo`/`artist.nfo` and plain text) fill missing tags, show on the track, import as notes, and `album.nfo` can be written from what bootleg knows.
- **Live visualizers**: the bootleg-vizualizer packs follow whatever plays, including per-stem visuals. A fullscreen visualizer window can be shown on another display.
- **Source plugins**: Subsonic/OpenSubsonic (Navidrome, Airsonic, Gonic) as the reference plugin, with a documented contract for future services.
- **Casting**: DLNA/UPnP renderers (discovery, control, album art) through a built-in LAN media server; local playback keeps running silently so the visualizer keeps working. AirPlay works through the macOS sound output.
- **Extensions**: optional add-ons behind a small API, off by default. Included: the Car Thing bridge (connects to the bootleg-bridge-thing app).
- **Desktop app** for macOS and Linux with a headless self-test; continuous integration builds, tests and packages every commit.
- A **changelog** and a version check (`npm run check:version`) that keeps `package.json`, `tauri.conf.json` and `Cargo.toml` in step.

### Fixed
- Playback no longer waits for a stream to finish loading before starting, falls back to downloading the file when a stream is blocked or stalls, and shows a message saying why a track can't play instead of failing silently.

[Unreleased]: https://github.com/chrisskurda/bootleg/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/chrisskurda/bootleg/releases/tag/v0.1.0
