// Plex source (docs/plugins/SERVERS.md): the library source contract (src/lib/sources/plugin.js) over the Plex Media
// Server API. Music sections, the music videos Plex keeps as artist extras, ratings (half stars) both ways, playlists,
// offline copies of the original files. No DOM here; `net` is a fetch (api.net.fetch), `open` opens a page in the user's
// browser (api.ui.openExternal).
//
// Sign-in: the plex.tv PIN flow. bootleg asks plex.tv for a PIN, opens app.plex.tv for the user to approve it, and polls
// until plex.tv hands over a token; then it picks the server (by name, or the first one) and the best of its addresses
// that answers. Only that server's own access token is kept (keychain), not the plex.tv account token.
// A server address can be given instead (a server on this network that allows access without sign-in, or plex.tv being
// unreachable); bootleg then only signs in when the server asks for it.
//
// Plex allows only its own web app as a CORS origin, so `cors: false`: the desktop app streams through its loopback
// media proxy; the web build can list a Plex library but not play it.

export const PLEX_TV = 'https://plex.tv', APP_AUTH = 'https://app.plex.tv/auth#';
const PAGE = 500, WEB_CONTAINERS = new Set(['mp4', 'm4v', 'mov', 'webm']), WEB_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1']), WEB_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);
export const base = u => String(u || '').trim().replace(/\/+$/, '').replace(/\/web(\/index\.html)?(#.*)?$/, '');
const qs = o => new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== '')).toString();
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function plex(net, { open = () => {}, version = '0.1.0', clientId = null, pollMs = 2000, pinTimeoutMs = 5 * 60_000, plexTv = PLEX_TV } = {}) {
  const ident = c => ({ 'X-Plex-Product': 'bootleg', 'X-Plex-Version': version, 'X-Plex-Client-Identifier': c, 'X-Plex-Platform': 'bootleg', 'X-Plex-Device-Name': 'bootleg', Accept: 'application/json' });
  async function req(url, { method = 'GET', headers = {}, timeout = 0 } = {}) {
    const ac = timeout ? new AbortController() : null, t = ac && setTimeout(() => ac.abort(), timeout);
    try { return await net(url, { method, headers, ...(ac ? { signal: ac.signal } : {}) }); }
    catch (e) { throw new Error(`Could not reach ${new URL(url).host} (${e.message || e})`); } finally { clearTimeout(t); }
  }
  const json = async r => (r.status === 204 || r.headers?.get?.('content-length') === '0') ? null : r.json().catch(() => null);
  async function call(ses, path, { method = 'GET', query = {} } = {}) {
    const c = ses.config, q = qs(query), r = await req(`${ses.base}${path}${q ? '?' + q : ''}`, { method, headers: { ...ident(c.clientId), ...(c.token ? { 'X-Plex-Token': c.token } : {}) } });
    if (r.status === 401) throw new Error('The Plex server did not accept the sign-in (connect again in Settings)');
    if (!r.ok) throw new Error(`Plex answered ${r.status}`);
    return (await json(r))?.MediaContainer || {};
  }
  const media = (ses, path, query = {}) => `${ses.base}${path}${path.includes('?') ? '&' : '?'}${qs({ ...query, 'X-Plex-Token': ses.config.token || undefined })}`.replace(/\?$/, '');

  // ---- the plex.tv PIN flow → the account token
  async function signIn(cid, signal) {
    const pr = await req(`${plexTv}/api/v2/pins?strong=true`, { method: 'POST', headers: ident(cid) }); if (!pr.ok) throw new Error(`plex.tv answered ${pr.status}`);
    const pin = await pr.json();
    await open(`${APP_AUTH}?${qs({ clientID: cid, code: pin.code, 'context[device][product]': 'bootleg' })}`);
    for (const until = Date.now() + pinTimeoutMs; Date.now() < until;) {
      if (signal?.aborted) throw new Error('Cancelled'); await sleep(pollMs);
      const r = await req(`${plexTv}/api/v2/pins/${pin.id}`, { headers: ident(cid) }); if (!r.ok) continue;
      const p = await r.json(); if (p.authToken) return p.authToken;
    }
    throw new Error('Plex sign-in was not approved in time (approve bootleg on the plex.tv page, then try again)');
  }
  // The first of a server's addresses that answers: on this network first, relays last.
  async function reachable(conns, token, cid) {
    const order = [...conns].sort((a, b) => (a.relay - b.relay) || (b.local - a.local) || ((b.protocol === 'https') - (a.protocol === 'https')));
    for (const c of order) { try { const r = await req(`${base(c.uri)}/identity`, { headers: { ...ident(cid), 'X-Plex-Token': token }, timeout: 4000 }); if (r.ok) return base(c.uri); } catch { /* next */ } }
    return null;
  }

  function track(t, section) {
    const m = t.Media?.[0] || {}, p = m.Part?.[0] || {};
    return { id: String(t.ratingKey), title: t.title || 'Untitled', artist: t.originalTitle || t.grandparentTitle || '', albumArtist: t.grandparentTitle || '', album: t.parentTitle || '', track: t.index || 0, disc: t.parentIndex || 0,
      year: t.year || t.parentYear || '', genre: t.Genre?.[0]?.tag || '', duration: t.duration ? t.duration / 1000 : undefined, size: p.size || 0, suffix: (p.container || m.container || 'mp3').toLowerCase(), bitrate: m.bitrate || 0,
      changed: t.updatedAt || t.addedAt || 0, coverId: t.parentThumb || t.thumb || '', rating: t.userRating ? t.userRating / 2 : 0, part: p.key || '', path: p.file || undefined, section };
  }
  function video(v, artist) {
    const m = v.Media?.[0] || {}, p = m.Part?.[0] || {}, container = String(p.container || m.container || '').toLowerCase();
    const direct = WEB_CONTAINERS.has(container) && (!m.videoCodec || WEB_VIDEO.has(m.videoCodec)) && (!m.audioCodec || WEB_AUDIO.has(m.audioCodec));
    return { id: String(v.ratingKey), kind: 'video', title: v.title || 'Untitled', artist: artist?.title || '', year: v.year || '', duration: v.duration ? v.duration / 1000 : undefined, size: p.size || 0, suffix: container || 'mp4', direct,
      changed: v.updatedAt || v.addedAt || 0, coverId: v.thumb || '', part: p.key || '', path: p.file || undefined };
  }
  async function pool(list, n, fn) { const out = []; let i = 0; await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => { while (i < list.length) { const k = i++; out[k] = await fn(list[k]); } })); return out; }

  return {
    id: 'plex', name: 'Plex', description: 'Music and music videos from a Plex Media Server. Connect opens plex.tv in your browser: sign in there and allow bootleg.',
    fields: [
      { key: 'server', label: 'Server name', type: 'text', placeholder: 'the first one', hint: 'When your account has more than one server.' },
      { key: 'url', label: 'Server address', type: 'url', placeholder: 'http://192.168.1.10:32400', hint: 'Only when bootleg cannot find the server through plex.tv, or for a server on this network that allows access without signing in.' },
    ],
    secrets: ['token'], halfStars: true, cors: false, offline: true,
    videos: true,                     // scan artist extras for music videos (the plugin's setting can turn it off)
    async connect(v, { signal } = {}) {
      const cid = clientId || 'bootleg-' + [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, '0')).join('');
      let url = v.url ? base(v.url) : '', token = '', name = '', machine = '';
      if (url) {      // a given address: no sign-in when the server allows this network without one
        const id = (await req(`${url}/identity`, { headers: ident(cid), timeout: 8000 }).then(json).catch(() => null))?.MediaContainer;
        if (!id?.machineIdentifier) throw new Error('That does not look like a Plex server'); machine = id.machineIdentifier;
        const r = await req(`${url}/library/sections`, { headers: ident(cid), timeout: 8000 });
        if (r.ok) name = id.friendlyName || new URL(url).host; else if (r.status !== 401) throw new Error(`The Plex server answered ${r.status}`);
      }
      if (!name) {
        const account = await signIn(cid, signal);
        const rr = await req(`${plexTv}/api/v2/resources?includeHttps=1&includeRelay=1`, { headers: { ...ident(cid), 'X-Plex-Token': account } }); if (!rr.ok) throw new Error(`plex.tv answered ${rr.status}`);
        const servers = (await rr.json()).filter(x => String(x.provides || '').split(',').includes('server')).sort((a, b) => (b.owned === true) - (a.owned === true));
        const want = String(v.server || '').trim().toLowerCase(), srv = machine ? servers.find(s => s.clientIdentifier === machine) : want ? servers.find(s => s.name.toLowerCase() === want) : servers[0];
        if (!srv && machine) throw new Error('That server is not one your Plex account can use');
        if (!srv) throw new Error(servers.length ? `No server called “${v.server}” (yours: ${servers.map(s => s.name).join(', ')})` : 'Your Plex account has no servers');
        token = srv.accessToken || account; name = srv.name;
        url = url || await reachable(srv.connections || [], token, cid); if (!url) throw new Error(`Could not reach “${srv.name}” at any of its addresses`);
      }
      const config = { url, clientId: cid, serverName: name, token };
      const ses = this.session(config); await call(ses, '/library/sections');      // the token works here
      return { config, title: `Plex · ${name}` };
    },
    session: config => ({ config, base: base(config.url) }),
    async *scan(ses, { signal } = {}) {
      const sections = ((await call(ses, '/library/sections')).Directory || []).filter(d => d.type === 'artist'); let songs = 0, vids = 0;
      for (const s of sections) {
        for (let start = 0; ;) {      // (a server may send fewer than asked for: page by what came and the total it reports)
          if (signal?.aborted) return;
          const mc = await call(ses, `/library/sections/${s.key}/all`, { query: { type: 10, 'X-Plex-Container-Start': start, 'X-Plex-Container-Size': PAGE } }), got = mc.Metadata || [];
          start += got.length; songs += got.length; yield { items: got.map(t => track(t, s.key)), progress: `Reading Plex… ${songs.toLocaleString()} tracks` };
          if (!got.length || start >= (mc.totalSize ?? mc.size ?? start)) break;
        }
        if (this.videos === false) continue;
        const artists = (await call(ses, `/library/sections/${s.key}/all`, { query: { type: 8 } })).Metadata || [];
        const found = await pool(artists, 6, async a => { if (signal?.aborted) return []; try { return ((await call(ses, `/library/metadata/${a.ratingKey}/extras`)).Metadata || []).filter(x => x.subtype === 'musicVideo' || x.extraType === 4).map(x => video(x, a)); } catch { return []; } });
        const items = found.flat(); vids += items.length; if (items.length) yield { items, progress: `Reading Plex… ${songs.toLocaleString()} tracks, ${vids.toLocaleString()} videos` };
      }
    },
    async playlists(ses) {
      const list = (await call(ses, '/playlists', { query: { playlistType: 'audio' } })).Metadata || [];
      return Promise.all(list.map(async p => ({ id: String(p.ratingKey), name: p.title || 'Playlist', owner: '', items: ((await call(ses, `/playlists/${p.ratingKey}/items`)).Metadata || []).map(x => String(x.ratingKey)) })));
    },
    setRating: (ses, id, stars) => call(ses, '/:/rate', { method: 'PUT', query: { key: id, identifier: 'com.plexapp.plugins.library', rating: stars > 0 ? Math.round(stars * 2) : -1 } }),
    async rescan(ses) { for (const s of ((await call(ses, '/library/sections')).Directory || []).filter(d => d.type === 'artist')) await call(ses, `/library/sections/${s.key}/refresh`); },
    streamUrl: (ses, it) => media(ses, it.part),
    coverUrl: (ses, it, px = 512) => it.coverId ? media(ses, '/photo/:/transcode', { width: px, height: px, minSize: 1, upscale: 1, url: it.coverId }) : '',
    fetch: (ses, u, init) => net(u, init),
    download: (ses, it) => ({ url: media(ses, it.part, { download: 1 }), ext: it.suffix || 'mp3', quality: 'original', bytes: it.size || undefined }),      // Plex converts only through its player profiles: originals only
  };
}
