# bootleg

A music player for **large libraries**, with live visualizers, stem mixing, notes and ratings, casting and server support. A web app that also runs as a desktop app (macOS, Linux) through Tauri. MIT licensed.

- **Plays** mp3, flac, m4a, ogg, opus, wav with their tags and cover art, and **stem sets** (the [bootleg stem format](docs/STEM-FORMAT.md)) — a folder of stems plus its mix, shown as one item, played from the mix instantly, with a live stem mixer (mute, solo, trim) on demand.
- **Big libraries stay fast:** virtualized lists, a persistent incremental library cache, native (Rust) scanning and tag reading — 30,000 files scan in under a second and read their tags in a couple of seconds.
- **Libraries** with a *Listening* or *Studio* mode; notes, ratings, tags, provenance and status that follow the recording; album views (grid, list, cover flow, split with merged details); `.nfo` files as a metadata source; playlists (M3U) and notes import/export.
- **Live visualizers** from [bootleg-vizualizer](https://github.com/chrisskurda/bootleg-vizualizer), including per-stem visuals; show them fullscreen on another display.
- **Sources and outputs are plugins:** Subsonic/OpenSubsonic servers (Navidrome, Airsonic, Gonic) today; DLNA/UPnP casting with album art. Optional **extensions** (e.g. a Car Thing remote) sit behind a small API and are off by default.

## Run it
```
npm install
npm run dev            # build + serve the web app at http://localhost:8800
npm test               # unit + browser end-to-end tests (needs Chrome and ffmpeg)
npx tauri build        # the desktop app (needs Rust; see src-tauri/)
```
`scripts/selftest.sh <built app>` and `scripts/linux/test.sh` run a headless self-test of the desktop app; `npm run perf` checks the performance budget.

## Documentation
- [docs/STEM-FORMAT.md](docs/STEM-FORMAT.md) — the bootleg stem format
- [docs/SOURCE-PLUGINS.md](docs/SOURCE-PLUGINS.md) — library sources (Subsonic is the reference) and cast outputs
- [docs/EXTENSIONS.md](docs/EXTENSIONS.md) — optional add-ons and their API
- [docs/PLAN.md](docs/PLAN.md) — design notes and status
- [CHANGELOG.md](CHANGELOG.md) · [CONTRIBUTING.md](CONTRIBUTING.md)

## Vendored
`vendor/bootleg-vizualizer/` is a pinned `git subtree` of the visualizer (spec, runtime, FX, packs, analysis). Don't edit it here — change it in bootleg-vizualizer and pull: `git subtree pull --prefix vendor/bootleg-vizualizer https://github.com/chrisskurda/bootleg-vizualizer.git <tag> --squash`.

## Related
- [bootleg-vizualizer](https://github.com/chrisskurda/bootleg-vizualizer) — the pack format, runtime and packs
- [bootleg-vizualizer-videocreator](https://git.skurda.org/chris/bootleg-vizualizer-videocreator.git) — renders packs to video
