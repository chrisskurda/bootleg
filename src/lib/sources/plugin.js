// ─── Library source plugins ──────────────────────────────────────────────────────────────────────────────────────────
// A *source plugin* lets bootleg list and stream music that is not a folder of files: a Subsonic server today; a
// YouTube Music / Spotify / Bandcamp / Jellyfin / … plugin tomorrow. Subsonic (./subsonic.js) is the reference
// implementation — copy it to start a new one. Register with `registerSource(plugin)`.
//
//   plugin = {
//     id: 'subsonic',                         // short, stable; becomes part of every track's path ("subsonic:<connection>/<trackId>")
//     name: 'Subsonic / OpenSubsonic',
//     description: 'Navidrome, Airsonic, Gonic, …',
//     fields: [{ key, label, type: 'url'|'text'|'password', required, placeholder, hint }],   // the connect form (built by the app)
//
//     async connect(values)  → { config, title }        // validate against the service. `config` is what we persist: it must NOT
//                                                         //   contain the plain password (derive tokens/keys); `title` names the connection.
//     secrets: ['token']                                  // config fields that are secret: the app keeps them in the OS keychain
//                                                         //   (src/lib/secrets.js) and hands them back in `session(config)`
//     session(config)        → session                  // rebuild a session from stored config WITHOUT any network call (offline start)
//     async *scan(session, { signal })  → yields { items: Item[], progress: 'text' }   // pages of tracks; the app shows progress
//     streamUrl(session, item)   → URL string           // what <audio> plays
//     coverUrl(session, item, px)→ URL string | ''      // optional
//     fetch(session, url, init)  → Response             // optional: authenticated fetch for the blob fallback (see net.js)
//     async playlists(session)   → [{ id, name, owner, items: [itemId…] }]   // optional: shown (read-only) in Playlists
//     async setRating(session, itemId, stars)          // optional, whole stars 0–5: bootleg ratings sync both ways
//     async setStarred(session, itemId, on)            // optional: the server's favourite/star ↔ the bootleg tag "starred"
//     async rescan(session)                            // optional: ask the server to re-read its files (after bootleg wrote tags)
//     offline: true                                      // optional: the service allows keeping copies on this computer (offline
//                                                         //   store, device sync). Leave it out when its terms forbid that (DRM'd
//                                                         //   or streaming-only services): their tracks are then never stored.
//     download(session, item, quality) → { url, ext, quality, headers?, bytes? }   // with offline: where to fetch a copy.
//                                                         //   quality: 'original' | 'high' | 'saver' (MP3 320 / 128 when the service
//                                                         //   can convert); return what you will actually send (`quality`, `ext`).
//   }
//   Item = { id, title, artist, album, albumArtist, year, track, disc, genre, duration, size, suffix, changed, coverId, bitrate, rating?, starred?, path? }
//     `path`: the file's real path inside the server's music folder, when the server reports it (used to write tag edits to files)
//     `id` must be stable; `changed` (ms or any increasing token) lets rescans notice edits.
//
// How it plugs in: items become library "sources" (./remote.js) that arrive already tagged, are cached like files, shown in
// the same lists, searchable, rated and annotated like any other track, and rescanned incrementally in the background.
const registry = new Map();
export const registerSource = p => { for (const k of ['id', 'name', 'fields', 'connect', 'session', 'scan', 'streamUrl']) if (!(k in p)) throw new Error(`source plugin is missing "${k}"`); registry.set(p.id, p); return p; };
export const getSource = id => registry.get(id) || null;
export const listSources = () => [...registry.values()];
