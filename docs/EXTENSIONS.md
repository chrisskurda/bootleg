# Extensions

> This is plugin **spec 1** (JS-only extensions). [Spec 2.0](PLUGIN-SPEC.md) (draft) adds one package format for every plugin kind, native code with per-platform backends, and platform support levels; spec 1 extensions keep working.

Optional add-ons that sit **outside the core app** and use a small, stable API. They are off until the user turns them on (Settings → Extensions), and the core knows nothing about any particular one. Source plugins (music in) and output plugins (cast targets) have their own contracts in `SOURCE-PLUGINS.md`; an *extension* is for everything else — remotes, integrations, scrobblers, overlays.

## Layout
```
extensions/<id>/
  extension.json   { id, name, version, description, entry: "index.js", settings: [{ key, label, type: "text"|"number", default, hint }] }
  index.js         export function activate(api) → { stop?(), status?() }     (sync or async)
```
`scripts/build.mjs` copies each folder into `dist/extensions/<id>/` and lists them in `dist/extensions.json`; the module is only `import()`ed when enabled. `*.test.mjs` files are not shipped.

## The API (`activate(api)`)
| | |
|---|---|
| `api.player` | the player: `item`, `playing`, `pos()`, `dur()`, `volume`, `queue`, `index`, `mode`, `deck.stems`, `stemsState`; `play() pause() toggle() next() prev() seek(t) setVolume(v) setShuffle(b) setRepeat(m) ensureStems()`; events `change`, `seek`, `volume`, `playerror` |
| `api.viz` | `{ pack, packs, setPack(id), onFrame(cb) → unsubscribe }` — `onFrame` delivers every analysed audio frame (`A`: spectrum, level, beat, stems…) and keeps the analyser running while subscribed |
| `api.library` | the library (read it; `tracks`, `renders`, `albums()`, `search()`) |
| `api.settings` | `{ get(key, default), set(key, value) }`, stored per extension |
| `api.ui.addView({ title, mount(el) → cleanup? })` | adds a page: a button under *Extensions* in the left pane, and `el` (an empty page) for you to fill. Returns a function that removes it; it is also removed when the extension stops |
| `api.audio` | `{ context, insert(input, output = input) → remove }` — puts your nodes between the player and the speakers (in order of insertion). The visualizer and meters listen before them, so they see the music as it is |
| `api.toast(msg, bad?)` | show a message |
| `api.id` | this extension's id |
Return `stop()` to release everything (listeners, timers, sockets, `onFrame` subscriptions): it runs when the user turns the extension off or changes one of its settings (the extension restarts with the new value). `status()` is a short string shown under the extension in Settings.

## Included: Equalizer (`extensions/equalizer`)
Ten filters (shelves at 31 Hz and 16 kHz, peaking bands between) and a preamp, inserted with `api.audio.insert`, on a page added with `api.ui.addView`. Presets: Flat, Bass boost, Treble boost, Vocal, Loudness, Night. The curve is kept in the extension's settings.

## Included: Car Thing bridge (`extensions/bridge-thing`)
Connects out to the **bootleg-bridge-thing** desktop app (`ws://127.0.0.1:8899/bootleg`) so a Spotify Car Thing can control playback and show the visualizer: publishes state and cover art, executes the commands the device relays back, and streams spectrum frames while the device is watching. Protocol and tests are in that folder (`node extensions/bridge-thing/bridge.test.mjs`). It is a candidate to live in the bridge repo and be vendored here, the way the visualizer is.
