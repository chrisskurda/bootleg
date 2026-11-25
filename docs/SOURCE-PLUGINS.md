# Writing a library source plugin

A *source plugin* lets a bootleg library list and stream music that isn't a folder of files — a Subsonic server today; a YouTube Music, Spotify, Bandcamp or Jellyfin plugin tomorrow. **`src/lib/sources/subsonic.js` is the reference implementation: copy it.** The contract is documented at the top of `src/lib/sources/plugin.js`.

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
};
// Item = { id, title, artist, album, albumArtist, year, track, disc, genre, duration, size, suffix, changed, coverId, bitrate }
```
Register it in `src/lib/sources/index.js` (`registerSource(myService)`). That's all: the app then offers it under *Settings → library → Connect a server or service…*.

## What you get for free
- Items become library tracks that arrive **already tagged** (nothing is read from files), listed, searched, sorted, queued, rated, noted, tagged, put in playlists and shown to the visualizer like any other track.
- The track list is **cached** (IndexedDB) so the library appears instantly — and offline — on the next start; it is then **re-scanned incrementally in the background** (new items appear, items the service no longer has disappear), on startup / every N minutes / on demand.
- Annotations are keyed by `plugin:connection/itemId`, so they survive restarts and re-scans.
- A library can mix folders and any number of connections. Libraries have modes (listening / studio).

## Rules of thumb
- **Never store a plain password.** Derive what you need (token + salt, API key, OAuth refresh token) in `connect()`. Desktop keychain storage is a planned improvement; until then stored secrets are in app storage on the user's machine.
- **`scan` should yield pages** so the UI shows progress on big libraries. Honour `signal`.
- **IDs must be stable**; `changed` should increase when an item is edited.
- **Network:** use `netFetch` from `./net.js`. The desktop app routes it through the Tauri HTTP plugin (no CORS limits); in a browser the service must allow CORS. Audio playback: if the media element can't load or analyse a cross-origin stream, the player fetches the file (via your `fetch`) and plays it from a blob.
- **DRM'd / streaming-only services** (Spotify, YouTube Music): they usually forbid raw audio access. A plugin can still list the library, show metadata and cover art, and hand off playback to the service's own player — extend `streamUrl` into a `play(session, item)` hook when the first such plugin is written; the library, notes, ratings and playlists layers already work without audio access.

## Testing
`tests/mock-subsonic.mjs` is a small in-process Subsonic server (with and without CORS) used by `tests/app.test.mjs` and the desktop self-tests (`BOOTLEG_SELFTEST_SUBSONIC`). Do the same for your service: a mock, then drive connect → scan → play → restart → rescan.
