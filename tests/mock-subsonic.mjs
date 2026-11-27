// A tiny Subsonic-compatible server for tests: token auth, getAlbumList2/getAlbum/stream/download/getCoverArt, playlists,
// setRating/star/unstar (kept on the song objects, so getAlbum reports them back), CORS open.
import http from 'node:http'; import crypto from 'node:crypto'; import fs from 'node:fs';
export function startMock({ user = 'alice', password = 'secret', songs, files, cover, playlists = [], port = 0 }) {
  const state = { songs: [...songs], playlists: [...playlists], hits: [], writes: [] };
  const md5 = s => crypto.createHash('md5').update(s).digest('hex');
  const albums = () => { const m = new Map(); for (const s of state.songs) { if (!m.has(s.albumId)) m.set(s.albumId, { id: s.albumId, name: s.album, artist: s.artist, songs: [] }); m.get(s.albumId).songs.push(s); } return [...m.values()]; };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'), q = u.searchParams, m = /\/rest\/(\w+)\.view/.exec(u.pathname)?.[1]; state.hits.push(m);
    if (!process.env.NOCORS) { res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*'); res.setHeader('Access-Control-Expose-Headers', '*'); } if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const json = (o, status = 'ok') => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ 'subsonic-response': { status, version: '1.16.1', type: 'mock', serverVersion: '0.0.1', ...o } })); };
    if (!m) { res.writeHead(404); return res.end(); }
    if (q.get('u') !== user || q.get('t') !== md5(password + q.get('s'))) return json({ error: { code: 40, message: 'Wrong username or password' } }, 'failed');
    if (m === 'ping') return json({});
    if (m === 'getAlbumList2') { const off = +q.get('offset') || 0, size = +q.get('size') || 10; return json({ albumList2: { album: albums().slice(off, off + size).map(a => ({ id: a.id, name: a.name, artist: a.artist, songCount: a.songs.length })) } }); }
    if (m === 'getAlbum') { const a = albums().find(x => x.id === q.get('id')); return a ? json({ album: { id: a.id, name: a.name, song: a.songs } }) : json({ error: { code: 70, message: 'not found' } }, 'failed'); }
    if (m === 'getPlaylists') return json({ playlists: { playlist: state.playlists.map(p => ({ id: p.id, name: p.name, owner: user, songCount: p.songs.length })) } });
    if (m === 'getPlaylist') { const p = state.playlists.find(x => x.id === q.get('id')); return p ? json({ playlist: { id: p.id, name: p.name, entry: p.songs.map(id => state.songs.find(x => x.id === id)).filter(Boolean) } }) : json({ error: { code: 70, message: 'not found' } }, 'failed'); }
    if (m === 'setRating' || m === 'star' || m === 'unstar') {
      const s = state.songs.find(x => x.id === q.get('id')); if (!s) return json({ error: { code: 70, message: 'not found' } }, 'failed'); state.writes.push([m, s.id, q.get('rating')]);
      if (m === 'setRating') { if (+q.get('rating')) s.userRating = +q.get('rating'); else delete s.userRating; } else if (m === 'star') s.starred = '2026-11-25T00:00:00Z'; else delete s.starred; return json({});
    }
    if (m === 'stream' && state.failStream) { res.writeHead(500); return res.end('boom'); }
    if (m === 'stream' || m === 'download') { const s = state.songs.find(x => x.id === q.get('id')); if (!s) { res.writeHead(404); return res.end(); } const buf = fs.readFileSync(files[s.id]); const range = req.headers.range; res.setHeader('Accept-Ranges', 'bytes'); res.setHeader('content-type', 'audio/' + (s.suffix === 'flac' ? 'flac' : 'mpeg'));
      if (range) { const [a, b] = range.replace('bytes=', '').split('-'), start = +a, end = b ? +b : buf.length - 1; res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${buf.length}`, 'Content-Length': end - start + 1 }); return res.end(buf.subarray(start, end + 1)); } res.setHeader('Content-Length', buf.length); return res.end(buf); }
    if (m === 'getCoverArt') { res.setHeader('content-type', 'image/png'); return res.end(fs.readFileSync(cover)); }
    res.writeHead(404); res.end();
  });
  return new Promise(ok => srv.listen(port, process.env.HOST || '127.0.0.1', () => ok({ url: `http://${process.env.HOST || '127.0.0.1'}:${srv.address().port}`, state, close: () => srv.close() })));
}
