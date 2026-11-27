# Versions and updates (draft)

> Planned 2026-11-26, nothing built yet. Plugins already carry their own `version` in `plugin.json`. This is how those versions are kept, published and updated, and how the app and every other component stay compatible.

## 1. What has its own version

Each of these is released on its own and has its own SemVer and CHANGELOG ([Keep a Changelog](https://keepachangelog.com/en/1.1.0/)):

| Component | Version lives in | CHANGELOG | Git tag |
|---|---|---|---|
| the app | `package.json`, `src-tauri/Cargo.toml`, `tauri.conf.json` (kept equal by `scripts/check-version.mjs`) | `CHANGELOG.md` | `v0.7.0` |
| the plugin spec | `PLUGIN_SPEC` (JS), `bootleg_plugin_api::SPEC` (Rust) | `docs/PLUGIN-SPEC.md` §1 + the app's CHANGELOG | none: it ships with the app |
| each plugin | `plugins/<id>/plugin.json` `version` (and `native/Cargo.toml` when there is one, kept equal) | `plugins/<id>/CHANGELOG.md` | `plugin/<id>/v0.2.0` |
| each spec 1 extension | `extensions/<id>/extension.json` | as plugins | `ext/<id>/v0.2.0` |
| visualizer packs, bootleg-pod, the stem server | their own repos | their own | their own |

A plugin's version says what changed **for its users**: MAJOR when it drops something or needs the user to redo something (re-pair, re-rip, new settings), MINOR for new features, PATCH for fixes. A plugin's version is unrelated to the spec version it targets (`spec` in its manifest, §1 of the spec).

## 2. Compatibility

Each plugin release states what it needs:
```json
"requires": { "app": ">=0.7.0", "spec": "2.1" }
```
- `spec`: as today (same major, minor ≤ the app's).
- `app`: a SemVer range, for when a plugin depends on an app fix rather than a spec feature. Optional.
- **Native plugins** are compiled into the app (spec §5.1), so their native part only changes with an app release. The update index (§3) says which app version carries which native version. A JS update that needs a newer native part says so with `"native": ">=0.2.0"`, and the app won't install it until the app itself is updated.

The app refuses to load a plugin whose `requires` it doesn't meet, and says why in *Settings → Plugins* (the same place as the platform status).

## 3. The update index (GitHub Pages)

One static site, built by CI and published with GitHub Pages, is the source of truth for every component. The app, bootleg-pod and the stem server all read it. It needs no server of our own, no accounts, and works with plain caching.

```
https://<pages-host>/updates/
  index.json                      every component: latest version per channel, plus the minimum compatible versions
  app/latest.json                 Tauri updater format (signed bundles per target, on GitHub Releases)
  plugins/<id>/index.json         every release of the plugin: version, requires, changelog excerpt, files
  plugins/<id>/<version>.zip      the JS part of the plugin (no native/, no fixtures/)
  plugins/<id>/<version>.zip.sig  its signature
  keys.json                       the public keys, with the key rotation history
```
`index.json`:
```json
{
  "format": 1, "generated": "2026-12-01T12:00:00Z",
  "app":     { "stable": "0.7.0", "beta": "0.8.0-beta.1" },
  "spec":    "2.1",
  "plugins": { "cd": { "stable": "0.2.0", "beta": "0.3.0-beta.1", "native": { "0.2.0": ">=0.7.0" } },
               "scrobble": { "stable": "0.1.0" } },
  "pod":     { "stable": "0.3.0" }
}
```
- **Signed:** every file the app installs is signed with Ed25519 (minisign format, as the Tauri updater already uses). The public key ships in the app. A file whose signature doesn't verify is never installed. TLS alone is not trusted.
- **Built by CI:** pushing a tag (`v…`, `plugin/<id>/v…`) runs the release job: it checks that the version in the manifest matches the tag and that the CHANGELOG has an entry for it, builds and signs, and pushes the new files to the Pages branch. Nothing is uploaded by hand.
- **Channels:** `stable` (default) and `beta`. A beta is a SemVer pre-release (`0.3.0-beta.1`).

## 4. How the app updates

- **The app** uses the Tauri updater against `app/latest.json`: it shows what's new (from the CHANGELOG) and installs on the user's OK. Bundled plugins come with it.
- **JS plugins** (and the JS half of native plugins) can update between app releases. A newer compatible version is downloaded into the app's data folder (`plugins/<id>/<version>/`), verified, and loaded instead of the bundled copy. The previous version is kept, so *Settings → Plugins* can roll back. A plugin is never updated while it runs a job (a rip, a sync). It updates the next time it starts.
- **Settings → Updates:** check automatically (daily, the default) or only when asked, the channel, and install plugin updates automatically or ask first. Experimental plugins and plugins with a disclaimer (spec 2.1 §9.2) always ask.
- **Privacy:** an update check is a GET of static files. It sends no ids or usage data and no list of the user's plugins. The app works offline, and turning checks off loses nothing but the updates.
- **Data migrations:** a plugin that changes how it stores settings or secrets migrates them in `activate()` and never in a way an older version can't read back (or it bumps MAJOR and says so).

## 5. Other components

- **bootleg-pod** reads the same `index.json`, which says which app and sync format versions it can talk to. On handhelds it is still distributed through PortMaster. The index only tells the user that a newer version exists.
- **The stem server** checks `index.json` the same way and reports the newest version on its status page.
- **Visualizer packs** can be listed in the index later, with the same signing.

## 6. Order of work

1. `requires` in manifests, and the app refusing plugins it can't run (no network needed).
2. Per-plugin CHANGELOGs and tags. CI checks that version, tag and CHANGELOG agree.
3. The Pages site and the signed `index.json` built by CI, and the Tauri updater for the app.
4. JS plugin updates with rollback.
5. pod and the stem server reading the index.
