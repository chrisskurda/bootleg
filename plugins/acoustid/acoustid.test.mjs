import { lookupBody, rank, errorText } from './acoustid-logic.js';
import { activate } from './index.js';
let bad = 0; const t = (n, ok, note = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${note ? '   ' + note : ''}`); if (!ok) bad++; };

const q = { kind: 'album', album: '?', artist: '', tracks: [1, 2, 3].map(n => ({ number: n, disc: 1, title: '', duration: 200, path: `/m/${n}.flac` })) };
const rel = (id, positions, o = {}) => ({ id, title: 'Album ' + id, artists: [{ name: 'Band' }], country: 'GB', date: { year: 2001, month: 3 }, track_count: 3, mediums: [{ position: 1, format: 'CD', tracks: positions.map(p => ({ position: p })) }], ...o });
const answer = (n, releases, score = 0.95) => ({ track: q.tracks[n - 1], json: { status: 'ok', results: [{ score, recordings: [{ id: 'rec' + n, title: 'T' + n, releases }] }] } });

t('a lookup sends the key, the length and the print', (() => { const p = new URLSearchParams(lookupBody('KEY', { duration: 200.4, fingerprint: 'AQAA' })); return p.get('client') === 'KEY' && p.get('duration') === '200' && p.get('fingerprint') === 'AQAA' && p.get('meta') === 'recordings releases tracks'; })());
const ranked = rank([answer(1, [rel('A', [1]), rel('B', [5])]), answer(2, [rel('A', [2])]), answer(3, [rel('A', [3]), rel('C', [3], { track_count: 12 })]), { track: q.tracks[0], json: { status: 'ok', results: [{ score: 0.2, recordings: [{ id: 'x', releases: [rel('Z', [1])] }] }] } }], q);
t('the release that holds every track, at the right positions, comes first with a full score', ranked[0].id === 'A' && ranked[0].score === 1 && /3 of 3 heard/.test(ranked[0].summary));
t('a release with the track elsewhere counts half; a compilation of 12 tracks scores lower', ranked.find(c => c.id === 'B').score < ranked.find(c => c.id === 'A').score && ranked.find(c => c.id === 'C').score < 0.4);
t('weak matches (score < 0.5) are ignored', !ranked.some(c => c.id === 'Z'));
t('candidates carry facts, tags and the recordings found', ranked[0].facts[0].value === '3 of 3 tracks (AcoustID)' && ranked[0].tags.year === 2001 && ranked[0].recordings.length === 3 && ranked[0].url.endsWith('/release/A') && /2001-03/.test(ranked[0].summary));
t('errors in words', /not accepted/.test(errorText({ error: { code: 4, message: 'invalid API key' } })));

{ // the plugin, with mocked native fingerprints and AcoustID
  let key = null, posts = []; const providers = [];
  const api = { native: { job: (cmd, args, on) => { for (const p of args.paths) on({ type: 'event', data: { path: p, duration: 200, fingerprint: 'FP' + p } }); return { done: Promise.resolve({}), cancel() {} }; } },
    secrets: { get: async () => key }, metadata: { register: p => { providers.push(p); return () => {}; } },
    net: { fetch: async (url, init) => { posts.push(new URLSearchParams(init.body)); const n = +posts.at(-1).get('fingerprint').match(/(\d)\.flac/)[1]; return { json: async () => answer(n, [rel('A', [n])]).json }; } } };
  activate(api); const p = providers[0];
  let err = ''; try { await p.lookup(q); } catch (e) { err = e.message; } t('without an API key it says where to add one', /Settings → Plugins → AcoustID/.test(err));
  key = 'K'; const cs = await p.lookup(q);
  t('with one, every local track is fingerprinted and looked up, and the album is identified', posts.length === 3 && posts.every(x => x.get('client') === 'K') && cs[0].id === 'A' && cs[0].score === 1);
  t('nothing to fingerprint (server tracks): no candidates, no requests', (await p.lookup({ ...q, tracks: q.tracks.map(x => ({ ...x, path: '' })) })).length === 0 && posts.length === 3);
}
console.log(bad ? `\n${bad} FAILED` : '\nall acoustid tests pass'); process.exit(bad ? 1 : 0);
