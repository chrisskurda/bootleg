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
