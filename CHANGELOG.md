# Changelog

All notable changes to bootleg are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Playlists and star changes from a bootleg-pod handheld**: *Bring them in* on the Devices page now adds the playlists made on the player (one per name; saving it again on the player updates it here) and takes off tags removed there (a star taken back), besides ratings, notes and plays.
- **Car Thing bridge 0.2.0: a bootleg-pod handheld as a remote.** *Bridge addresses* takes several addresses (comma separated), so the Car Thing and a handheld on Wi-Fi can both connect. The handheld's Remote page shows the address to add (`ws://<ip>:8899/bootleg?key=…`); from there it plays, pauses, skips, seeks, sets the volume, shuffle and repeat, and mutes or solos stems, with the cover, track and spectrum on its screen.
- **Music videos, across every source.** Video files in your folders (MP4, M4V, MKV, WebM, MOV, named “Artist - Title”) and music videos on Jellyfin and Plex servers are listed on a new Videos page. They are matched to tracks from any source by artist and title (ignoring “(Official Video)”, “[4K]”, *feat.* and the like), or linked by hand from the 🎬 chip; a wrong match can be turned down. On Now playing, *Watch the video* plays it with its own sound in place of the track, and *Play music videos* does that through the whole queue. Visualizer screens show the video instead of the visualizer (an option in Settings, on by default). See docs/VIDEOS.md.
- **Jellyfin** (the *Jellyfin* plugin, experimental): music and music videos from a Jellyfin server, favourites both ways, playlists, offline copies (original or MP3 converted by the server). Videos the platform can't play are remuxed to MP4 by the server.
- **Plex** (the *Plex* plugin, experimental): sign in with plex.tv in the browser (or give the address of a server that allows your network), music and the music videos Plex keeps with each artist, ratings in half stars both ways, playlists, offline copies of the originals. On the desktop.
- Source plugins can be packaged plugins (`api.sources.register`): turned off, their tracks leave the library; turned on again, they come back from the cache.
- The desktop app streams media from servers that allow no other web origins (Plex) through a media proxy on 127.0.0.1, so their sound reaches the visualizer and the equalizer.
- **Record vinyl and tape** (the *Record* plugin, desktop, experimental): record a side from any audio input with level meters, see the tracks found at the quiet gaps and adjust the splits on the waveform, fill in titles by hand or from MusicBrainz, remove clicks, and save 24-bit FLAC into the library with its provenance. See docs/plugins/CAPTURE.md.
- **Album details from MusicBrainz** (the *MusicBrainz* plugin): *Find details online…* in the album pane lists matching releases, scored on title, track lengths and year. The one you pick adds its label, catalogue number, barcode, release type, genres and cover to the album's details, and *Edit album* can fill tags from it.
- **Identify albums by sound** (the *AcoustID* plugin, desktop): fingerprints each track and offers the MusicBrainz releases that hold the most of them. Needs a free AcoustID API key for now. See docs/plugins/METADATA.md.
- Metadata providers for plugins (`api.metadata.register`), with the chosen release remembered per album.
- **Library check** (the *Library check* plugin, desktop, experimental): reads every file through and finds damage, files cut short, FLAC files whose audio no longer matches their checksum, lossy files saved as lossless (with a bitrate guess), upsampled hi-res, 16-bit audio in 24-bit files, and clipping, and measures each file's dynamic range (DR). CD rips are checked against AccurateRip without the disc. Findings go onto the tracks as tags, a note and ⚠ marks; unchanged files aren't read again. See docs/plugins/CHECKER.md.
- **Scrobbling** (the *Scrobbling* plugin, experimental): ListenBrainz and Last.fm. A track counts once half of it, or 4 minutes, has really been heard; listens made offline wait in a queue and are sent later. Tokens and keys go in the system keychain. See docs/plugins/SCROBBLE.md.
- **Versions and updates plan** (docs/UPDATES.md, draft): every plugin has its own version and CHANGELOG, and a signed update index on GitHub Pages will keep the app, plugins and other components current and compatible.
- Plugin settings can be `secret` (stored in the keychain, never shown again), and plugins can open a link in the browser (`api.ui.openExternal`).
- **Secrets go in the system keychain** (macOS Keychain, Windows Credential Manager, the Secret Service on Linux) instead of app settings: passwords, tokens, API keys and any other credential. Subsonic tokens saved by earlier versions move there on the next start, and disconnecting a server removes its item. Every plugin and extension gets `api.secrets` for its own, and native plugin code gets the same store from `bootleg-plugin-api`. Where there is no keychain (the browser, Linux without a keyring) they stay in app storage, and *Settings → Plugins* says so. See docs/SECRETS.md.
- **CD ripping** (the *CD* plugin, Settings → Plugins; macOS, experimental until it has been checked on real drives).
  - Every sector is read until two reads agree, with the drive's cache flushed in between. Sectors that won't settle are re-read with the drive slowed down.
  - Rips are checked against AccurateRip, and the read offset comes from AccurateRip's drive list.
  - FLAC by default, decoded back and compared before it is kept; WAV and AIFF too.
  - Each rip gets MusicBrainz tags and cover art, a cue sheet, a playlist and a detailed log.
  - **A damaged disc still gives everything it can.** What could not be read is filled in (short gaps interpolated, long ones silenced), flagged on the track with ⚠, and shown as red bands on the Now playing timeline. Search `has:defects` to find them.
  - Ripped tracks arrive in the library with *CD rip* provenance and `rip:verified` / `rip:secure` / `rip:suspect` / `rip:damaged` tags.
  - **Check drive** reports what a drive can do on your Mac.
