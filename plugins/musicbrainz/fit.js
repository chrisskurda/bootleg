// The plugin's own copy of src/lib/metadata.js trackFit, so it doesn't import the app's code (it updates separately).
/// How well a candidate's track list fits the album: 0..1 (track count, then lengths within 3 s).
export function trackFit(query, tracks) {
  if (!tracks?.length || !query.tracks?.length) return 0;
  const count = Math.min(tracks.length, query.tracks.length) / Math.max(tracks.length, query.tracks.length);
  const mine = query.tracks.slice().sort((a, b) => a.disc - b.disc || a.number - b.number), theirs = tracks.slice().sort((a, b) => (a.disc || 1) - (b.disc || 1) || a.number - b.number);
  let close = 0, n = 0; for (let i = 0; i < Math.min(mine.length, theirs.length); i++) { if (mine[i].duration && theirs[i].duration) { n++; if (Math.abs(mine[i].duration - theirs[i].duration) <= 3) close++; } }
  return n ? count * 0.4 + (close / Math.max(mine.length, theirs.length)) * 0.6 : count;
}

