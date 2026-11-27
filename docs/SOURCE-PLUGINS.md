# Writing a library source plugin

> These contracts are unchanged in [plugin spec 2.0](PLUGIN-SPEC.md) (draft), which lets a packaged plugin register sources and outputs (`api.sources.register`, `api.outputs.register`) and add native code.

A *source plugin* lets a bootleg library list and stream music that isn't a folder of files — a Subsonic server and a bootleg stem server today; a YouTube Music, Spotify, Bandcamp or Jellyfin plugin tomorrow. **`src/lib/sources/subsonic.js` is the reference implementation: copy it.** The contract is documented at the top of `src/lib/sources/plugin.js`.

## The contract
```js
export const myService = {
  id: 'myservice', name: 'My Service', description: '…',
  fields: [{ key: 'url', label: 'Server', type: 'url', required: true }, { key: 'password', type: 'password', … }],   // the app builds the connect form from this
  async connect(values) → { config, title },   // validate against the service; config is persisted and must NOT contain a plain password
  session(config)       → session,             // rebuild from stored config with NO network call (so the library shows offline)
  async *scan(session, { signal }) { yield { items: [Item…], progress: 'Reading… 120 tracks' }; },
  streamUrl(session, item) → url,              // what <audio> plays
  coverUrl(session, item, px) → url,           // optional
  fetch(session, url, init) → Response,        // optional: authenticated fetch (blob fallback)
  playlists(session) → [{ id, name, owner, items: [itemId] }],  // optional: copies shown in Playlists, refreshed each sync
  setRating(session, itemId, stars),           // optional: whole stars 0–5; bootleg ratings then sync both ways
  setStarred(session, itemId, on),             // optional: the server's star/favourite ↔ the bootleg tag "starred"
  halfStars: true,                             // optional: the service keeps half stars (setRating gets 3.5; otherwise whole stars)
  offline: true,                               // optional: the service's terms allow keeping copies (Settings → Offline, device sync)
  download(session, item, quality) → { url, ext, quality, headers?, bytes? },   // with offline: where to fetch a copy;
                                               //   quality 'original' | 'high' | 'saver' — return what you will really send
};
// Item = { id, title, artist, album, albumArtist, year, track, disc, genre, duration, size, suffix, changed, coverId, bitrate }
//   or a file item: { id, kind: 'file', rel: '<song>/stems/kick.flac', size, changed, text?, song? }
```
**File items** are plain files laid out like a folder (`rel`): the library finds stem sets among them exactly as it does
on disk (a `stems/` folder, a `mix.*`, `manifest.json`, `clips.json`, `cover.*` beside it). `text` gives a file's content
inline (a manifest in the listing saves a request per song). On the manifest's item, `song: { id, rating, starred }`
lets the stem set's rating and the `starred` tag sync like a track's (`setRating(session, song.id, …)`). The stem server
plugin (`src/lib/sources/stemserver.js`) works this way.
```js
```
Register it in `src/lib/sources/index.js` (`registerSource(myService)`). That's all: the app then offers it under *Settings → library → Connect a server or service…*.

## What you get for free
- Items become library tracks that arrive **already tagged** (nothing is read from files), listed, searched, sorted, queued, rated, noted, tagged, put in playlists and shown to the visualizer like any other track.
- The track list is **cached** (IndexedDB) so the library appears instantly — and offline — on the next start; it is then **re-scanned incrementally in the background** (new items appear, items the service no longer has disappear), on startup / every N minutes / on demand.
- Annotations are keyed by `plugin:connection/itemId`, so they survive restarts and re-scans.
- **Offline copies** (`offline: true` + `download()`): your tracks can be kept on the computer by the user's rules
  (Settings → Offline) and copied to device cards; playback then uses the copy. Leave `offline` out when the service's
  terms forbid copies — its tracks are then never stored. Subsonic asks the server to convert for *High* / *Space saver*
  (`stream?format=mp3&maxBitRate=…`) and uses `download` for originals; the stem server sends its files as they are.
