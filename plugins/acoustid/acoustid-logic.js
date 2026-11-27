// AcoustID: fingerprints of an album's tracks → AcoustID lookups → MusicBrainz releases ranked by how many of the
// album's tracks they hold. No network or native calls here; tested in acoustid.test.mjs.
export const API = 'https://api.acoustid.org/v2/lookup';

/// The form body of one lookup.
export const lookupBody = (key, print) => new URLSearchParams({ client: key, meta: 'recordings releases tracks', duration: String(Math.round(print.duration)), fingerprint: print.fingerprint, format: 'json' }).toString();

const names = as => (as || []).map(a => a.name + (a.joinphrase || '')).join('').trim() || (as || []).map(a => a.name).join(', ');

/// Votes from every track's lookup: `answers` = [{ track: { number, disc }, json }] (one AcoustID response per track).
/// A release gets a full vote when the matched recording sits at that track's position on it, half a vote otherwise.
export function rank(answers, query) {
  const n = query.tracks.length || answers.length, by = new Map();
  for (const { track, json } of answers) {
    const best = (json?.results || []).filter(r => r.score >= 0.5).sort((a, b) => b.score - a.score)[0]; if (!best) continue;
    const seen = new Set();
    for (const rec of best.recordings || []) for (const rel of rec.releases || []) {
      if (seen.has(rel.id)) continue; seen.add(rel.id);
      const onIt = (rel.mediums || []).some(m => (m.position || 1) === (track.disc || 1) && (m.tracks || []).some(t => t.position === track.number));
      const c = by.get(rel.id) || by.set(rel.id, { rel, votes: 0, tracks: 0, recordings: [] }).get(rel.id);
      c.votes += onIt || !rel.mediums ? 1 : 0.5; c.tracks++; c.recordings.push({ number: track.number, disc: track.disc || 1, recordingId: rec.id, title: rec.title || '' });
    }
  }
  return [...by.values()].map(({ rel, votes, tracks, recordings }) => {
    const d = rel.date || {}, date = [d.year, d.month && String(d.month).padStart(2, '0'), d.day && String(d.day).padStart(2, '0')].filter(Boolean).join('-');
    const countFit = rel.track_count ? Math.min(rel.track_count, n) / Math.max(rel.track_count, n) : 0.5;
    const score = Math.round(Math.min(1, votes / n) * (0.8 + 0.2 * countFit) * 100) / 100;
    const fmt = (rel.mediums || [])[0]?.format || '';
    return {
      id: rel.id, title: rel.title || '', artist: names(rel.artists), score, url: `https://musicbrainz.org/release/${rel.id}`,
      summary: [date, rel.country, fmt, rel.track_count ? `${rel.track_count} tracks` : '', `${tracks} of ${n} heard`].filter(Boolean).join(' · '),
      facts: [{ label: 'Identified by sound', value: `${tracks} of ${n} tracks (AcoustID)` }, ...(date ? [{ label: 'Released', value: date }] : []), ...(rel.country ? [{ label: 'Country', value: rel.country }] : [])],
      tags: { album: rel.title || '', albumArtist: names(rel.artists), year: d.year || '', releaseId: rel.id },
      recordings,
    };
  }).sort((a, b) => b.score - a.score);
}

/// AcoustID's error → a sentence for the user.
export function errorText(json) {
  const e = json?.error || {}; if (e.code === 4) return 'The AcoustID API key was not accepted. Check it in Settings → Plugins → AcoustID.';
  if (e.code === 14) return 'AcoustID is busy (too many requests). Try again in a moment.';
  return `AcoustID: ${e.message || 'error'}`;
}
