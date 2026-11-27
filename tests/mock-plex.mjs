// A tiny Plex Media Server for tests, shaped like PMS 1.4x's JSON: /identity, music sections, tracks (paged), artists and
// their music-video extras, parts with Range, photo transcode, ratings, playlists. Like the real one it allows only
// https://app.plex.tv as a CORS origin (so a web page can't read its media: bootleg's desktop proxy has to).
// As a CLI (desktop self-test):  node tests/mock-plex.mjs <audio.flac> <video.mp4> <cover.png>   → prints "plex: <url>"
import http from 'node:http'; import fs from 'node:fs'; import { fileURLToPath } from 'node:url';

export function startPlex({ audio, video, cover, token = '', port = 0 }) {
  const state = { hits: [], rates: [] };
  const T = (rk, title, ix) => ({ ratingKey: rk, key: `/library/metadata/${rk}`, type: 'track', title, grandparentTitle: 'Plex Band', parentTitle: 'Plexed', index: ix, parentIndex: 1, parentYear: 2022, duration: 5000, updatedAt: 1700000000 + +rk, parentThumb: '/library/metadata/2/thumb/1',
    Media: [{ bitrate: 800, container: 'flac', audioCodec: 'flac', Part: [{ key: `/library/parts/${rk}/1/file.flac`, size: fs.statSync(audio).size, container: 'flac' }] }] });
  const tracks = [T('11', 'Plex One', 1), T('12', 'Plex Two', 2)];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'), p = u.pathname; state.hits.push(`${req.method} ${p}`);
    res.setHeader('Access-Control-Allow-Origin', 'https://app.plex.tv'); res.setHeader('Access-Control-Expose-Headers', 'Location, Date');
    const json = (o, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ MediaContainer: o })); };
    if (p === '/identity') return json({ machineIdentifier: 'mock-plex', version: '1.43.0' });
    if (token && (req.headers['x-plex-token'] || u.searchParams.get('X-Plex-Token')) !== token) { res.writeHead(401); return res.end(); }
    if (p === '/library/sections') return json({ Directory: [{ key: '1', type: 'artist', title: 'Music' }] });
    if (p === '/library/sections/1/all' && u.searchParams.get('type') === '10') { const s = +u.searchParams.get('X-Plex-Container-Start') || 0, n = +u.searchParams.get('X-Plex-Container-Size') || 50; return json({ size: tracks.slice(s, s + n).length, totalSize: tracks.length, Metadata: tracks.slice(s, s + n) }); }
    if (p === '/library/sections/1/all' && u.searchParams.get('type') === '8') return json({ Metadata: [{ ratingKey: '1', type: 'artist', title: 'Plex Band' }] });
    if (p === '/library/metadata/1/extras') return json({ size: 1, Metadata: [{ ratingKey: '20', type: 'clip', subtype: 'musicVideo', extraType: 4, title: 'Plex One', duration: 4000, thumb: '/library/metadata/20/thumb/1', Media: [{ container: 'mp4', videoCodec: 'h264', audioCodec: 'aac', Part: [{ key: '/library/parts/20/0/file.mp4', container: 'mp4', size: fs.statSync(video).size }] }] }] });
    if (p === '/playlists') return json({ Metadata: [] });
    if (p === '/:/rate') { state.rates.push([u.searchParams.get('key'), u.searchParams.get('rating')]); res.writeHead(200); return res.end(); }
    if (p === '/photo/:/transcode') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(fs.readFileSync(cover)); }
    const part = /^\/library\/parts\/(\d+)\//.exec(p);
    if (part) {
      const f = part[1] === '20' ? video : audio, buf = fs.readFileSync(f), type = part[1] === '20' ? 'video/mp4' : 'audio/flac', range = req.headers.range;
      if (range) { const [a, b] = range.replace('bytes=', '').split('-'), start = +a, end = b ? Math.min(+b, buf.length - 1) : buf.length - 1; res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${buf.length}`, 'Content-Length': end - start + 1, 'Content-Type': type, 'Accept-Ranges': 'bytes' }); return res.end(buf.subarray(start, end + 1)); }
      res.writeHead(200, { 'Content-Length': buf.length, 'Content-Type': type, 'Accept-Ranges': 'bytes' }); return res.end(buf);
    }
    res.writeHead(404); res.end();
  });
  return new Promise(ok => srv.listen(port, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${srv.address().port}`, state, close: () => srv.close() })));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [audio, video, cover] = process.argv.slice(2); const m = await startPlex({ audio, video, cover }); console.log('plex: ' + m.url);
}
