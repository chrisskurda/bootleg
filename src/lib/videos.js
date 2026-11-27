// Music videos (docs/VIDEOS.md): which video goes with which track, across every source. Videos come from local folders and
// from source plugins (Jellyfin, Plex, …: Items with kind 'video'); tracks from anywhere. A track's videos are
//   • found automatically: same artist and title once the usual decorations are gone ("(Official Video)", "[4K]", "feat. …"),
//   • linked by hand (any video to any track), and
//   • hidden: an automatic match the user said is wrong.
// No DOM here (tested in tests/videos.test.mjs); the store is any { get(store, key), put(store, key, value) } (IdbKV).

export const VIDEO_RE = /\.(mp4|m4v|mkv|webm|mov)$/i;

// Bracketed parts that only describe the upload, not the song.
const NOISE = /\b(official|music|video|clip|hd|hq|4k|1080p|720p|uhd|remaster(ed)?|lyrics?|visuali[sz]er|audio|explicit|clean|version|mv|uncensored|dirty|vevo|full)\b/;
const fold = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
/// A title reduced to what identifies the song: no upload decorations, no featured artists, no punctuation.
export function normTitle(s) {
  let t = fold(s);
  t = t.replace(/[([{]([^)\]}]*)[)\]}]/g, (m, inner) => NOISE.test(inner) || /\b(feat|ft|featuring|with)\b/.test(inner) ? ' ' : m);
  t = t.replace(/\s[-–|]\s*(official|music video|video|lyric|audio|visuali[sz]er)\b.*$/, ' ');
  t = t.replace(/\s(feat\.?|ft\.?|featuring)\s.*$/, ' ');
  return t.replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
/// The first credited artist, reduced the same way ("Daft Punk feat. Pharrell" → "daft punk"; "The Cure" → "cure").
export function normArtist(s) {
  const a = fold(s).split(/\s*(?:,|;|\/|\bfeat\.?|\bft\.?|\bfeaturing\b|\bx\b|\bvs\.?|&|\band\b)\s*/)[0] || '';
  return a.replace(/^the\s+/, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
export const matchKey = (artist, title) => { const a = normArtist(artist), t = normTitle(title); return a && t ? `${a}\u0000${t}` : ''; };

/// What a video file's name says: "Artist - Title (Official Video).mp4" → { artist, title }; anything else → { title }.
export const fromFileName = name => splitTitle(String(name).replace(/\.[^.]+$/, '').replace(/_/g, ' '));
/// "Artist - Title" in one string (a file name, a server's or YouTube's title) → { artist, title }; else { artist: '', title }.
export function splitTitle(s) {
  const base = String(s || '').replace(/\s+/g, ' ').trim(), m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(base);
  return m ? { artist: m[1].trim(), title: m[2].trim() } : { artist: '', title: base };
}

/// The automatic index: matchKey → [video]. Rebuild when the library's videos change.
export function videoIndex(videos) {
  const ix = new Map();
  for (const v of videos) { const k = matchKey(v.artist, v.title); if (k) (ix.get(k) || ix.set(k, []).get(k)).push(v); }
  return ix;
}

/// Hand-made links and hidden matches, keyed by the track's annotation key (the same key notes use, so they survive
/// rescans). Video ids are their library paths ("/Videos/x.mp4", "jellyfin:c1/abc").
export class VideoLinks extends EventTarget {
  constructor(kv, store = 'links') { super(); this.kv = kv; this.store = store; this.linked = new Map(); this.hidden = new Map(); this.ready = this._load(); }
  async _load() {
    const v = await this.kv?.get(this.store, 'all').catch(() => null);
    for (const [k, a] of Object.entries(v?.linked || {})) this.linked.set(k, new Set(a));
    for (const [k, a] of Object.entries(v?.hidden || {})) this.hidden.set(k, new Set(a));
  }
  _save() {
    const o = m => Object.fromEntries([...m].filter(([, s]) => s.size).map(([k, s]) => [k, [...s]]));
    this.dispatchEvent(new Event('change'));
    return this.kv?.put(this.store, 'all', { linked: o(this.linked), hidden: o(this.hidden) });
  }
  _set(m, k) { return m.get(k) || m.set(k, new Set()).get(k); }
  link(trackKey, videoPath) { this._set(this.linked, trackKey).add(videoPath); this.hidden.get(trackKey)?.delete(videoPath); return this._save(); }
  /// Removes a link; an automatic match is hidden instead (so it doesn't come back on the next scan).
  unlink(trackKey, videoPath, auto) { this.linked.get(trackKey)?.delete(videoPath); if (auto) this._set(this.hidden, trackKey).add(videoPath); return this._save(); }
  restore(trackKey) { this.hidden.delete(trackKey); return this._save(); }
  export() { const o = m => Object.fromEntries([...m].map(([k, s]) => [k, [...s]])); return { linked: o(this.linked), hidden: o(this.hidden) }; }
}

/// A track's videos, hand-linked first, then automatic matches (not hidden). → [{ video, how: 'linked' | 'auto' }]
/// `byPath`: path → library video. `index`: videoIndex(). `key`: the track's annotation key.
export function videosFor(track, key, { links, index, byPath }) {
  if (!track || track.kind === 'video') return [];
  const out = [], seen = new Set(), hidden = links?.hidden.get(key);
  for (const p of links?.linked.get(key) || []) { const v = byPath.get(p); if (v && !seen.has(v)) { seen.add(v); out.push({ video: v, how: 'linked' }); } }
  const mk = matchKey(track.artist || track.albumArtist, track.title);
  for (const v of (mk && index.get(mk)) || []) if (!seen.has(v) && !hidden?.has(v.src.path)) { seen.add(v); out.push({ video: v, how: 'auto' }); }
  return out;
}

/// Videos for the "link a video" picker: everything, best guesses for this track first, filtered by a typed query.
export function pickList(videos, track, q = '') {
  const words = fold(q).split(/\s+/).filter(Boolean), ta = normArtist(track?.artist), tt = normTitle(track?.title);
  const score = v => (normArtist(v.artist) === ta ? 2 : 0) + (tt && normTitle(v.title).includes(tt) ? 1 : 0);
  return videos.filter(v => { const hay = fold(`${v.artist} ${v.title} ${v.src?.name || ''}`); return words.every(w => hay.includes(w)); })
    .map(v => [score(v), v]).sort((a, b) => b[0] - a[0] || String(a[1].artist).localeCompare(b[1].artist) || String(a[1].title).localeCompare(b[1].title)).map(x => x[1]);
}
