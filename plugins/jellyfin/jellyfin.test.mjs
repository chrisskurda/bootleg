// Jellyfin source: against a mock shaped like Jellyfin 10.10's answers, and (when BOOTLEG_JELLYFIN_URL, _USER and _PASS
// are set, e.g. a throwaway Docker server) against a real one.
import assert from 'node:assert/strict';
import { jellyfin, base } from './jellyfin-logic.js';

let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('ok', name); };
const json = (body, status = 200) => ({ ok: status < 300, status, headers: { get: () => 'application/json' }, json: async () => body });

function mock() {
  const calls = [], favs = new Set(['a2']);
  const audio = (id, name, album, ix, extra = {}) => ({ Id: id, Type: 'Audio', Name: name, Artists: ['The Isobars'], AlbumArtist: 'The Isobars', Album: album, AlbumId: 'al1', AlbumPrimaryImageTag: 'tag', IndexNumber: ix, ProductionYear: 2025, RunTimeTicks: 2e8, Container: 'flac', Genres: ['Ambient'], Etag: 'e' + id, Path: `/media/music/${name}.flac`, MediaSources: [{ Size: 315992, Bitrate: 126396 }], UserData: { IsFavorite: favs.has(id) }, ...extra });
  const items = [audio('a1', 'Low Pressure', 'Forecast', 1), audio('a2', 'High Front', 'Forecast', 2),
    { Id: 'v1', Type: 'MusicVideo', Name: 'The Isobars - Low Pressure (Official Video)', Artists: [], RunTimeTicks: 6e7, Container: 'mov,mp4,m4a,3gp,3g2,mj2', ImageTags: { Primary: 'x' }, MediaSources: [{ Size: 81471, MediaStreams: [{ Type: 'Video', Codec: 'h264' }, { Type: 'Audio', Codec: 'aac' }] }] },
    { Id: 'v2', Type: 'MusicVideo', Name: 'Second Quarter', Artists: ['The Quarterlies'], RunTimeTicks: 6e7, Container: 'mkv', MediaSources: [{ Size: 78672, MediaStreams: [{ Type: 'Video', Codec: 'h264' }] }] }];
  const net = async (url, init = {}) => {
    const u = new URL(url), auth = init.headers?.Authorization || ''; calls.push([init.method || 'GET', u.pathname + u.search, auth]);
    if (u.pathname === '/Users/AuthenticateByName') { const b = JSON.parse(init.body); return b.Pw === 'pw' ? json({ AccessToken: 'TOKEN', ServerId: 's1', User: { Id: 'u1', Name: b.Username } }) : json({}, 401); }
    if (!/Token="TOKEN"/.test(auth)) return json({}, 401);
    if (u.pathname === '/Users/u1/Items' && u.searchParams.get('IncludeItemTypes') === 'Playlist') return json({ Items: [{ Id: 'p1', Name: 'Rainy' }] });
    if (u.pathname === '/Users/u1/Items') { const s = +u.searchParams.get('StartIndex'), l = +u.searchParams.get('Limit'); return json({ Items: items.slice(s, s + Math.min(l, 3)), TotalRecordCount: items.length }); }      // pages of 3
    if (u.pathname === '/Playlists/p1/Items') return json({ Items: [{ Id: 'a2' }, { Id: 'a1' }] });
    if (/^\/Users\/u1\/FavoriteItems\//.test(u.pathname)) { const id = u.pathname.split('/').pop(); init.method === 'DELETE' ? favs.delete(id) : favs.add(id); return { ok: true, status: 204, headers: { get: () => '' } }; }
    return json({}, 404);
  };
  return { net, calls, favs };
}

await t('addresses: the web UI address works too', () => { assert.equal(base('http://h:8096/web/index.html#!/home'), 'http://h:8096'); assert.equal(base(' https://jf.example.com/ '), 'https://jf.example.com'); });

await t('connect keeps a token, never the password', async () => {
  const m = mock(), src = jellyfin(m.net);
  await assert.rejects(src.connect({ url: 'http://jf:8096', username: 'me', password: 'wrong' }), /did not accept/);
  const { config, title } = await src.connect({ url: 'http://jf:8096/', username: 'me', password: 'pw' });
  assert.equal(title, 'me@jf:8096'); assert.equal(config.token, 'TOKEN'); assert.equal(config.userId, 'u1'); assert.ok(!JSON.stringify(config).includes('"pw"'));
  assert.deepEqual(src.secrets, ['token']); assert.match(m.calls[1][2], /DeviceId="bootleg-[0-9a-f]{16}"/);
});

await t('scan: tracks and music videos, paged, with tags, covers and favourites', async () => {
  const m = mock(), src = jellyfin(m.net), ses = src.session({ url: 'http://jf:8096', userId: 'u1', deviceId: 'd', token: 'TOKEN' }), all = [];
  for await (const p of src.scan(ses)) all.push(...p.items);
  assert.equal(all.length, 4); const [a1, a2, v1, v2] = all;
  assert.deepEqual([a1.title, a1.artist, a1.album, a1.track, a1.year, a1.genre, a1.duration, a1.suffix, a1.bitrate, a1.coverId], ['Low Pressure', 'The Isobars', 'Forecast', 1, 2025, 'Ambient', 20, 'flac', 126, 'al1']);
  assert.ok(a2.starred && !a1.starred && a1.changed !== a2.changed);
  assert.equal(v1.kind, 'video'); assert.equal(v1.title, 'The Isobars - Low Pressure (Official Video)', 'the core splits artist and title'); assert.ok(v1.direct && v1.suffix === 'mp4');
  assert.ok(!v2.direct && v2.artist === 'The Quarterlies');
  assert.match(src.streamUrl(ses, a1), /^http:\/\/jf:8096\/Audio\/a1\/stream\?static=true&api_key=TOKEN$/);
  assert.match(src.streamUrl(ses, v1), /\/Videos\/v1\/stream\?static=true/); assert.match(src.streamUrl(ses, v2), /\/Videos\/v2\/stream\.mp4\?static=false&Container=mp4&VideoCodec=h264&AudioCodec=aac/);
  assert.equal(src.coverUrl(ses, a1, 256), 'http://jf:8096/Items/al1/Images/Primary?maxWidth=256&quality=90');
});

await t('favourites, playlists, offline copies', async () => {
  const m = mock(), src = jellyfin(m.net), ses = src.session({ url: 'http://jf:8096', userId: 'u1', deviceId: 'd', token: 'TOKEN' });
  await src.setStarred(ses, 'a1', true); await src.setStarred(ses, 'a2', false); assert.deepEqual([...m.favs], ['a1']);
  assert.deepEqual(await src.playlists(ses), [{ id: 'p1', name: 'Rainy', owner: '', items: ['a2', 'a1'] }]);
  const it = { id: 'a1', suffix: 'flac', size: 9, duration: 20 };
  assert.deepEqual(src.download(ses, it, 'original'), { url: 'http://jf:8096/Items/a1/Download?api_key=TOKEN', ext: 'flac', quality: 'original', bytes: 9 });
  const hi = src.download(ses, it, 'high'); assert.match(hi.url, /stream\.mp3\?static=false&AudioCodec=mp3&AudioBitRate=320000/); assert.equal(hi.ext, 'mp3');
  await assert.rejects(src.playlists(src.session({ url: 'http://jf:8096', userId: 'u1', token: 'OLD' })), /sign in again/);
});

// ---- a real server (optional)
const L = { url: process.env.BOOTLEG_JELLYFIN_URL, user: process.env.BOOTLEG_JELLYFIN_USER, pass: process.env.BOOTLEG_JELLYFIN_PASS };
if (L.url) await t(`a real server (${L.url})`, async () => {
  const src = jellyfin(fetch), { config } = await src.connect({ url: L.url, username: L.user, password: L.pass }), ses = src.session(config), all = [];
  for await (const p of src.scan(ses)) all.push(...p.items);
  const tracks = all.filter(x => x.kind !== 'video'), vids = all.filter(x => x.kind === 'video'); console.log(`   ${tracks.length} tracks, ${vids.length} videos`);
  assert.ok(tracks.length > 0 && tracks.every(x => x.title && x.duration > 0));
  for (const it of [tracks[0], ...vids]) { const r = await fetch(src.streamUrl(ses, it), { headers: { Range: 'bytes=0-1023' } }); assert.ok(r.ok, `${it.title}: ${r.status}`); const ct = r.headers.get('content-type'); console.log(`   ${it.kind || 'track'} ${it.title}: ${r.status} ${ct}`); await r.arrayBuffer(); if (it.kind === 'video') assert.match(ct, /video\/(mp4|webm|quicktime)/); }
  const c = tracks.find(x => x.coverId); if (c) assert.ok((await fetch(src.coverUrl(ses, c, 128))).ok, 'covers load without the token');
  const before = tracks[0].starred; await src.setStarred(ses, tracks[0].id, !before); await src.setStarred(ses, tracks[0].id, before);
  await src.playlists(ses);
});

console.log(`\n${n} jellyfin tests pass`);
