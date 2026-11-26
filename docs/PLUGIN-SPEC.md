# bootleg plugin spec 2.0 (draft)

Status: **draft**, 2026-11-26. Not implemented yet. The first plugin built on it is the CD plugin ([plugins/CD.md](plugins/CD.md)). The built-in portable player sync is the first user of the `device` kind (§6.1), and §9 is the draft of **2.1**.

Spec 1 is what exists today: JS-only extensions ([EXTENSIONS.md](EXTENSIONS.md)) plus the source and output contracts that are compiled into the app ([SOURCE-PLUGINS.md](SOURCE-PLUGINS.md)). Spec 2.0 keeps all of that working and adds:

1. **One package format** for every kind of plugin (source, output, metadata, view, audio), so a single plugin can provide several kinds. The CD plugin, for example, is a source (play the disc), a metadata provider (disc lookup) and a view (the Rip page).
2. **Native code**: a plugin can ship a Rust part with a separate backend for each platform, behind one cross-platform contract.
3. **Platform declarations**: what each plugin supports on macOS, Linux, Windows and the web build, and how well that support has been tested.
4. **Long-running jobs, media streams and library import**: the APIs a native plugin needs to do real work (rip a disc, stream audio, add files to the library).
5. **Device handlers and transcoding**: a plugin can take over syncing to a kind of portable player (§6.1), using the core's transcoder.

---

## 1. Versioning the spec
- The spec has its own semver, separate from the app's version. The app declares the spec version it implements (`PLUGIN_SPEC = "2.0"` in JS, and `bootleg_plugin_api::SPEC` in Rust).
- A plugin declares `"spec": "2.x"`. It loads if the **major** version matches and its **minor** is ≤ the app's. Minor versions only add things; anything incompatible bumps the major.
- A folder that has an `extension.json` and no `plugin.json` is treated as **spec 1** and gets the spec 1 API unchanged.
- Any change to the spec is a user-visible change: it gets a CHANGELOG line, and a major spec change bumps the app's MAJOR version (MINOR while the app is 0.x), as [CONTRIBUTING.md](../CONTRIBUTING.md) requires.
- The Rust crate `bootleg-plugin-api` uses the spec's major.minor as its own version.

## 2. Package layout
```
plugins/<id>/
  plugin.json            manifest (§3)
  index.js               JS entry: export function activate(api) → { stop?(), status?() }
  *.test.mjs             JS tests (not shipped)
  native/                optional Rust crate (§5)
    Cargo.toml
    permissions/         Tauri permission set (default.toml)
    src/lib.rs           commands and cross-platform logic
    src/backend/mod.rs   the platform trait
    src/backend/macos.rs | linux.rs | windows.rs | sim.rs
    tests/               Rust tests; run against the sim backend in CI on every OS
  fixtures/              test data (disc images, mock responses), not shipped
```
`scripts/build.mjs` copies the JS side to `dist/plugins/<id>/` and lists it in `dist/plugins.json`, the way extensions are listed today. Bundled spec 1 extensions (`extensions/equalizer`, `extensions/bridge-thing`) move to `plugins/` when they are next touched; until then both folders are scanned.

## 3. Manifest (`plugin.json`)
```json
{
  "spec": "2.0",
  "id": "cd",
  "name": "CD",
  "version": "0.1.0",
  "description": "Play, rip and tag audio CDs.",
  "entry": "index.js",
  "provides": ["source", "metadata", "view"],
  "settings": [{ "key": "format", "label": "Format", "type": "select", "options": ["flac", "wav", "aiff", "alac"], "default": "flac" }],
  "platforms": {
    "macos":   { "status": "supported",    "min": "12.0", "arch": ["aarch64", "x86_64"] },
    "linux":   { "status": "experimental" },
    "windows": { "status": "experimental" },
    "web":     { "status": "unavailable",  "why": "Browsers cannot read optical drives." }
  },
  "native": { "crate": "native", "feature": "plugin-cd" }
}
```
| Field | |
|---|---|
| `spec` | the spec version this plugin was written against (§1) |
| `id` | short and stable, `[a-z0-9-]`. Becomes the Tauri plugin name `bootleg-<id>`, the Cargo feature `plugin-<id>`, the settings namespace and the source id |
| `provides` | any of `source`, `output`, `metadata`, `view`, `audio`, `remote`, `device`. Informational: shown in Settings, and checked against what the plugin actually registers (it may not register a kind it did not declare) |
| `settings` | spec 1 field types `text` and `number`, plus `select` (`options`), `bool`, `folder` (desktop folder picker) and `template` (a naming pattern, with a preview) |
| `platforms` | one entry per target (§4). A target left out counts as `unavailable` |
| `native` | present if the plugin has a Rust part (§5). `crate`: the folder; `feature`: the Cargo feature that compiles it in |

