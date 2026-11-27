// Plex source: the plex.tv PIN flow and the server API against mocks shaped like Plex's answers; and (with
// BOOTLEG_PLEX_URL, e.g. a throwaway Docker server that allows this network) against a real server.
import assert from 'node:assert/strict';
import { plex, base } from './plex-logic.js';

let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('ok', name); };
const res = (body, status = 200) => ({ ok: status < 300, status, headers: { get: k => (k === 'content-length' && body == null ? '0' : null) }, json: async () => body });

function mock({ needToken = true } = {}) {
  const calls = [], rates = [], state = { polls: 0, opened: null };
  const T = (rk, title, ix, extra = {}) => ({ ratingKey: rk, title, grandparentTitle: 'The Isobars', parentTitle: 'Forecast', index: ix, parentIndex: 1, parentYear: 2025, duration: 20000, userRating: rk === '3' ? 7 : undefined, updatedAt: 100 + +rk, parentThumb: '/library/metadata/2/thumb/9', Genre: [{ tag: 'Ambient' }],
    Media: [{ bitrate: 900, container: 'flac', Part: [{ key: `/library/parts/${rk}/1/file.flac`, size: 315992, container: 'flac', file: `/media/music/${title}.flac` }] }], ...extra });
  const net = async (url, init = {}) => {
    const u = new URL(url), h = init.headers || {}; calls.push([init.method || 'GET', u.host + u.pathname, h['X-Plex-Token'] || '']);
    if (u.host === 'plex.tv') {
      if (!h['X-Plex-Client-Identifier']) return res({}, 400);
      if (u.pathname === '/api/v2/pins' && init.method === 'POST') return res({ id: 77, code: 'abcd' });
      if (u.pathname === '/api/v2/pins/77') return res({ id: 77, authToken: ++state.polls >= 2 ? 'ACCOUNT' : null });
      if (u.pathname === '/api/v2/resources') return h['X-Plex-Token'] === 'ACCOUNT' ? res([{ name: 'Phone', provides: 'player' }, { name: 'Den', provides: 'server', owned: true, clientIdentifier: 'm1', accessToken: 'SERVER',
        connections: [{ uri: 'https://relay.plex.direct:8443', local: false, relay: true, protocol: 'https' }, { uri: 'https://10-0-0-9.x.plex.direct:32400', local: true, relay: false, protocol: 'https' }, { uri: 'http://dead:32400', local: true, relay: false, protocol: 'http' }] }]) : res({}, 401);
      return res({}, 404);
    }
    if (u.host === 'dead:32400') throw new Error('connect ECONNREFUSED');
    const tok = h['X-Plex-Token'] || u.searchParams.get('X-Plex-Token');
    if (u.pathname === '/identity') return res({ MediaContainer: { machineIdentifier: 'm1', friendlyName: 'Den' } });
    if (needToken && tok !== 'SERVER') return res({}, 401);
    if (u.pathname === '/library/sections') return res({ MediaContainer: { Directory: [{ key: '1', type: 'artist', title: 'Music' }, { key: '2', type: 'movie', title: 'Films' }] } });
    if (u.pathname === '/library/sections/1/all' && u.searchParams.get('type') === '10') { const all = [T('3', 'Low Pressure', 1), T('4', 'High Front', 2, { originalTitle: 'Guest Singer' })], s = +u.searchParams.get('X-Plex-Container-Start'); return res({ MediaContainer: { totalSize: 2, Metadata: all.slice(s, s + 1) } }); }      // (pages of one, whatever is asked)
    if (u.pathname === '/library/sections/1/all' && u.searchParams.get('type') === '8') return res({ MediaContainer: { Metadata: [{ ratingKey: '1', title: 'The Isobars' }, { ratingKey: '5', title: 'Nobody' }] } });
    if (u.pathname === '/library/metadata/1/extras') return res({ MediaContainer: { Metadata: [{ ratingKey: '8', type: 'clip', subtype: 'musicVideo', extraType: 4, title: 'Low Pressure', duration: 6000, thumb: '/library/metadata/8/thumb/1', Media: [{ container: 'mp4', videoCodec: 'h264', audioCodec: 'aac', Part: [{ key: '/library/parts/4/0/file.mp4', container: 'mp4', size: 81471 }] }] }, { ratingKey: '9', type: 'clip', subtype: 'trailer', title: 'Trailer' }] } });
    if (u.pathname === '/library/metadata/5/extras') return res({ MediaContainer: { size: 0 } });
    if (u.pathname === '/playlists') return res({ MediaContainer: { Metadata: [{ ratingKey: '50', title: 'Rainy' }] } });
    if (u.pathname === '/playlists/50/items') return res({ MediaContainer: { Metadata: [{ ratingKey: '4' }, { ratingKey: '3' }] } });
    if (u.pathname === '/:/rate') { rates.push([u.searchParams.get('key'), u.searchParams.get('rating')]); return res(null); }
    return res({}, 404);
  };
  return { net, calls, rates, state };
}
const fast = { pollMs: 1, clientId: 'bootleg-test' };

