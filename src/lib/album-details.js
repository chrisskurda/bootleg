// What we know about an album, merged from every source we have — each fact says where it came from.
//   tags (in the files / from a server) → album.nfo / artist.nfo → the folder or server itself → (later) metadata plugins
// Pure function: easy to test, and a metadata plugin (MusicBrainz, Last.fm, …) just contributes more candidate facts.
export const albumKey = a => 'album:' + (a.artist || '') + '|' + (a.album || '');

const uniq = xs => [...new Set(xs.filter(Boolean))];
const fmtLen = s => { s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60; return h ? `${h} h ${m} min` : m ? `${m} min ${sec} s` : `${sec} s`; };

/// `extra`: facts from a chosen metadata candidate (metadata.js extraFacts) — added where the album doesn't already say.
export function albumFacts(a, { libraryName = () => '', extra = null } = {}) {
  const ts = a.tracks, facts = [], add = (label, value, source) => { if (value !== undefined && value !== null && String(value).trim() !== '') facts.push({ label, value: String(value), source }); };
  const nfoAlbum = ts.map(t => t.nfo?.album).find(Boolean), nfoArtist = ts.map(t => t.nfo?.artist).find(Boolean);
  const remote = ts.some(t => t.remote), base = remote ? 'server' : 'tags', from = (field, fallback = base) => (ts.length && ts.every(t => t._nfoFilled?.has(field))) ? 'nfo' : fallback;   // tags unless every track's value was filled in from an .nfo

  add('Artist', a.artist || nfoAlbum?.artist || nfoArtist?.artist, a.artist ? from('artist') : 'nfo');
  const years = ts.map(t => +t.year).filter(Boolean), ty = years.length ? Math.min(...years) : 0; add('Year', ty || nfoAlbum?.year, ty ? from('year') : 'nfo');
  const genres = uniq(ts.flatMap(t => (t.genre || '').split(/\s*,\s*/))); add('Genre', genres.length ? genres.join(', ') : (nfoAlbum?.genres || nfoArtist?.genres || []).join(', '), genres.length ? from('genre') : 'nfo');
  add('Label', nfoAlbum?.label, 'nfo');
  const discs = uniq(ts.map(t => t.disc).filter(x => x > 0)); if (discs.length > 1) add('Discs', discs.length, 'tags');
  add('Tracks', ts.length, 'library');
  const dur = ts.reduce((n, t) => n + (t.duration || 0), 0); if (dur) add('Length', fmtLen(dur), remote ? 'server' : 'tags');
  const fmts = uniq(ts.map(t => (t.src?.name || '').split('.').pop().toUpperCase())); add('Format', fmts.join(', '), 'files');
  const bpms = ts.map(t => t.bpm).filter(Boolean); if (bpms.length) add('BPM', Math.round(bpms.reduce((x, y) => x + y, 0) / bpms.length), 'tags');
  const keys = uniq(ts.map(t => t.key)); if (keys.length) add('Key', keys.join(', '), 'tags');
  const dirs = uniq(ts.map(t => (t.src?.path || '').replace(/\/[^/]*$/, ''))); if (dirs.length && !remote) add('Folder', dirs.length === 1 ? dirs[0] : `${dirs.length} folders`, 'files');
  if (remote) add('From', uniq(ts.map(t => (t.src?.path || '').split('/')[0])).join(', '), 'server');
  const libs = uniq(ts.flatMap(t => [...(t.libs || [])]).map(libraryName)); if (libs.length) add('In libraries', libs.join(', '), 'bootleg');
  for (const f of extra?.facts || []) if (!facts.some(x => x.label === f.label)) add(f.label, f.value, f.source);
  const text = [];
  if (nfoAlbum?.text) text.push({ label: 'Review / notes', text: nfoAlbum.text, source: 'album.nfo' });
  if (nfoArtist?.text) text.push({ label: 'About the artist', text: nfoArtist.text, source: 'artist.nfo' });
  for (const n of ts.flatMap(t => t.nfo?.texts || []).filter((x, i, arr) => arr.findIndex(y => y.path === x.path) === i)) text.push({ label: n.path.split('/').pop(), text: n.text, source: 'nfo' });
  for (const x of extra?.text || []) text.push(x);
  return { facts, text };
}
