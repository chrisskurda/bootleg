// Metadata providers (plugin spec 2.0 §6, `api.metadata.register`): MusicBrainz and the like look an album up and offer
// candidates; the user picks the right one, and from then on its facts join the album's details (each with its provider as
// the source chip), its cover stands in when the files have none, and the tag editor can fill fields from it.
//
//   provider  = { id, name, lookup(query, { signal }) → Candidate[] }
//   query     = { kind: 'album', artist, album, year, discs, tracks: [{ number, disc, title, artist, duration, path }] }   (path: local files only)
//             | { kind: 'disc', musicbrainzId, musicbrainzToc, tracks }   (a CD in the drive)
//   Candidate = { id, title, artist, score: 0..1, url?, cover?, summary?,
//                 facts: [{ label, value }], text?: [{ label, text }],
//                 tags?: { album, albumArtist, year, genre, label, catalog, barcode, releaseId, … },
//                 tracks?: [{ number, disc, title, artist, duration, recordingId }] }
// Nothing is looked up unless the user asks; a chosen candidate is kept (IndexedDB) so the album shows it offline.

const providers = new Map();
export function registerProvider(p) {
  for (const k of ['id', 'name', 'lookup']) if (!(k in p)) throw new Error(`metadata provider is missing "${k}"`);
  providers.set(p.id, p); return () => { if (providers.get(p.id) === p) providers.delete(p.id); };
}
export const listProviders = () => [...providers.values()];
export const getProvider = id => providers.get(id) || null;

/// The query for an album in the library.
export function albumQuery(a) {
  const ts = a.tracks || [];
  return { kind: 'album', artist: a.artist || '', album: a.album || '', year: Math.min(...ts.map(t => +t.year).filter(Boolean)) || 0, discs: new Set(ts.map(t => t.disc || 1)).size,
    tracks: ts.map((t, i) => ({ number: t.track || i + 1, disc: t.disc || 1, title: t.title || '', artist: t.artist || '', duration: t.duration || 0, path: t.src?.kind === 'tauri' ? t.src.path : '' })) };
}

/// Every provider at once; a provider that fails is reported in `errors`, not thrown. Best first.
export async function lookupAll(query, { signal, only } = {}) {
  const ps = listProviders().filter(p => !only || p.id === only), errors = [];
  const lists = await Promise.all(ps.map(p => Promise.resolve().then(() => p.lookup(query, { signal })).then(cs => (cs || []).map(c => ({ ...c, provider: p.id, providerName: p.name })), e => { errors.push({ provider: p.name, message: e?.message || String(e) }); return []; })));
  return { candidates: lists.flat().sort((x, y) => (y.score || 0) - (x.score || 0)), errors };
}

/// How well a candidate's track list fits the album: 0..1 (track count, then lengths within 3 s).
export function trackFit(query, tracks) {
  if (!tracks?.length || !query.tracks?.length) return 0;
  const count = Math.min(tracks.length, query.tracks.length) / Math.max(tracks.length, query.tracks.length);
  const mine = query.tracks.slice().sort((a, b) => a.disc - b.disc || a.number - b.number), theirs = tracks.slice().sort((a, b) => (a.disc || 1) - (b.disc || 1) || a.number - b.number);
  let close = 0, n = 0; for (let i = 0; i < Math.min(mine.length, theirs.length); i++) { if (mine[i].duration && theirs[i].duration) { n++; if (Math.abs(mine[i].duration - theirs[i].duration) <= 3) close++; } }
  return n ? count * 0.4 + (close / Math.max(mine.length, theirs.length)) * 0.6 : count;
}

/// The chosen candidate per album key, kept in a KV store (`get(store, key)` / `put(store, key, value)`).
export class Chosen {
  constructor(kv) { this.kv = kv; this.mem = new Map(); }
  async get(key) { if (!this.mem.has(key)) this.mem.set(key, (await this.kv.get('chosen', key).catch(() => null)) || null); return this.mem.get(key); }
  async set(key, c) { const v = c ? JSON.parse(JSON.stringify({ ...c, chosenAt: Date.now() })) : null; this.mem.set(key, v); await this.kv.put('chosen', key, v); }
}

/// A chosen candidate's facts for the album's details (albumFacts `extra`).
export const extraFacts = c => (c ? { facts: (c.facts || []).map(f => ({ ...f, source: c.provider })), text: (c.text || []).map(x => ({ ...x, source: c.providerName || c.provider })) } : null);

/// Album-wide tag suggestions for the tag editor.
export const tagSuggestion = c => (c?.tags ? { from: c.providerName || c.provider, fields: Object.fromEntries(Object.entries(c.tags).filter(([, v]) => v !== '' && v != null)) } : null);
