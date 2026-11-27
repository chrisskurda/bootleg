import { searchUrl, candidate, limiter, credit } from './mb-logic.js';
import { activate } from './index.js';
import { albumQuery, lookupAll, registerProvider, trackFit, Chosen, extraFacts, tagSuggestion } from '../../src/lib/metadata.js';
import { trackFit as pluginFit } from './fit.js';
import { albumFacts } from '../../src/lib/album-details.js';
let bad = 0; const t = (n, ok, note = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${note ? '   ' + note : ''}`); if (!ok) bad++; };

// an album in the library, and MusicBrainz-shaped releases
const album = { artist: 'The Band', album: 'Live "at" Home', tracks: [1, 2, 3].map(n => ({ title: `Song ${n}`, artist: 'The Band', track: n, disc: 1, year: 1999, duration: 180 + n * 10 })) };
const q = albumQuery(album);
const rel = (id, o = {}) => ({ id, score: 100, title: 'Live "at" Home', date: '1999-05-01', country: 'GB', barcode: '5012345678900', status: 'Official',
  'artist-credit': [{ name: 'The Band', joinphrase: ' & ' }, { name: 'Friends' }], 'label-info': [{ 'catalog-number': 'CAT 1', label: { name: 'Label Co' } }],
  'release-group': { id: 'rg1', 'primary-type': 'Album', 'secondary-types': ['Live'], genres: [{ name: 'rock', count: 5 }, { name: 'folk', count: 9 }] }, 'cover-art-archive': { front: true },
  media: [{ position: 1, format: 'CD', 'track-count': 3, tracks: [1, 2, 3].map(n => ({ id: 't' + n, position: n, title: `Song ${n}`, length: (180 + n * 10) * 1000, recording: { id: 'r' + n } })) }], ...o });

t('the search asks for the album and the artist, quotes escaped', decodeURIComponent(searchUrl(q)).includes('release:"Live \\"at\\" Home" AND artist:"The Band"'));
t('artist credits are joined', credit(rel('a')['artist-credit']) === 'The Band & Friends');
const c = candidate(rel('a'), q);
t('a release becomes a candidate: facts, cover, summary, tracks', c.facts.find(f => f.label === 'Label').value === 'Label Co' && c.facts.find(f => f.label === 'Release type').value === 'Album + Live' && c.facts.find(f => f.label === 'Genres').value === 'folk, rock' && c.cover.endsWith('/release/a/front-250') && /1999-05-01 · GB · CD · Label Co · 3 tracks/.test(c.summary) && c.tracks.length === 3 && c.tracks[2].duration === 210);
t('…with tag suggestions', c.tags.album === 'Live "at" Home' && c.tags.year === 1999 && c.tags.genre === 'folk' && c.tags.catalog === 'CAT 1' && c.tags.releaseId === 'a');
const wrongLen = candidate(rel('b', { media: [{ position: 1, format: 'CD', tracks: [1, 2, 3].map(n => ({ position: n, title: 'x', length: 400000 })) }] }), q), wrongYear = candidate(rel('c', { date: '2005' }), q);
t('the score prefers matching track lengths and the year', c.score > wrongYear.score && wrongYear.score > wrongLen.score, `${c.score} ${wrongYear.score} ${wrongLen.score}`);
t('track fit: same count and lengths = 1; the plugin\'s copy agrees with the app\'s', trackFit(q, c.tracks) === 1 && pluginFit(q, c.tracks) === 1 && trackFit(q, c.tracks.slice(0, 1)) < 0.5);

{ // the rate limiter
  let now = 0, slept = 0, calls = 0; const f = async () => { calls++; return { ok: true, status: 200, json: async () => ({ n: calls }) }; };
  const get = limiter(f, { now: () => now, sleep: async ms => { slept += ms; now += ms; } });
  await Promise.all([get('a'), get('b'), get('c')]); t('at most one request a second', calls === 3 && slept >= 2200, `slept ${slept}`);
  let first = true; const busy = limiter(async () => (first ? (first = false, { ok: false, status: 503 }) : { ok: true, status: 200, json: async () => 'ok' }), { now: () => now, sleep: async ms => { now += ms; } });
  t('a 503 is retried once', (await busy('x')) === 'ok');
}

{ // the plugin, with a mocked MusicBrainz, through the app's registry
  const seen = []; let registered = null;
  const api = { platform: { appVersion: '0.7.0' }, net: { fetch: async (url, init) => { seen.push({ url, init }); const j = url.includes('/release/?query') ? { releases: [rel('a', { media: [{ position: 1, format: 'CD', 'track-count': 3 }] }), rel('b', { score: 90, date: '2010' })] } : rel(url.match(/release\/([^?]+)/)[1]); return { ok: true, status: 200, json: async () => j }; } }, metadata: { register: p => { registered = p; return registerProvider(p); } } };
  const inst = activate(api);
  const { candidates, errors } = await lookupAll(q);
  t('the plugin registers a provider and its candidates come back best first, looked up in full', registered?.id === 'musicbrainz' && !errors.length && candidates[0].id === 'a' && candidates[0].tracks.length === 3 && candidates[0].provider === 'musicbrainz' && candidates[0].providerName === 'MusicBrainz');
  t('it says who it is', /^bootleg\/0\.7\.0/.test(seen[0].init.headers['User-Agent']));
  inst.stop(); t('stopping it unregisters it', (await lookupAll(q)).candidates.length === 0);
  registerProvider({ id: 'broken', name: 'Broken', lookup: async () => { throw new Error('offline'); } });
  const r2 = await lookupAll(q); t('a provider that fails is reported, not thrown', r2.errors[0].provider === 'Broken' && r2.errors[0].message === 'offline');
}

{ // a chosen release in the album's details
  const kv = new Map(), ch = new Chosen({ get: async (s, k) => kv.get(s + k), put: async (s, k, v) => kv.set(s + k, v) });
  await ch.set('album:x', { ...c, provider: 'musicbrainz', providerName: 'MusicBrainz' });
  const back = await new Chosen({ get: async (s, k) => kv.get(s + k), put: async () => {} }).get('album:x');
  t('the chosen release is kept', back.id === 'a' && back.chosenAt > 0);
  const { facts } = albumFacts({ ...album, tracks: album.tracks.map(x => ({ ...x, src: { name: 'a.flac', path: '/m/a.flac' }, libs: new Set() })) }, { extra: extraFacts(back) });
  t('its facts join the album details with their source, without overriding what the files say', facts.find(f => f.label === 'Label')?.source === 'musicbrainz' && facts.find(f => f.label === 'Year').source === 'tags' && facts.filter(f => f.label === 'Year').length === 1);
  const sg = tagSuggestion(back); t('tag suggestions say where they are from', sg.from === 'MusicBrainz' && sg.fields.album === 'Live "at" Home' && !('nothing' in sg.fields));
}

console.log(bad ? `\n${bad} FAILED` : '\nall musicbrainz tests pass'); process.exit(bad ? 1 : 0);
