# Changelog

All notable changes to bootleg are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Plan and plugin spec for **syncing to portable players** (USB-storage players, SD cards, bootleg-pod handhelds): paired players and media, add / mirror / fill modes, and bootleg only ever replacing or deleting files it put there. Plugin spec 2.0 gains `device` handlers and a shared transcoder; the spec 2.1 draft adds helper processes and an experimental-plugin flag. An experimental iPod plugin is on the roadmap.

## [0.5.0] - 2026-11-26

### Added
- **Song format 3** (`.bstem` / `.bsong` that are also DAWproject files) plays like version 2; nothing to do.
- **DAWproject files** (`.dawproject`): bootleg's own songs saved under that name play as before; a DAW's *stems export* — every track one whole audio file from the start — plays as a stem set, with its title, artist, tempo, track levels and markers as sections, and keeps its bootleg song id when it started in bootleg (so notes and ratings follow it back from the DAW). Arranged projects are left to bootleg Composer. Opened from Finder/Explorer as an alternative to your DAW.
- **Stem splitter output**: folders from Demucs (drums / bass / other / vocals, and the 6-stem model's guitar / piano) and Spleeter are recognised as stem sets.
- **Windows** (x64): continuous integration builds an installer and attaches it to releases. The desktop self-test runs there too (reported, not yet blocking a release until it has proven itself on Windows).

## [0.4.0] - 2026-11-26

### Added
- **bootleg stem server** as a library source (*Settings → Connect → bootleg stem server*): its songs appear as stem sets — mix first, stems on demand — with their cover, tempo, key and sections; grades sync both ways with bootleg's ratings (A+ … F ↔ 5 … ½ stars, half stars kept), favourites with the `starred` tag, and the server's playlists appear in Playlists. MusicGen's audition server (API v1) works too while you move over, with the same song ids, so notes follow a song when its render folder becomes a package.
- **Songs in one file**: `.bstem` (a song and its stems) and `.bsong` (a bootleg Composer song) play as stem sets straight from the file — the mix at once, the stems on demand, read in place. bootleg opens them from Finder/Explorer too (`.bstem` by default, `.bsong` as an alternative to Composer).
- Now playing shows a song's recipe (style, seed), revision and the credits its licences ask for, and offers **Open in Composer** for a stem server song.

### Fixed
- Syncing a server's ratings and stars no longer echoes them back: a song that was rated and starred on the server was briefly un-starred there while bootleg caught up.

## [0.3.1] - 2026-11-25

### Fixed
- Desktop: the library is shown from the cache at startup again, and checked for changes in the background. Since 0.2.0 it started empty until a rescan (opening files from Finder had taken the place of the normal startup instead of running beside it).

### Added
- **Jazz Cup** visualizer pack (vendored from bootleg-vizualizer): a 90s paper-cup pattern that dances with the music.

## [0.3.0] - 2026-11-25

### Added
- **Post notes to social media**: every note (in the Notes feed and on Now playing) and every recording has “↗ post”, which opens Bluesky, Mastodon, Threads or X with the text filled in — the note, the track (and the moment), and `#nowplaying #bootleg` — or the system share sheet, or copies it. You can edit the text first; a post too long for a network gets its note shortened. **Share feed…** copies or saves the whole feed (as filtered) as Markdown. Settings → *Posting notes*: the tags, a link to bootleg, your Mastodon server.
- **Playlists**: open one to see its tracks (and how many are not in the library) and play from any of them; server playlists can be hidden from the list (and shown again), local ones deleted (with a second click to confirm).

### Changed
- **Notes is a feed**: one column with room for the text, newest first. Notes can be expanded, edited, posted and deleted right there, and a note added to any recording. A moment's time plays the recording from there.
- **Playlists** is one detailed list instead of three columns of cards.
- *Export notes*, *Import notes* and *Forget* moved from the bottom of the left pane to **Settings → Notes and data**.

## [0.2.0] - 2026-11-25

### Added
- **Mini player**: a small window with what is playing and the controls (play, previous/next, seek, volume, shuffle, repeat), styled like the Car Thing app. On the desktop it comes up when you minimize bootleg and goes away when you bring bootleg back (Settings → Now playing), and the ◱ button in the player bar opens it any time; it can stay on top of other windows. In the browser it opens as a pop-up.
- **Now playing, redesigned around the track**: a large cover and everything bootleg knows about it (track, year, genre, BPM, key, file format and bitrate, where it lives, lyrics), and *Up next* from the queue. A **timeline** under it shows the song's spectrogram (drawn once per recording and remembered), your timed notes as callouts and ranges as bands (click one to jump there), and a **listening heatmap** of the parts you actually play most. Click anywhere on it to seek.
- **Visualizer page** in the left pane, with every pack and Look & FX setting out in the open. On Now playing the visualizer is a tile: ⚙ slides its settings in (also in fullscreen), ⤢ opens the page, ⧉ pops it out to another window or display, ⛶ goes fullscreen, and ▭ keeps it as a **mini player** in the corner while you browse. The pack never reloads when it moves between them.
- **Extensions can add pages to the left pane** (`api.ui.addView`) and **process the audio** on its way to the speakers (`api.audio.insert`). Included, off by default: a **10-band equalizer** with presets and a preamp.
- Settings → *Now playing*: spectrogram for local files and server tracks, local files only, or off; the mini visualizer.
- **Write tag edits into files** (desktop, off by default: *Settings → Tag edits → files*). Review each edit (old → new, and its file) and write it now, or approve it for a schedule (every N hours, only when the folders are reachable). Server tracks are written through the folder the server's music is shared from (e.g. an SMB share): found by the path the server reports (Navidrome: turn on *Report Real Path*), else by exact file size, never guessed. Files are replaced in one rename; the server is asked to rescan, and bootleg's edit is dropped once the server reports the new tags. See the README.
- **Subsonic / Navidrome**: the server's playlists appear in Playlists (marked ☁, refreshed on every sync). Ratings and stars sync both ways: server ratings and stars show up in bootleg, and rating a track or tagging it `starred` in bootleg updates the server (half stars are sent rounded). If a value changed on both sides since the last sync, the server wins.
- **Tag edits in bootleg**: edit a track's title, artist, album, album artist, year, track, disc and genre, or an album's shared fields at once ("✎ Edit album"). Edits are stored with your notes (and exported with them) and override what the file or server says, in bootleg only; the files and the server are not changed. Edited tracks are marked ✎ and each field can be reverted.
- **Settings → Playing**: choose what clicking an album does (show its tracks — the new default — or play it), and how playing treats the queue: *replace* (the album, playlist or list becomes the queue; as before) or *build a queue* (double-click adds to the end and starts if nothing is playing; ▶ plays now, inserted after the current track, keeping the rest).
- Album grid: a click unfolds the album's tracks in a panel under its row (Esc or ✕ closes it); a double-click plays it and keeps the tracks open. List, cover flow and split views follow the same click / double-click rule.
- Desktop: open audio files from Finder or Explorer (“Open With → bootleg”, or bootleg as the default player) or the command line; they play straight away, even on a cold start. bootleg registers as an alternate handler for mp3, flac, m4a/aac, ogg/opus, wav, aiff and caf, so it never takes over the default player on its own. On Windows and Linux a second launch hands its files to the running app.
- README screenshots, a synthetic demo library (`npm run demo-library`) and a script that drives the app to capture them (`npm run screenshots`).

### Changed
- The bootleg wordmark matches the Car Thing app: “boot” plain, “**leg**” bold in the accent colour.
- A server track's notes key no longer includes the file size (writing tags changes it; the server's id does not). Existing notes, ratings and playlist entries move to the new key automatically on start.
- The stem-folder layout is now documented as the **bootleg stem format** (`docs/STEM-FORMAT.md`): version 1, with an optional `"format": "bootleg-stem", "version": 1` in `manifest.json`. The app calls these **stem sets**. Nothing changes for existing folders.
- The README describes what bootleg is and how to run it.

### Fixed
- A track row's hover buttons no longer get cut off (they overflowed the narrow time column).
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

[Unreleased]: https://github.com/chrisskurda/bootleg/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/chrisskurda/bootleg/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/chrisskurda/bootleg/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/chrisskurda/bootleg/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/chrisskurda/bootleg/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/chrisskurda/bootleg/releases/tag/v0.1.0
