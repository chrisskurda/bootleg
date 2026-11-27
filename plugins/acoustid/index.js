// AcoustID metadata provider: identifies an album by the sound of its tracks. The native part fingerprints the local
// files (Chromaprint-compatible); each print is looked up on AcoustID, and the MusicBrainz releases that hold the most of
// the album's tracks are offered as candidates in the album pane (src/lib/metadata.js).
import { API, lookupBody, rank, errorText } from './acoustid-logic.js';

const MAX_TRACKS = 40;
export function activate(api) {
  if (!api.native) return { status: () => 'Needs the desktop app with the AcoustID plugin built in.' };
  let last = 0; const gap = 350;      // AcoustID allows 3 requests a second
  const post = async body => { const w = last + gap - Date.now(); if (w > 0) await new Promise(r => setTimeout(r, w)); last = Date.now();
    const r = await api.net.fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }); return r.json(); };
  const provider = {
    id: 'acoustid', name: 'AcoustID (by sound)',
    async lookup(q, { signal } = {}) {
      if (q.kind !== 'album') return [];
      const tracks = q.tracks.filter(t => t.path).slice(0, MAX_TRACKS); if (!tracks.length) return [];
      const key = await api.secrets.get('apiKey'); if (!key) throw new Error('Add your AcoustID API key in Settings → Plugins → AcoustID to identify albums by sound.');
      const prints = new Map(); const job = api.native.job('fingerprint', { paths: tracks.map(t => t.path) }, ev => { if (ev.type === 'event' && ev.data.fingerprint) prints.set(ev.data.path, ev.data); });
      signal?.addEventListener?.('abort', () => job.cancel()); await job.done;
      const answers = [];
      for (const t of tracks) {
        if (signal?.aborted) break; const p = prints.get(t.path); if (!p) continue;
        const json = await post(lookupBody(key, p)); if (json.status !== 'ok') throw new Error(errorText(json));
        answers.push({ track: t, json });
      }
      return rank(answers, q);
    },
  };
  const unregister = api.metadata.register(provider);
  return { stop: unregister, status: () => 'albums: Find details online… in the album pane', _test: { provider } };
}
