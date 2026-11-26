// A tiny bootleg stem server (API v2) for tests: songs from folders on disk, files with ranges, annotations, playlists,
// the hand-off. CORS open. Keeps every write so tests can check what bootleg sent.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const list = dir => { const out = []; for (const f of fs.readdirSync(dir)) { const p = path.join(dir, f); if (fs.statSync(p).isDirectory()) { if (f === 'stems') for (const s of fs.readdirSync(p)) out.push('stems/' + s); } else out.push(f); } return out; };
export function startStemServer({ songs, playlists = [] }) {
  const state = { songs, playlists, writes: [], opens: [] };
  const files = s => list(s.dir).map(p => ({ path: p, size: fs.statSync(path.join(s.dir, p)).size }));
  const view = s => ({ id: s.id, name: s.name, kind: 'folder', title: s.manifest.title, artist: '', bpm: s.manifest.bpm, seconds: s.manifest.seconds, modified: s.modified || 1795000000, size: 0, cover: false, clips: true, project: false, annotations: { grade: '', rating: 0, fav: false, ...s.annotations }, manifest: s.manifest, files: files(s) });
  const srv = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*'); res.setHeader('Access-Control-Allow-Methods', '*'); res.setHeader('Access-Control-Expose-Headers', '*');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const u = new URL(req.url, 'http://x'), p = decodeURIComponent(u.pathname), json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    let body = ''; req.on('data', c => { body += c; }); req.on('end', () => {
      if (p === '/api/v2/info') return json({ api: 2, app: 'bootleg-stemserver', app_version: '0.1.0', contracts: { server_api: 2, song_format: 2 }, engine: false, songs: state.songs.length });
      if (p === '/api/v2/songs') return json(state.songs.map(view));
      if (p === '/api/v2/playlists') return json(state.playlists);
      if (p === '/api/v2/open' && req.method === 'POST') { state.opens.push(JSON.parse(body)); return json({ ok: true }); }
      let m = /^\/api\/v2\/songs\/([^/]+)\/annotations$/.exec(p);
      if (m && req.method === 'PUT') { const s = state.songs.find(x => x.id === m[1]); if (!s) return json({ error: 'no such song' }, 404); const b = JSON.parse(body); state.writes.push([s.id, b]); s.annotations = { ...s.annotations, ...b }; return json(view(s).annotations); }
      m = /^\/api\/v2\/songs\/([^/]+)\/files\/(.+)$/.exec(p);
      if (m) {
        const s = state.songs.find(x => x.id === m[1]), f = s && path.join(s.dir, m[2]); if (!s || !fs.existsSync(f)) return json({ error: 'no such file' }, 404);
        const buf = fs.readFileSync(f), type = f.endsWith('.flac') ? 'audio/flac' : f.endsWith('.json') ? 'application/json' : 'application/octet-stream', range = req.headers.range;
        if (range) { const [a, b] = range.replace('bytes=', '').split('-'), start = +a, end = b ? +b : buf.length - 1; res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${buf.length}`, 'Content-Length': end - start + 1, 'content-type': type, 'Accept-Ranges': 'bytes' }); return res.end(buf.subarray(start, end + 1)); }
        res.writeHead(200, { 'Content-Length': buf.length, 'content-type': type, 'Accept-Ranges': 'bytes' }); return res.end(buf);
      }
      json({ error: 'not found' }, 404);
    });
  });
  return new Promise(ok => srv.listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${srv.address().port}`, state, close: () => srv.close() })));
}
