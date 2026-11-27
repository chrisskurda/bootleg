// Music videos: title matching, file names, links (src/lib/videos.js).
import assert from 'node:assert/strict';
import { normTitle, normArtist, matchKey, fromFileName, splitTitle, videoIndex, VideoLinks, videosFor, pickList, VIDEO_RE } from '../src/lib/videos.js';

let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('ok', name); };

await t('upload decorations are not part of the title', () => {
  for (const s of ['Around the World (Official Video)', 'Around the World [Official Music Video] [4K]', 'Around The World - Official Video', 'Around the World (Remastered 2021) (HD)', 'Around the World (feat. Somebody)', 'Around the World ft. Somebody'])
    assert.equal(normTitle(s), 'around the world', s);
  assert.equal(normTitle('Live Forever (Live)'), 'live forever live', 'a live version is a different recording');
  assert.equal(normTitle('Señorita'), 'senorita'); assert.equal(normTitle('Rock & Roll'), 'rock and roll');
});
await t('artists: the first credited one, without "The"', () => {
  assert.equal(normArtist('Daft Punk feat. Pharrell Williams'), 'daft punk'); assert.equal(normArtist('The Cure'), 'cure');
  assert.equal(normArtist('Beyoncé, JAY-Z'), 'beyonce'); assert.equal(matchKey('', 'x'), '');
});
await t('file names', () => {
  assert.deepEqual(fromFileName('Daft Punk - Around the World (Official Video).mp4'), { artist: 'Daft Punk', title: 'Around the World (Official Video)' });
  assert.deepEqual(fromFileName('some_clip.mkv'), { artist: '', title: 'some clip' });
  assert.ok(VIDEO_RE.test('a.MKV') && !VIDEO_RE.test('a.m4a'));
  assert.deepEqual(splitTitle('Mr. Brightside'), { artist: '', title: 'Mr. Brightside' }); assert.deepEqual(splitTitle('The Killers – Mr. Brightside'), { artist: 'The Killers', title: 'Mr. Brightside' });
});

const mem = () => { const d = new Map(); return { get: async (s, k) => d.get(s + k), put: async (s, k, v) => { d.set(s + k, structuredClone(v)); } }; };
const V = (path, artist, title) => ({ kind: 'video', artist, title, src: { path, name: path.split('/').pop() } });
const vids = [V('/v/a.mp4', 'Daft Punk', 'Around the World (Official Video)'), V('jellyfin:c1/9', 'daft punk', 'Around The World [HD]'), V('/v/b.mp4', 'Other', 'Song')];
const byPath = new Map(vids.map(v => [v.src.path, v])), index = videoIndex(vids);
const track = { kind: 'track', artist: 'Daft Punk', title: 'Around the World' };

await t('automatic matches across sources', () => {
  const r = videosFor(track, 'k', { links: null, index, byPath });
  assert.deepEqual(r.map(x => [x.video.src.path, x.how]), [['/v/a.mp4', 'auto'], ['jellyfin:c1/9', 'auto']]);
  assert.deepEqual(videosFor({ ...track, kind: 'video' }, 'k', { index, byPath }), []);
});

await t('links: by hand, hiding an automatic match, kept in the store', async () => {
  const kv = mem(), L = new VideoLinks(kv); await L.ready;
  await L.link('k', '/v/b.mp4'); await L.unlink('k', '/v/a.mp4', true);
  let r = videosFor(track, 'k', { links: L, index, byPath });
  assert.deepEqual(r.map(x => [x.video.src.path, x.how]), [['/v/b.mp4', 'linked'], ['jellyfin:c1/9', 'auto']]);
  const L2 = new VideoLinks(kv); await L2.ready; r = videosFor(track, 'k', { links: L2, index, byPath });
  assert.equal(r.length, 2, 'survives a restart');
  await L2.link('k', '/v/a.mp4'); assert.equal(videosFor(track, 'k', { links: L2, index, byPath }).length, 3, 'linking a hidden one by hand brings it back');
  await L2.unlink('k', '/v/b.mp4', false); assert.ok(!L2.hidden.get('k')?.has('/v/b.mp4'), 'removing a hand-made link does not hide anything');
  assert.deepEqual(videosFor(track, 'k', { links: L2, index: new Map(), byPath: new Map() }), [], 'videos no longer in the library are skipped');
});

await t('the picker puts likely videos first and filters', () => {
  assert.equal(pickList(vids, track)[2].src.path, '/v/b.mp4');
  assert.deepEqual(pickList(vids, track, 'other').map(v => v.src.path), ['/v/b.mp4']);
});

console.log(`\n${n} video tests pass`);