- A library can mix folders and any number of connections. Libraries have modes (listening / studio).

## Rules of thumb
- **Never store a plain password.** Derive what you need (token + salt, API key, OAuth refresh token) in `connect()`, and list those fields in `secrets: [...]`: the app keeps them in the OS keychain instead of the saved settings and hands them back to `session(config)` ([SECRETS.md](SECRETS.md)).
- **`scan` should yield pages** so the UI shows progress on big libraries. Honour `signal`.
- **IDs must be stable**; `changed` should increase when an item is edited.
- **Network:** use `netFetch` from `./net.js`. The desktop app routes it through the Tauri HTTP plugin (no CORS limits); in a browser the service must allow CORS. Audio playback: if the media element can't load or analyse a cross-origin stream, the player fetches the file (via your `fetch`) and plays it from a blob.
- **DRM'd / streaming-only services** (Spotify, YouTube Music): they usually forbid raw audio access. A plugin can still list the library, show metadata and cover art, and hand off playback to the service's own player — extend `streamUrl` into a `play(session, item)` hook when the first such plugin is written; the library, notes, ratings and playlists layers already work without audio access.

## Testing
`tests/mock-subsonic.mjs` is a small in-process Subsonic server (and `tests/mock-stemserver.mjs` a stem server) (with and without CORS) used by `tests/app.test.mjs` and the desktop self-tests (`BOOTLEG_SELFTEST_SUBSONIC`). Do the same for your service: a mock, then drive connect → scan → play → restart → rescan.

---

# Output plugins (cast targets)
The mirror image of source plugins: they send playback *out* to another device. Contract in `src/lib/outputs/plugin.js`; `outputs/dlna.js` is the reference (discovery + SOAP control run in Rust, `src-tauri/src/dlna.rs`).

- The **Outputs manager** keeps local playback running *silently* while casting (output disconnected from the speakers, analysers still connected), so the visualizer, timeline, notes and queue keep working. Play/pause/seek/volume and track changes are mirrored to the device.
- Local files are served to the device by a tiny **LAN media server** (`src-tauri/src/lan.rs`): random token URLs, Range support, and only files already opened in the app can be shared. Server (Subsonic) tracks hand the device the stream URL directly. Stem renders cast their `mix` file (mute/solo are local-only).
- **DLNA/UPnP:** SSDP discovery, plus "add by address" (a device description URL) for networks that block multicast.
- **AirPlay:** macOS routes system audio to AirPlay speakers (Control Center → Sound), and bootleg's audio — stems included — follows it. There is no public sender protocol for AirPlay, so a native in-app AirPlay target is not planned.
- **Google Cast:** planned as an output plugin speaking the CASTV2 protocol natively from Rust (mDNS discovery, TLS, Default Media Receiver). Google's sender SDK only runs in Chrome, not in the desktop webview.

## Showing the visualizer on other screens
DLNA renderers play media, not web pages, so the visualizer can't ride on a DLNA cast (that would need a live video encoder). Instead the player can show it on **another display or window**: *Now playing → Show on another screen* opens a fullscreen window on the chosen monitor (an HDMI/projector display, or a Mac display mirrored to an AirPlay/Chromecast TV). The player analyses audio once and broadcasts each frame (`src/lib/screen-link.js`); `src/screen.html` rebuilds the pack's `A` object (stems, `A.past`) and renders. It keeps running while the player shows another view. In a browser the same page opens as a pop-up. Next step (with the bridge project): serve this page and the frames over the LAN so any browser — a smart TV, tablet, Pi — can be a screen.

## Tested on real hardware
- LG webOS TV (UP7000PUA): discovery, control, audio fetch (HEAD + ranged GET) and album-art fetch all worked. The first `Play` took longer than the old 6 s timeout, so SOAP timeouts are now 25 s. Casting no longer changes the device's volume when you connect (only when you move the slider afterwards).
- `BOOTLEG_LAN_LOG=<file>` logs what devices request from the LAN media server (handy when a renderer misbehaves).
