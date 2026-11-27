// Finding playlists by name or by what is in them (the Playlists page, a device card's playlist picker). No DOM here.
//   searchPlaylists(playlists, query, resolve, { source, sort }) → [{ p, tracks, nameHit, hits }]
//     resolve(p) → the library tracks of a playlist; source: 'all' | 'mine' | 'server'; sort: 'name' | 'size' | 'recent'
//   With a query, playlists whose name matches come first, then the ones with the most matching tracks.
//   summaryOf(tracks) → { artists: 'Low, Duster, +12 more', count, duration }

const fold = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
const words = q => fold(q).split(/\s+/).filter(Boolean);
const hay = t => (t._plHay ||= fold([t.title, t.artist, t.albumArtist, t.album, t.genre].join(' ')));

export const SOURCES = { all: 'All playlists', mine: 'Mine', server: 'From servers' };
export const SORTS = { name: 'Name', size: 'Most tracks', recent: 'Recently changed' };

export function searchPlaylists(playlists, query, resolve, { source = 'all', sort = 'name' } = {}) {
  const w = words(query), out = [];
  for (const p of playlists) {
    if (source === 'mine' && p.server) continue;
    if (source === 'server' && !p.server) continue;
    const tracks = resolve(p);
    if (!w.length) { out.push({ p, tracks, nameHit: false, hits: [] }); continue; }
    const name = fold(p.name), nameHit = w.every(x => name.includes(x));
    const hits = tracks.filter(t => { const h = hay(t); return w.every(x => h.includes(x)); });
    if (nameHit || hits.length) out.push({ p, tracks, nameHit, hits });
  }
  const by = { name: (a, b) => a.p.name.localeCompare(b.p.name), size: (a, b) => b.p.items.length - a.p.items.length || by.name(a, b), recent: (a, b) => (b.p.updated || 0) - (a.p.updated || 0) || by.name(a, b) }[sort] || ((a, b) => a.p.name.localeCompare(b.p.name));
  return out.sort(w.length ? (a, b) => (b.nameHit - a.nameHit) || (b.hits.length - a.hits.length) || by(a, b) : by);
}

export function summaryOf(tracks, top = 3) {
  const n = new Map();
  for (const t of tracks) { const a = (t.albumArtist || t.artist || '').trim(); if (a) n.set(a, (n.get(a) || 0) + 1); }
  const names = [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(x => x[0]);
  return { artists: names.slice(0, top).join(', ') + (names.length > top ? `, +${names.length - top} more` : ''), count: tracks.length, duration: tracks.reduce((s, t) => s + (t.duration || 0), 0) };
}