await t('the PIN flow: plex.tv opens for approval, the server token is kept, the best address that answers is used', async () => {
  const m = mock(), opened = [], src = plex(m.net, { ...fast, open: u => opened.push(u) });
  const { config, title } = await src.connect({});
  assert.match(opened[0], /^https:\/\/app\.plex\.tv\/auth#\?clientID=bootleg-test&code=abcd&context%5Bdevice%5D%5Bproduct%5D=bootleg$/);
  assert.equal(title, 'Plex · Den'); assert.equal(config.token, 'SERVER', 'the server\'s token, not the account\'s'); assert.ok(!JSON.stringify(config).includes('ACCOUNT'));
  assert.equal(config.url, 'https://10-0-0-9.x.plex.direct:32400', 'a local address that answers, not the relay'); assert.deepEqual(src.secrets, ['token']); assert.equal(src.cors, false);
});
await t('a server name that is not there is named, with the ones that are', async () => {
  const src = plex(mock().net, { ...fast, open: () => {} });
  await assert.rejects(src.connect({ server: 'Attic' }), /No server called “Attic” \(yours: Den\)/);
});
await t('approval that never comes times out with a clear message', async () => {
  const m = mock(), src = plex(async (u, i) => (/pins\/77/.test(u) ? res({ authToken: null }) : m.net(u, i)), { ...fast, open: () => {}, pinTimeoutMs: 20 });
  await assert.rejects(src.connect({}), /not approved in time/);
});
await t('a given address on a network the server allows: no sign-in at all', async () => {
  const m = mock({ needToken: false }), opened = [], src = plex(m.net, { ...fast, open: u => opened.push(u) });
  const { config, title } = await src.connect({ url: 'http://10.0.0.9:32400/web/index.html' });
  assert.deepEqual([config.url, config.token, title, opened.length], ['http://10.0.0.9:32400', '', 'Plex · Den', 0]);
});
await t('a given address that wants a sign-in: the account\'s server with that identity', async () => {
  const m = mock(), src = plex(m.net, { ...fast, open: () => {} });
  const { config } = await src.connect({ url: 'http://10.0.0.9:32400' }); assert.deepEqual([config.url, config.token], ['http://10.0.0.9:32400', 'SERVER']);
});

await t('scan: tracks (paged) and the artists\' music videos; ratings, playlists, covers, streams', async () => {
  const m = mock(), src = plex(m.net, fast), ses = src.session({ url: 'http://10.0.0.9:32400', clientId: 'c', token: 'SERVER' }), all = [];
  for await (const p of src.scan(ses)) all.push(...p.items);
  const [a, b, v] = all; assert.equal(all.length, 3);
  assert.deepEqual([a.id, a.title, a.artist, a.albumArtist, a.album, a.track, a.disc, a.year, a.genre, a.duration, a.suffix, a.rating, a.path], ['3', 'Low Pressure', 'The Isobars', 'The Isobars', 'Forecast', 1, 1, 2025, 'Ambient', 20, 'flac', 3.5, '/media/music/Low Pressure.flac']);
  assert.equal(b.artist, 'Guest Singer', 'a track artist other than the album artist');
  assert.deepEqual([v.kind, v.id, v.title, v.artist, v.direct, v.duration], ['video', '8', 'Low Pressure', 'The Isobars', true, 6], 'trailers are not music videos');
  assert.equal(src.streamUrl(ses, a), 'http://10.0.0.9:32400/library/parts/3/1/file.flac?X-Plex-Token=SERVER');
  assert.match(src.coverUrl(ses, a, 256), /\/photo\/:\/transcode\?width=256&height=256&minSize=1&upscale=1&url=%2Flibrary%2Fmetadata%2F2%2Fthumb%2F9&X-Plex-Token=SERVER$/);
  assert.equal(src.streamUrl(src.session({ url: 'http://h:1', token: '' }), a), 'http://h:1/library/parts/3/1/file.flac', 'no empty token parameter');
  await src.setRating(ses, '3', 4.5); await src.setRating(ses, '4', 0); assert.deepEqual(m.rates, [['3', '9'], ['4', '-1']]);
  assert.deepEqual(await src.playlists(ses), [{ id: '50', name: 'Rainy', owner: '', items: ['4', '3'] }]);
  assert.deepEqual(src.download(ses, a, 'high'), { url: 'http://10.0.0.9:32400/library/parts/3/1/file.flac?download=1&X-Plex-Token=SERVER', ext: 'flac', quality: 'original', bytes: 315992 });
  src.videos = false; const no = []; for await (const p of src.scan(ses)) no.push(...p.items); assert.ok(!no.some(x => x.kind === 'video'), 'the setting turns the video lookup off');
  await assert.rejects(src.playlists(src.session({ url: 'http://10.0.0.9:32400', token: 'OLD' })), /connect again/);
});

await t('addresses', () => { assert.equal(base('http://h:32400/web/index.html#!/'), 'http://h:32400'); });

// ---- a real server (optional): one on this network that allows access without signing in
if (process.env.BOOTLEG_PLEX_URL) await t(`a real server (${process.env.BOOTLEG_PLEX_URL})`, async () => {
  const src = plex(fetch, { open: () => { throw new Error('no sign-in expected'); } }), { config, title } = await src.connect({ url: process.env.BOOTLEG_PLEX_URL }), ses = src.session(config), all = [];
  console.log('   ' + title); for await (const p of src.scan(ses)) all.push(...p.items);
  const tracks = all.filter(x => x.kind !== 'video'), vids = all.filter(x => x.kind === 'video'); console.log(`   ${tracks.length} tracks, ${vids.length} videos: ${vids.map(v => `${v.artist} – ${v.title}`).join(', ')}`);
  assert.ok(tracks.length > 0 && tracks.every(x => x.title && x.duration > 0 && x.part));
  for (const it of [tracks[0], ...vids]) { const r = await fetch(src.streamUrl(ses, it), { headers: { Range: 'bytes=0-1023' } }); console.log(`   ${it.kind || 'track'} ${it.title}: ${r.status} ${r.headers.get('content-type')}`); assert.ok(r.ok); await r.arrayBuffer(); }
  const c = tracks.find(x => x.coverId); if (c) { const r = await fetch(src.coverUrl(ses, c, 128)); console.log(`   cover: ${r.status} ${r.headers.get('content-type')}`); assert.ok(r.ok); }
  const tr = tracks[0], was = tr.rating; await src.setRating(ses, tr.id, 4.5);
  const again = []; for await (const p of src.scan(ses)) again.push(...p.items); assert.equal(again.find(x => x.id === tr.id).rating, 4.5, 'the rating reached the server'); await src.setRating(ses, tr.id, was);
  await src.playlists(ses);
});

console.log(`\n${n} plex tests pass`);
