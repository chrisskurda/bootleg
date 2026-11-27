// MusicBrainz metadata provider: looks albums (and discs) up on MusicBrainz, with Cover Art Archive covers. The user picks
// the right release in the album pane (src/lib/metadata.js); its facts, cover and tag suggestions then come from here.
import { searchUrl, releaseUrl, discUrl, candidate, limiter } from './mb-logic.js';

export function activate(api) {
  const headers = { Accept: 'application/json', 'User-Agent': `bootleg/${api.platform?.appVersion || '0'} ( https://musicbrainz.org/doc/MusicBrainz_API )` };
  const get = limiter((url, init) => api.net.fetch(url, init));
  const json = url => get(url, { headers });
  const provider = {
    id: 'musicbrainz', name: 'MusicBrainz',
    async lookup(q, { signal } = {}) {
      if (q.kind === 'disc') { const j = await json(discUrl(q)); return (j.releases || []).map(r => candidate(r, q, { exact: true })); }
      if (q.kind !== 'album' || !q.album) return [];
      const hits = (await json(searchUrl(q))).releases || [];
      // the full release (with track lengths) for the best few hits, so the score can use them
      const quick = hits.map(r => candidate(r, q)).sort((a, b) => b.score - a.score), top = new Set(quick.slice(0, 4).map(c => c.id)), full = [];
      for (const r of hits) { if (signal?.aborted) break; if (top.has(r.id)) { try { full.push(candidate({ ...(await json(releaseUrl(r.id))), score: r.score }, q)); } catch { full.push(candidate(r, q)); } } }
      return [...full, ...quick.filter(c => !top.has(c.id))].sort((a, b) => b.score - a.score);
    },
  };
  const unregister = api.metadata.register(provider);
  return { stop: unregister, status: () => 'albums: Find details online… in the album pane', _test: { provider } };
}