- **Plugin spec 2.0** (draft, docs/PLUGIN-SPEC.md): plugins can include native code with a backend per platform, declare which platforms they support and how well tested each is, run long jobs, and add files and annotations to the library. Settings → *Extensions* is now *Plugins* and shows each plugin's status on this computer.
- **Devices** (desktop): sync to SD cards and USB-storage players, running bootleg-pod or not. Pair a card (bootleg writes only a hidden `.bootleg` folder on it), choose its playlists, a minimum rating and starred tracks, and a mode: *Add* (never deletes), *Mirror* (the card matches your choice) or *Fill* (up to the space you allow). *Check* shows what would change first. bootleg only ever replaces or removes files it put on the card itself; a file of yours with the same name makes bootleg's copy "… (bootleg)". Playlists are written to the card as .m3u8, stem sets go as their mix and details (stems if you ask), and plays, ratings, notes and tags made on a bootleg-pod come back into your notes. A sync that is cut off (card pulled) is cleaned up next time. Not yet: transcoding (tracks a player can't play are listed and left out), server tracks and .bstem packages.
- **Offline** (desktop, Settings → Offline): keep music on this computer to play without the server, the NAS or the network. Choose what by rules in priority order (playlists, including Subsonic and stem-server playlists, albums, single tracks, everything rated N★ or more, everything starred) with **⤓ keep offline** on playlists, albums and tracks; set the space to use and the quality (*Original*, or *High* / *Space saver* MP3 converted by a Subsonic server). Server tracks and files in library folders on network shares are copied, interrupted downloads resume, and playback, stems and waveforms use the kept copy. Optional (off by default): *also keep what I play*, with its own limit, least recently played going first. Plugins opt in (`offline: true` + `download()`), so services whose terms forbid copies are never stored.
- **Devices: server tracks go to cards.** A card's playlists may hold Subsonic and stem-server tracks: the sync downloads them first (kept offline by default, or only for the copy: Settings → Offline), at the card's own quality (*Server tracks* on the card).
- **Devices: every copy is checked on the device.** Each file is read back from the device itself (not the computer's cache) and written again if it doesn't match; the sync says so when that happened, as the device may be failing. The Devices page now speaks of players, cards and drives (phones over MTP and sync over Wi-Fi are planned).
- **Playlists: find by name or by what's in them.** Search playlists by name or by a track, artist or album they contain (the matching tracks are shown and highlighted), show only mine or the servers', sort by name, size or last change; every playlist shows its main artists, size and length. Long lists load 100 at a time. The same search picks a device card's playlists, which are now listed in priority order (↑ ↓).
- Plan and plugin spec for **syncing to portable players** (USB-storage players, SD cards, bootleg-pod handhelds): paired players and media, add / mirror / fill modes, and bootleg only ever replacing or deleting files it put there. Plugin spec 2.0 gains `device` handlers and a shared transcoder; the spec 2.1 draft adds helper processes and an experimental-plugin flag. An experimental iPod plugin is on the roadmap.

### Changed
- **Performance pass** (measured with `npm run perf`: 20,000 tracks, CPU slowed 4×):
  - The queue draws only the rows in view, and nothing while its drawer is closed. Playing from the track list makes the whole list the queue, which used to put a row per track in the page and rebuild them all on every play, pause, skip and shuffle: with 20,000 tracks, starting playback took 725 ms and a pause 550 ms. Both now take under 40 ms.
  - A hidden visualizer costs nothing. The pack is loaded when the visualizer is first shown (it was being loaded at every start), and it stops drawing while you are on another page or the Now playing tile is scrolled away.
  - Sorting the library is about four times faster (100,000 tracks: 210 ms to 50 ms), so the lists keep up while tags are read; the order is unchanged.
  - The cached library loads with fewer redraws, the player bar's clock and seek bar are only touched when they change, and Settings counts the cache instead of loading all of it.

### Fixed
- Adding a very large list to the queue (more than 65,536 tracks: “+ queue” or *Build a queue* on a whole library) or dropping a folder with that many files failed on the desktop. Both work at any size now.
- Player bar: a long album name no longer pushes the cover, title and stars off the left edge of the window. The line is cut short with "…" instead.
- "Check for changes" while the library was already syncing (for example during the scan on start) did nothing; it now waits for that sync and runs again, so changes made on the server meanwhile are picked up. This was also the intermittent browser-test failure in CI.
- Devices: a sync that copies nothing now says why. A card with no playlists chosen asks for some; playlist tracks the open library doesn't have, playlists that were renamed or deleted, and server tracks are listed under “left out”, which opens by itself when nothing is copied. A playlist none of whose tracks reached the card is no longer written to it as an empty file.

## [0.6.0] - 2026-11-26

### Added
- **Gapless playback** (the new default, *Settings → Playing → Between tracks*): the next track starts on the exact sample the last one ends, so live albums and mixed albums play without a gap. A track still starts streaming at once; a couple of seconds in it moves onto a decoded deck in place, and the next track is decoded ahead of time.
- **Crossfades** of 2 to 24 seconds instead, equal power, optionally **tempo-matched**: the next track comes in at this one's tempo on a bar line, then eases back to its own (needs BPM tags; the pitch moves a little, like a record).
- **DJ mode** (the *DJ* button in the player bar, or `d`): two decks with tempo, sync (tempo and bar phase), nudge and bar jumps, high / mid / low EQ with kills, volume, waveforms with 4-bar lines, a crossfader and auto-mix on the next bar line, and hints when the tempos lock or the keys may clash. Playing a track loads it onto the idle deck; the queue gets A / B buttons. Leaving DJ mode keeps the deck the crossfader is on playing, as the current queue track.

### Changed
- Every source (the streaming player, the stem mixer, the decks) now plays through one mix bus; the visualizer listens to it, so it sees both tracks during a crossfade, and volume no longer changes what it sees.
- Tracks over 20 minutes (or files over 300 MB) are never decoded whole: they keep streaming and change over to the next track without decoding it. *Between tracks → Off* brings back the old behaviour (each track loads when the last one ends) and uses the least memory.

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
- **18 more visualizer packs** (bootleg-vizualizer 0.10.0): seven built from the playing track's cover art (Ambient, Gallery, Glitch, Mirror, Mosaic, Shards, Strips), ten retro computer screens (Amiga, Apple II, BeOS, DOS Shell, Hackerman, Mono Mac, Matrix, Metro, Palm, Temple) and Hot Dog Stand.

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
