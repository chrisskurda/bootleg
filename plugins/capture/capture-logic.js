// Capture plugin: tracks from a recording's analysis, editing the splits, titles from a metadata lookup, and what a saved
// track carries into the library. No page, no native calls; tested in capture.test.mjs.
export const SOURCES = { vinyl: { label: 'Vinyl', kind: 'vinyl-rip', deck: 'Turntable / cartridge' }, tape: { label: 'Tape', kind: 'tape-transfer', deck: 'Tape deck' }, other: { label: 'Other', kind: 'analogue-recording', deck: 'Source' } };
export const fmtT = s => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
const MIN_TRACK = 2;

/// Edges (start, splits…, end) → tracks numbered from `first`, keeping titles already typed for the same position.
export function tracksFrom({ start, end, splits }, first = 1, old = []) {
  const e = [start, ...splits.filter(s => s > start + MIN_TRACK && s < end - MIN_TRACK).sort((a, b) => a - b), end];
  return e.slice(1).map((b, i) => ({ start: e[i], end: b, number: first + i, title: old[i]?.title || '', artist: old[i]?.artist || '' }));
}
/// A split added at `t` (ignored within 2 s of another edge), removed, or moved.
export function addSplit(splits, t, start, end) { if (t <= start + MIN_TRACK || t >= end - MIN_TRACK || splits.some(s => Math.abs(s - t) < MIN_TRACK)) return splits; return [...splits, t].sort((a, b) => a - b); }
export const removeSplit = (splits, i) => splits.filter((_, k) => k !== i);
export function moveSplit(splits, i, dt, start, end) { const lo = (i ? splits[i - 1] : start) + MIN_TRACK, hi = (i < splits.length - 1 ? splits[i + 1] : end) - MIN_TRACK; return splits.map((s, k) => (k === i ? Math.min(hi, Math.max(lo, s + dt)) : s)); }

/// The metadata query for a side: its tracks' lengths (MusicBrainz scores on them) and whatever album/artist is typed.
export const sideQuery = (meta, tracks) => ({ kind: 'album', album: meta.album || '', artist: meta.albumArtist || '', year: +meta.year || 0, discs: 1, tracks: tracks.map(t => ({ number: t.number, disc: 1, title: t.title, artist: '', duration: t.end - t.start })) });

/// Titles from a chosen release: the side's tracks matched to the release's in order, starting from the release track
/// whose run of lengths fits best (side B starts part-way through an LP's track list).
export function fillFrom(tracks, cand) {
  const rt = (cand.tracks || []).slice().sort((a, b) => (a.disc || 1) - (b.disc || 1) || a.number - b.number); if (!rt.length) return { tracks, offset: -1 };
  let best = 0, bestErr = Infinity;
  for (let off = 0; off + tracks.length <= rt.length || off === 0; off++) {
    let err = 0; for (let i = 0; i < tracks.length; i++) { const r = rt[off + i]; err += r?.duration ? Math.abs(r.duration - (tracks[i].end - tracks[i].start)) : 30; }
    if (err < bestErr) { bestErr = err; best = off; } if (off + tracks.length >= rt.length) break;
  }
  return { offset: best, tracks: tracks.map((t, i) => { const r = rt[best + i]; return r ? { ...t, title: r.title || t.title, artist: r.artist && r.artist !== cand.artist ? r.artist : t.artist, number: best + i + 1 } : t; }) };
}

/// What each saved track carries into the library (api.library.import).
export function importInfo(saved, { source, deck, input, meta }, today = new Date().toISOString().slice(0, 10)) {
  const src = SOURCES[source] || SOURCES.other, total = saved.reduce((n, s) => n + s.clicks, 0);
  return {
    provenance: { kind: src.kind, date: today, device: [deck, input].filter(Boolean).join(' → '), source: [meta.album, meta.albumArtist].filter(Boolean).join(' — '), note: `Recorded with bootleg${total ? `; ${total} click${total === 1 ? '' : 's'} removed` : ''}` },
    tags: [src.kind],
  };
}