## 4. Platforms and support levels
Targets: `macos`, `linux`, `windows`, `web` (the browser build). Optional `min` (OS version) and `arch`.

| `status` | Meaning | Required before claiming it |
|---|---|---|
| `supported` | Works, tested on real hardware | The plugin's tests pass in CI on that OS **and** a hardware check is recorded in the plugin's doc (device, OS version, date, result), as the DLNA section of SOURCE-PLUGINS.md does |
| `experimental` | Builds and passes its tests against the simulator backend; not verified on hardware | The tests pass in CI on that OS |
| `unavailable` | Not offered on that target; `why` says why | — |

What the app does with it:
- Settings lists the plugin with its status per target. On an `unavailable` target the plugin is shown greyed out with `why`, and cannot be enabled.
- `experimental` gets a badge, and the plugin starts only after the user confirms once.
- If a plugin has `native` but the running build was compiled without its feature, it shows as "not included in this build" and cannot be enabled.
- If the native part is included but its backend reports that it is unusable at runtime (no drive found, a permission missing), the plugin still starts and reports this through `status()`. That is a runtime condition, not a platform status.

## 5. Native code
### 5.1 How it is linked
- A native part is an ordinary **Tauri 2 plugin crate** (`tauri::plugin::Builder::new("bootleg-<id>")`). It is **compiled into the app** as an optional dependency of `src-tauri`, behind the Cargo feature `plugin-<id>`. The build script generates the `.plugin(...)` registration lines and the capability entries for every enabled feature.
- **There is no runtime loading of native code.** Rust has no stable ABI, and dynamically loaded libraries would complicate code signing and notarization on macOS. A third-party native plugin therefore means building bootleg with that feature turned on. JS-only plugins can be added without a rebuild, as before.
- First-party plugins are enabled in the default build. Release builds list the plugins they contain in Settings → About.
- **License:** native code and everything it links must be MIT-compatible, because it ends up inside the MIT-licensed app. GPL libraries cannot be linked (this rules out libcdio-paranoia, for example). List each dependency in `THIRD_PARTY.md`.
- **Helper processes** (per-platform sidecar binaries) are not part of 2.0. They are defined in 2.1 (§9.1).

### 5.2 One contract, one backend per platform
Code is laid out so that the platform-specific part is as small as possible:
```rust
// native/src/backend/mod.rs
pub trait Backend: Send + Sync {
    fn name(&self) -> &'static str;                      // "macos-iokit", "linux-sgio", "windows-spti", "sim"
    fn capabilities(&self) -> Capabilities;              // what this backend/device can do, discovered at runtime
    // …plugin-specific primitives (for CD: list drives, read TOC, read sectors with C2 and subchannel, set speed)
}
#[cfg(target_os = "macos")]   mod macos;
#[cfg(target_os = "linux")]   mod linux;
#[cfg(target_os = "windows")] mod windows;
pub mod sim;                                             // always compiled: the simulator backend (§7)
pub fn platform() -> Box<dyn Backend> { /* the cfg-selected backend, or an Unsupported stub */ }
```
Rules:
1. **Backends only provide primitives.** Every algorithm (for CD: secure reading, verification, encoding, tagging) is written once above the trait. That way the same logic is tested on every OS against `sim`.
2. **Every target compiles.** An OS without a real backend gets a stub that returns `Error::Unsupported`. CI builds the crate on macOS, Linux and Windows on every push.
3. **Capabilities are discovered at runtime, not assumed per OS.** Two drives on the same Mac can differ, and the app and the user need to know which features this particular device has.
4. **No root/admin.** A backend must work as the normal user. If an OS needs a one-time setup step from the user (for example joining the Linux `cdrom` group), the backend detects that it is missing and the step is written up in the plugin's doc. Until the step exists and is documented, that OS cannot be `supported`.

