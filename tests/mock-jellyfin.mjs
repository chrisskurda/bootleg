// A tiny Jellyfin-shaped server for tests (answers like Jellyfin 10.10): sign-in, the user's Audio and MusicVideo items
// (paged), playlists, favourites, static streams with Range, images. CORS open (Jellyfin allows any origin).
import http from 'node:http'; import fs from 'node:fs';
export function startJellyfin({ user = 'tester', password = 'testpass', items, files, image, playlists = [], port = 0 }) {
  const state = { items: [...items], playlists, hits: [], favs: new Set(items.filter(i => i.UserData?.IsFavorite).map(i => i.Id)) };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'), q = u.searchParams, p = u.pathname; state.hits.push(`${req.method} ${p}`);
    res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*'); res.setHeader('Access-Control-Allow-Methods', '*'); res.setHeader('Access-Control-Expose-Headers', '*');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const json = (o, status = 200) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(o)); };
    const token = /Token="([^"]+)"/.exec(req.headers.authorization || '')?.[1] || q.get('api_key');
    if (p === '/Users/AuthenticateByName' && req.method === 'POST') {
      let body = ''; req.on('data', d => { body += d; }); req.on('end', () => { const b = JSON.parse(body || '{}'); if (b.Username !== user || b.Pw !== password) return json({}, 401); json({ AccessToken: 'tok-' + user, ServerId: 'srv1', User: { Id: 'u1', Name: user } }); });
      return;
    }
    if (/^\/Items\/[^/]+\/Images\/Primary$/.test(p)) { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(fs.readFileSync(image)); }      // images need no sign-in
    if (token !== 'tok-' + user) return json({}, 401);
    if (p === '/Users/u1/Items') {
      const types = (q.get('IncludeItemTypes') || '').split(',');
      if (types.includes('Playlist')) return json({ Items: state.playlists.map(x => ({ Id: x.id, Name: x.name, Type: 'Playlist' })), TotalRecordCount: state.playlists.length });
      const all = state.items.filter(i => types.includes(i.Type)).map(i => ({ ...i, UserData: { IsFavorite: state.favs.has(i.Id) } })), s = +q.get('StartIndex') || 0, l = +q.get('Limit') || 100;
      return json({ Items: all.slice(s, s + l), TotalRecordCount: all.length });
    }
    const pl = /^\/Playlists\/([^/]+)\/Items$/.exec(p); if (pl) { const x = state.playlists.find(y => y.id === pl[1]); return x ? json({ Items: x.items.map(Id => ({ Id })) }) : json({}, 404); }
    const fav = /^\/Users\/u1\/FavoriteItems\/([^/]+)$/.exec(p); if (fav) { req.method === 'DELETE' ? state.favs.delete(fav[1]) : state.favs.add(fav[1]); return json({ IsFavorite: state.favs.has(fav[1]) }); }
    if (p === '/Library/Refresh') { res.writeHead(204); return res.end(); }
    const st = /^\/(Audio|Videos)\/([^/]+)\/(stream(\.mp4)?|Download)$/.exec(p) || /^\/Items\/([^/]+)\/(Download)$/.exec(p);
    if (st) {
      const id = st.length === 3 ? st[1] : st[2], f = files[id]; if (!f) { res.writeHead(404); return res.end(); }
      const buf = fs.readFileSync(f), type = /\.mp4$/.test(f) ? 'video/mp4' : /\.flac$/.test(f) ? 'audio/flac' : 'audio/mpeg', range = req.headers.range;
      if (range) { const [a, b] = range.replace('bytes=', '').split('-'), start = +a, end = b ? Math.min(+b, buf.length - 1) : buf.length - 1; res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${buf.length}`, 'Content-Length': end - start + 1, 'Content-Type': type, 'Accept-Ranges': 'bytes' }); return res.end(buf.subarray(start, end + 1)); }
      res.writeHead(200, { 'Content-Length': buf.length, 'Content-Type': type, 'Accept-Ranges': 'bytes' }); return res.end(buf);
    }
    json({}, 404);
  });
  return new Promise(ok => srv.listen(port, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${srv.address().port}`, state, close: () => srv.close() })));
}
