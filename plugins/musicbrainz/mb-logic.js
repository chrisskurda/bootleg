// MusicBrainz releases → metadata candidates (src/lib/metadata.js). No network here; tested in musicbrainz.test.mjs.
import { trackFit } from './fit.js';

export const MB = 'https://musicbrainz.org/ws/2';
const INC = 'artist-credits+labels+recordings+release-groups+genres+isrcs';
const phrase = s => `"${String(s).replace(/[\\"]/g, '\\$&')}"`;
/// Release search (Lucene syntax): album title and artist, best first by MusicBrainz's own score.
export function searchUrl(q) {
  const parts = [`release:${phrase(q.album)}`]; if (q.artist) parts.push(`artist:${phrase(q.artist)}`);
  return `${MB}/release/?query=${encodeURIComponent(parts.join(' AND '))}&limit=15&fmt=json`;
}
export const releaseUrl = id => `${MB}/release/${id}?inc=${INC}&fmt=json`;
export const discUrl = q => `${MB}/discid/${encodeURIComponent(q.musicbrainzId)}?toc=${q.musicbrainzToc}&cdstubs=no&inc=${INC}&fmt=json`;

export const credit = ac => (ac || []).map(a => (a.name || a.artist?.name || '') + (a.joinphrase || '')).join('');
const formats = r => { const f = new Map(); for (const m of r.media || []) f.set(m.format || '?', (f.get(m.format || '?') || 0) + 1); return [...f].map(([k, n]) => (n > 1 ? `${n}×${k}` : k)).join(' + '); };
const trackCount = r => (r.media || []).reduce((n, m) => n + (m['track-count'] ?? m.tracks?.length ?? 0), 0);

/// A release (full lookup or search hit) → Candidate. `query` is the album being looked up (for the score).
export function candidate(r, query, { exact = false } = {}) {
  const rg = r['release-group'] || {}, li = (r['label-info'] || [])[0] || {}, artist = credit(r['artist-credit']);
  const genres = (r.genres?.length ? r.genres : rg.genres || []).slice().sort((a, b) => (b.count || 0) - (a.count || 0)).map(g => g.name);
  const tracks = (r.media || []).flatMap(m => (m.tracks || []).map(t => ({ number: +t.position || +t.number || 0, disc: m.position || 1, title: t.title || t.recording?.title || '', artist: credit(t['artist-credit'] || t.recording?.['artist-credit']) || artist, duration: (t.length || t.recording?.length || 0) / 1000, recordingId: t.recording?.id || '' })));
  const type = [rg['primary-type'], ...(rg['secondary-types'] || [])].filter(Boolean).join(' + ');
  const n = trackCount(r), year = (r.date || '').slice(0, 4);
  const facts = [
    ['Released', r.date], ['Country', r.country], ['Label', li.label?.name], ['Catalog no.', li['catalog-number']], ['Barcode', r.barcode],
    ['Release type', type], ['Format', formats(r)], ['Status', r.status], ['Genres', genres.slice(0, 4).join(', ')],
  ].filter(([, v]) => v).map(([label, value]) => ({ label, value: String(value) }));
  // the score: MusicBrainz's text match, how well the tracks fit (count and lengths), and the year
  const fit = tracks.length ? trackFit(query, tracks) : (query.tracks?.length && n ? Math.min(n, query.tracks.length) / Math.max(n, query.tracks.length) * 0.6 : 0);
  const yearOk = query.year && year ? (String(query.year) === year ? 1 : 0) : 0.5;
  const score = exact ? 1 : Math.round(((r.score ?? 80) / 100 * 0.35 + fit * 0.55 + yearOk * 0.1) * 100) / 100;
  return {
    id: r.id, title: r.title || '', artist, score, url: `https://musicbrainz.org/release/${r.id}`,
    cover: r['cover-art-archive']?.front || r['cover-art-archive']?.count ? `https://coverartarchive.org/release/${r.id}/front-250` : '',
    summary: [r.date, r.country, formats(r), li.label?.name, n ? `${n} tracks` : ''].filter(Boolean).join(' · '),
    facts, tracks,
    tags: { album: r.title || '', albumArtist: artist, year: year ? +year : '', genre: genres[0] || '', label: li.label?.name || '', catalog: li['catalog-number'] || '', barcode: r.barcode || '', releaseId: r.id, releaseGroupId: rg.id || '' },
  };
}

/// Spacing calls to MusicBrainz: at most one a second (their rule), one retry on 503 (rate limited).
export function limiter(fetchFn, { gap = 1100, sleep = ms => new Promise(r => setTimeout(r, ms)), now = () => Date.now() } = {}) {
  let last = 0, chain = Promise.resolve();
  return (url, init) => (chain = chain.then(async () => {
    for (let attempt = 0; ; attempt++) {
      const wait = last + gap - now(); if (wait > 0) await sleep(wait); last = now();
      const r = await fetchFn(url, init); if (r.status === 503 && attempt === 0) { await sleep(2000); continue; }
      if (!r.ok) throw new Error(`MusicBrainz: HTTP ${r.status}`); return r.json();
    }
  }));
}