### 5.3 `bootleg-plugin-api` (Rust)
A small crate in `src-tauri/plugin-api/` that both the core and native plugins depend on:
| | |
|---|---|
| `SPEC` | the spec version |
| `Jobs` | spawns cancellable long-running work: `jobs.spawn(channel, \|ctx\| …)`. Inside the work, `ctx.progress(fraction, text)`, `ctx.log(level, line)`, `ctx.event(json)` and `ctx.cancelled()`. Each job gets an id, and the core's `plugin_job_cancel(id)` cancels it. Jobs run on their own threads, so a blocking device read never blocks the UI |
| `Media` | `media.register(Box<dyn MediaSource>) → stream id`, with `MediaSource { len(), mime(), read_at(offset, buf) }`. The core serves the stream with Range support to `<audio>` and to cast targets through the existing LAN media server. On Linux, where WebKitGTK can't stream a custom scheme, it falls back to a blob, as files already do |
| `Paths` | resolves the plugin's data/cache directories, and adds a folder the user picked to the app's file scope, the same way `allow_path` does |
| `Tags` | the core's lofty-based tag writer (`write_tags`), so plugins don't carry their own copy |
| `Transcode` | the core's transcoder: `transcode(src, dest, Target, ctx)` inside a Job, with `Target { codec: flac\|alac\|aac\|mp3\|opus\|vorbis, quality, max_rate, max_bits, max_channels }`. Tags and cover art are carried over. Used by device sync and any plugin that writes audio in another format |

### 5.4 Permissions
Each native crate ships `permissions/default.toml`, which allows its commands. When the feature is on, the build adds `bootleg-<id>:default` to the main window's capability, and never to the mini window's. A JS plugin can reach only its own plugin's commands through `api.native` (§6). Since all code in the main webview is trusted the same, this is about keeping plugins tidy and does not sandbox them.

