// .nfo files as a metadata source (album.nfo / artist.nfo / any *.nfo in a track's folders).
//   Kodi-style XML  <album>…</album> / <artist>…</artist>  → structured fields
//   anything else (scene/plain-text NFO)                    → kept as free text
// Tags inside the audio files always win; an NFO only fills what is missing and supplies descriptive text.
const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
const dec = s => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, c) => c).replace(/&(amp|lt|gt|quot|apos);|&#(\d+);|&#x([0-9a-f]+);/gi, (m, n, d, x) => ENT[m.toLowerCase()] ?? String.fromCodePoint(d ? +d : parseInt(x, 16))).trim();
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const all = (xml, tag) => [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi'))].map(m => dec(m[1]));
const one = (xml, tag) => all(xml, tag)[0];

export function parseNfo(text) {
  text = String(text || '').replace(/^﻿/, '');
  const root = /<\s*(album|artist)(?:\s[^>]*)?>([\s\S]*?)<\/\s*\1\s*>/i.exec(text);
  if (!root) return { kind: 'text', text: text.replace(/\r\n?/g, '\n').trim() };
  const kind = root[1].toLowerCase(), x = root[2], tracksXml = [...x.matchAll(/<track>([\s\S]*?)<\/track>/gi)].map(m => m[1]), body = x.replace(/<track>[\s\S]*?<\/track>/gi, '');
  const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : undefined; };
  const out = { kind, genres: all(body, 'genre').flatMap(g => g.split(/\s*[\/;,]\s*/)).filter(Boolean) };
  if (kind === 'album') Object.assign(out, { album: one(body, 'title'), artist: one(body, 'artist') || one(body, 'albumartist'), year: num(one(body, 'year')) || num((one(body, 'releasedate') || '').slice(0, 4)), label: one(body, 'label'), rating: num(one(body, 'rating')), text: one(body, 'review') || one(body, 'plot') || one(body, 'comment') || '',
    tracks: tracksXml.map(t => ({ position: num(one(t, 'position')), title: one(t, 'title'), duration: one(t, 'duration') })) });
  else Object.assign(out, { artist: one(body, 'name'), text: one(body, 'biography') || one(body, 'bio') || one(body, 'plot') || '', born: one(body, 'born') || one(body, 'formed') });
  for (const k of Object.keys(out)) if (out[k] === undefined || out[k] === '') delete out[k];
  return out;
}
// Kodi rates 0–10; bootleg 0–5 (half stars).
export const nfoRatingToStars = r => r == null ? 0 : Math.max(0, Math.min(5, Math.round(r) / 2));

export function buildAlbumNfo({ album, artist, year, genres = [], label, rating, review, tracks = [] }) {
  const l = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>', '<album>', `  <title>${esc(album)}</title>`, artist && `  <artist>${esc(artist)}</artist>`, year && `  <year>${esc(year)}</year>`, ...genres.map(g => `  <genre>${esc(g)}</genre>`), label && `  <label>${esc(label)}</label>`, rating && `  <rating>${esc(rating * 2)}</rating>`, review && `  <review>${esc(review)}</review>`,
    ...tracks.map((t, i) => `  <track>\n    <position>${t.position || i + 1}</position>\n    <title>${esc(t.title)}</title>${t.duration ? `\n    <duration>${esc(t.duration)}</duration>` : ''}\n  </track>`), '</album>'];
  return l.filter(Boolean).join('\n') + '\n';
}
export const buildArtistNfo = ({ name, genres = [], biography }) => ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>', '<artist>', `  <name>${esc(name)}</name>`, ...genres.map(g => `  <genre>${esc(g)}</genre>`), biography && `  <biography>${esc(biography)}</biography>`, '</artist>'].filter(Boolean).join('\n') + '\n';
