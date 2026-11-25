// Subsonic / OpenSubsonic source plugin (Navidrome, Airsonic-Advanced, Gonic, Funkwhale's Subsonic API, …).
// This is the reference implementation of the source-plugin contract in ./plugin.js.
//   Auth: token auth (t = md5(password + salt), s = salt). Only the salt and token are stored — never the password.
//   Scan: walks albums (getAlbumList2, paged) and reads each album's songs (getAlbum) — works on every server.
import { md5 } from './md5.js';
import { netFetch } from './net.js';

const API = '1.16.1', CLIENT = 'bootleg';
const base = u => u.trim().replace(/\/+$/, '').replace(/\/rest$/, '');
const auth = c => `u=${encodeURIComponent(c.username)}&t=${c.token}&s=${c.salt}&v=${API}&c=${CLIENT}&f=json`;
const url = (ses, method, params = {}) => `${ses.base}/rest/${method}.view?${auth(ses.config)}${Object.entries(params).map(([k, v]) => `&${k}=${encodeURIComponent(v)}`).join('')}`;
async function call(ses, method, params) {
  let r; try { r = await netFetch(url(ses, method, params)); } catch (e) { throw new Error(`Could not reach the server (${e.message || e}). In a browser the server must allow CORS; the desktop app has no such limit.`); }
  if (!r.ok) throw new Error(`Server answered ${r.status}`);
  const j = (await r.json())['subsonic-response']; if (!j) throw new Error('That does not look like a Subsonic server');
  if (j.status !== 'ok') throw new Error(j.error?.message || 'Request failed'); return j;
}
const session = config => ({ config, base: base(config.url) });
const item = s => ({ id: String(s.id), title: s.title || s.name || 'Untitled', artist: s.artist || '', album: s.album || '', albumArtist: s.albumArtist || s.displayAlbumArtist || '', year: s.year || '', track: s.track || 0, disc: s.discNumber || 0, genre: s.genre || (s.genres?.[0]?.name) || '', duration: s.duration || 0, size: s.size || 0, suffix: s.suffix || 'mp3', changed: s.created ? Date.parse(s.created) || 0 : 0, coverId: s.coverArt || s.albumId || '', bitrate: s.bitRate || 0 });

export const subsonic = {
  id: 'subsonic', name: 'Subsonic / OpenSubsonic', description: 'Navidrome, Airsonic, Gonic and other Subsonic-compatible servers.',
  fields: [
    { key: 'url', label: 'Server address', type: 'url', required: true, placeholder: 'https://music.example.com', hint: 'The address you open in a browser (without /rest).' },
    { key: 'username', label: 'Username', type: 'text', required: true },
    { key: 'password', label: 'Password', type: 'password', required: true, hint: 'Not stored: only a salted token is kept.' },
  ],
  async connect(v) {
    const salt = [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, '0')).join(''), config = { url: base(v.url), username: v.username.trim(), salt, token: md5(v.password + salt) };
    const ses = session(config), j = await call(ses, 'ping');   // wrong credentials / not a Subsonic server → throws with the server's message
    return { config, title: `${config.username}@${new URL(config.url).host}`, info: { server: j.type || 'subsonic', version: j.serverVersion || j.version } };
  },
  session,
  async *scan(ses, { signal } = {}) {
    const PAGE = 500; let offset = 0, done = 0, songs = 0;
    for (;;) {
      if (signal?.aborted) return; const albums = (await call(ses, 'getAlbumList2', { type: 'alphabeticalByName', size: PAGE, offset })).albumList2?.album || []; if (!albums.length) break;
      for (let i = 0; i < albums.length; i += 6) {                                   // 6 albums at a time
        const got = await Promise.all(albums.slice(i, i + 6).map(a => call(ses, 'getAlbum', { id: a.id }).then(r => r.album?.song || []).catch(() => [])));
        const items = got.flat().map(item); done += Math.min(6, albums.length - i); songs += items.length; yield { items, progress: `Reading server… ${(offset + done).toLocaleString()} albums, ${songs.toLocaleString()} tracks` };
      }
      offset += albums.length; if (albums.length < PAGE) break;
    }
  },
  streamUrl: (ses, it) => url(ses, 'stream', { id: it.id, format: 'raw' }),
  coverUrl: (ses, it, px = 512) => it.coverId ? url(ses, 'getCoverArt', { id: it.coverId, size: px }) : '',
  fetch: (ses, u, init) => netFetch(u, init),
};
