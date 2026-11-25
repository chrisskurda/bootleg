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
//     session(config)        → session                  // rebuild a session from stored config WITHOUT any network call (offline start)
//     async *scan(session, { signal })  → yields { items: Item[], progress: 'text' }   // pages of tracks; the app shows progress
//     streamUrl(session, item)   → URL string           // what <audio> plays
//     coverUrl(session, item, px)→ URL string | ''      // optional
//     fetch(session, url, init)  → Response             // optional: authenticated fetch for the blob fallback (see net.js)
//   }
//   Item = { id, title, artist, album, albumArtist, year, track, disc, genre, duration, size, suffix, changed, coverId, bitrate }
//     `id` must be stable; `changed` (ms or any increasing token) lets rescans notice edits.
//
// How it plugs in: items become library "sources" (./remote.js) that arrive already tagged, are cached like files, shown in
// the same lists, searchable, rated and annotated like any other track, and rescanned incrementally in the background.
const registry = new Map();
export const registerSource = p => { for (const k of ['id', 'name', 'fields', 'connect', 'session', 'scan', 'streamUrl']) if (!(k in p)) throw new Error(`source plugin is missing "${k}"`); registry.set(p.id, p); return p; };
export const getSource = id => registry.get(id) || null;
export const listSources = () => [...registry.values()];