## 6. JS API 2.0 (`activate(api)`)
Everything from spec 1 is unchanged: `api.player`, `api.viz`, `api.library`, `api.settings`, `api.ui.addView`, `api.audio`, `api.toast` and `api.id`. Spec 2.0 adds:
| | |
|---|---|
| `api.platform` | `{ os: 'macos'\|'linux'\|'windows'\|'web', arch, appVersion, spec, status }`. `status` is this plugin's level on the current target |
| `api.native` | present only when the native part is in this build. `invoke(cmd, args) → Promise` (a call to `plugin:bootleg-<id>\|<cmd>`); `job(cmd, args, onEvent) → { id, done: Promise<result>, cancel() }`; `on(event, cb) → unsubscribe` for events the native side pushes (a disc inserted or ejected); `backend` (the active backend's name) |
| `api.sources.register(source)` | registers a source plugin (the existing contract) for as long as this plugin runs |
| `api.sources.attach(sourceId, config, { title, transient })` | adds a connection to the current library. A `transient` connection appears while it is present (a disc in the drive) and is not saved. Notes and ratings are keyed by item id as usual, so they come back when the same disc is inserted again |
| `api.outputs.register(output)` | the existing output contract |
| `api.metadata.register(provider)` | a **metadata provider**: `{ id, name, lookup(query, { signal }) → Candidate[] }`. `query.kind` is one of `disc` (TOC / disc ids), `album`, `recording`. A Candidate's facts feed the album-details merge (`src/lib/album-details.js`) with the provider as their source chip, and are offered to the tag editor |
| `api.media.url(streamId)` | a URL `<audio>` can play for a stream the native side registered |
| `api.library.import(paths, { provenance, notes, tags, defects })` | adds files the plugin wrote (inside a library folder) to the library at once, without waiting for a rescan, together with their provenance, notes and tags. `defects` is described under *Defects* below |
| `api.dialog.folder({ title })` | the desktop folder picker. The picked folder is added to the file scope |
| `api.devices.register(handler)` | a **device handler** for a kind of portable player (§6.1) |
| `api.transcode(src, dest, target, { onProgress, signal })` | the core's `Transcode` (§5.3) from JS. Desktop only |

| `api.library.annotate(path, { tags, notes, provenance, defects })` | adds annotations to a recording that is already in the library: tags are added to its tags, notes are appended, and defects replace whatever this plugin set before. Notes a plugin writes are marked with its id, so the user can see where they came from and the plugin can replace its own notes on a re-check without touching the user's |

**Defects** are a new library annotation for recordings with known damage: a damaged CD rip today, and later a tape transfer with dropouts or a download that was cut short. Each one is `{ start, end, kind, confidence, detail }`, with times in seconds, and `kind` one of:
- `unreadable`: the audio there could not be read
- `uncertain`: the samples were read, but the reads disagreed
- `interpolated`: the gap was filled by concealment, so what you hear there is not the original
- `missing`: the recording is shorter than the source

`confidence` is 0–1. `detail` is free text, for example "312 sectors, 14 passes".

Defects are stored alongside notes, keyed by the recording, and the library shows them in three places:
- a ⚠ badge on the track and its album
- red bands on the Now playing timeline and the seek bar
- the filter `has:defects` and a *Damaged* smart list

A plugin can clear a recording's defects (`api.library.defects.clear(path)`). It does this when a later re-rip or repair fixes the damage.

The browser build exposes the same API without `api.native`, `api.media`, `api.dialog`, `api.devices` and `api.transcode`. Plugins test for them instead of checking the OS.

### 6.1 Device handlers
Syncing to portable players (USB-storage players, SD cards, bootleg-pod devices) is a core feature. Its on-device format (the `.bootleg/` folder: `device.toml`, manifest, journal, outbox) is specified in bootleg-pod's [`contracts/device_format.md`](../../bootleg-pod/contracts/device_format.md). The core owns everything that is the same for every player:
- noticing volumes being mounted, and **pairing**: a volume is never written to until the user has paired it
- the paired **player** and **playback media** records (a player is the hardware, identified by whatever it reports; a medium is a card or drive holding a `.bootleg/` folder, identified by the id in its `device.toml`; a medium remembers which player it was last seen in)
- choosing what to sync (playlists, ratings, albums, stem renders as mix-only by default), the modes (`add`, `mirror`, `fill`), the space budget, transcoding to what the player can play
- the safety rule: **only files listed in the medium's manifest are ever replaced or deleted**, in every mode

A **device handler** decides how files are laid out on a kind of player. The core's own handlers (`generic`, `rockbox`, `pod`) are built in and use this same contract, the way the built-in sources do (§8). A plugin handler is for players whose storage is not plain files plus playlists.
```js
api.devices.register({
  id: 'ipod', name: 'iPod (click wheel)',
  detect(volume)          // → { match: bool, confidence: 0..1, model?, why? }
                          //   volume = { root, label, fs, freeBytes, totalBytes, usb?: { vendor, product, serial } }
  pair(volume)            // → { player: { id, name, model }, profile: { codecs, playlist, art, maxPath } }
  plan(diff)              // → ops; diff = { add: [item], remove: [manifestEntry], update: [item], playlists: [{ name, items }] }
  apply(ops, job)         // runs as a Job; → [{ op, path, deviceId? }] so the core can update the manifest
  readBack?()             // → events in the outbox format: plays, ratings (optional)
})
```
- If a volume matches more than one handler (an iPod running Rockbox matches `rockbox` and an iPod plugin), the user picks once and the choice is saved with the medium.
- The core writes and reads the manifest itself. A handler never deletes anything the core did not hand it in `remove`.
- A handler that writes its own database (rather than plain files) must back it up into `.bootleg/backup/` before each `apply`, and must refuse to write a database version it does not recognise.

## 7. Testing contract
Every native plugin must ship:
1. **A simulator backend** (`sim`) that implements the full trait from fixture files and can inject faults. It is always compiled, runs in CI on all three OSes, and is what the `experimental` status rests on.
2. **Rust tests** of the cross-platform logic against `sim` (`cargo test -p bootleg-plugin-<id>`).
3. **JS tests** (`plugins/<id>/*.test.mjs`) using a mocked `api.native`, plus a scenario in the desktop self-test (`BOOTLEG_SELFTEST_PLUGIN=<id>`) that runs the real app against the sim backend (selected with `BOOTLEG_<ID>_BACKEND=sim`).
4. **A hardware log** in the plugin's doc: one row per real check, giving device, OS, backend, date and result. A target becomes `supported` only once it has one.

## 8. From spec 1 to 2.0
- Spec 1 extensions keep working as they are.
- The built-in Subsonic, stem server and DLNA plugins stay compiled into the core. They are already the reference implementations for their contracts and don't need a package.
- The `extensions/` folder is still read; new plugins go in `plugins/`.
- The Settings page "Extensions" becomes "Plugins", with the platform status column (§4).

## 9. Spec 2.1 (draft)
Additive, so a 2.0 plugin loads unchanged under 2.1 (§1). Its first user is the experimental iPod plugin ([PLAN.md](PLAN.md#portable-players-and-device-sync)).

### 9.1 Helper processes
A plugin can ship a separate per-platform program that the app runs, instead of (or as well as) Rust compiled into the app. This is for libraries whose licence rules out linking them (§5.1), and for code that should not be able to take the app down with it.
```json
"helpers": {
  "macos-aarch64": "bin/macos-aarch64/bootleg-ipod-helper",
  "linux-x86_64":  "bin/linux-x86_64/bootleg-ipod-helper",
  "windows-x86_64": "bin/windows-x86_64/bootleg-ipod-helper.exe"
}
```
- **Protocol:** JSON lines over stdin/stdout. The app sends `{ "id", "cmd", "args" }`; the helper answers with `{ "id", "result" }` or `{ "id", "error" }`, and may send `{ "id", "progress", "text" }`, `{ "id", "log" }` and `{ "id", "event" }` lines in between, which map onto a Job (§5.3). stderr goes to the plugin's log. `{ "cmd": "cancel", "args": { "id" } }` cancels.
- **JS:** `api.helper.call(cmd, args) → Promise` and `api.helper.job(cmd, args, onEvent)` (same shape as `api.native.job`). The helper is started on first use and stopped with the plugin.
- **Licence:** a helper may be LGPL (or any licence that allows distributing it beside MIT software) if its source and licence ship with it and it is listed in `THIRD_PARTY.md`. GPL is still out.
- **Signing:** a helper that ships inside the app bundle is signed with it. A helper installed separately must be signed on macOS, or the user has to approve it once; the plugin's doc says which applies.
- **Testing:** the testing contract (§7) applies; the helper's simulator mode is selected with `--sim <fixtures>`.

### 9.2 Plugin stability
```json
"stability": "experimental",
"disclaimer": "May corrupt the iPod's music database. Back up the iPod first. No guarantees."
```
- `stability` is `stable` (the default) or `experimental`. It is about the whole plugin, separate from the per-platform `status` (§4).
- An `experimental` plugin is **never shown as supported** on any target, whatever its hardware log says. It is not in the default build or the default plugin list; the user adds it.
- `disclaimer` is shown, and must be confirmed, when the plugin is enabled and every time it is about to write to a device or file the user owns (for a device handler: every pairing and every sync).

