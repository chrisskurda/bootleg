// bootleg stem server source plugin: the songs a stem server keeps (.bstem / .bsong packages and render folders), as
// stem sets in the library; their grades ↔ bootleg ratings, favourites ↔ the "starred" tag, the server's playlists.
//   API v2 (contracts/server_api.md in bootleg-stemserver): one request lists every song with its files and manifest.
//   API v1 (MusicGen's audition server): renders, one request each for their files — supported while you move over.
// Each song's files become "file items" laid out like a song folder (<song id>/stems/kick.flac, …/mix.flac,
// …/manifest.json), so the library groups them into one stem set exactly as it does a folder on disk. A song's id is
// its permanent id (v1 renders get the same id the stem server derives for them), so notes follow it everywhere.
import { netFetch } from './net.js';

const base = u => u.trim().replace(/\/+$/, '').replace(/\/api\/v\d+$/, '');
const NAMESPACE = '6f1c0f8e-4b8e-5a3e-9d5e-b007de90b007';         // contracts/song_format.md "Ids for older material"
const enc = p => p.split('/').map(encodeURIComponent).join('/');

// uuid5(NAMESPACE, name): the id a song without one gets, the same on the server and here
export async function folderId(name) {
  const ns = Uint8Array.from(NAMESPACE.replace(/-/g, '').match(/../g).map(h => parseInt(h, 16))), n = new TextEncoder().encode(name);
  const h = new Uint8Array(await crypto.subtle.digest('SHA-1', Uint8Array.from([...ns, ...n]))).slice(0, 16);
  h[6] = (h[6] & 0x0f) | 0x50; h[8] = (h[8] & 0x3f) | 0x80;
  const x = [...h].map(b => b.toString(16).padStart(2, '0')).join(''); return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

async function call(ses, path, init) {
  let r; try { r = await netFetch(`${ses.base}/${path}`, init); } catch (e) { throw new Error(`Could not reach the stem server (${e.message || e}). Is it running, and is this computer on its network?`); }
  if (!r.ok) { let msg = ''; try { msg = (await r.json()).error; } catch { /* not JSON */ } throw new Error(msg || `Server answered ${r.status}`); }
  return r.json();
}
const session = config => ({ config, base: base(config.url), api: config.api || 2 });
const isPlayable = p => p === 'manifest.json' || p === 'clips.json' || /^(mix|master|final|bounce)\.[^/]+$/i.test(p) || /^cover\.(jpe?g|png|webp)$/i.test(p) || /^stems\/[^/]+$/.test(p);

// one song → its file items
function fileItems(song, files, manifest, href) {
  const changed = Math.round((song.modified || 0) * 1000), a = song.annotations || {};
  const info = { id: song.id, title: manifest?.title || song.title || song.name, rating: a.rating || 0, starred: !!a.fav, grade: a.grade || '', kind: song.kind, name: song.name };
  return files.filter(f => isPlayable(f.path)).map(f => ({
    id: `${song.id}/${f.path}`, kind: 'file', rel: `${song.id}/${f.path}`, href: href(f.path), size: f.size || 0, changed,
    ...(f.path === 'manifest.json' ? { text: JSON.stringify(manifest || {}), song: info } : {}),
  }));
}

export const stemserver = {
  id: 'stemserver', name: 'bootleg stem server', description: 'Songs from a bootleg stem server (or MusicGen’s audition server): stem sets, grades, playlists.',
  fields: [{ key: 'url', label: 'Server address', type: 'url', required: true, placeholder: 'http://192.168.0.10:8766', hint: 'The stem server on your network (no login; LAN or VPN only).' }],
  halfStars: true,                                                       // grades map to half stars (A+ … F ↔ 5 … ½)
  async connect(v) {
    const b = base(v.url); let api = 2, info;
    try { info = await call({ base: b }, 'api/v2/info'); } catch (e) { info = await call({ base: b }, 'api/v1/info').catch(() => { throw e; }); api = 1; }
    if (!info || !info.api) throw new Error('That does not look like a stem server');
    return { config: { url: b, api }, title: `${info.app === 'bootleg-stemserver' ? 'Stem server' : 'MusicGen'} @ ${new URL(b).host}`, info: { server: info.app || 'musicgen', version: info.app_version || info.version?.commit?.slice(0, 7) } };
  },
  session,
  async *scan(ses, { signal } = {}) {
    if (ses.api >= 2) {
      const songs = await call(ses, 'api/v2/songs'); let n = 0, items = [];
      for (const s of songs) {
        if (signal?.aborted) return; if (!s.files?.some(f => f.path.startsWith('stems/'))) continue;
        items.push(...fileItems(s, s.files, s.manifest, p => `api/v2/songs/${encodeURIComponent(s.id)}/files/${enc(p)}`)); n++;
        if (items.length > 2000) { yield { items, progress: `Reading stem server… ${n.toLocaleString()} songs` }; items = []; }
      }
      yield { items, progress: `${n.toLocaleString()} songs` }; return;
    }
    const renders = await call(ses, 'api/v1/renders'); let done = 0;                 // v1: one request per render, 8 at a time
    for (let i = 0; i < renders.length; i += 8) {
      if (signal?.aborted) return;
      const got = await Promise.all(renders.slice(i, i + 8).map(async r => {
        try {
          const d = await call(ses, `api/v1/renders/${encodeURIComponent(r.dir)}`), id = d.manifest?.id || await folderId(r.dir);
          if (!d.files?.some(f => f.path.startsWith('stems/'))) return [];
          const man = { ...d.manifest, id, title: d.manifest?.title || d.manifest?.name || r.dir };
          return fileItems({ id, name: r.dir, kind: 'folder', modified: r.modified, title: man.title }, [{ path: 'manifest.json', size: 0 }, ...d.files.filter(f => f.path !== 'manifest.json')], man, p => `renders/${encodeURIComponent(r.dir)}/${enc(p)}`);
        } catch { return []; }
      }));
      done += got.length; yield { items: got.flat(), progress: `Reading MusicGen server… ${done.toLocaleString()} of ${renders.length.toLocaleString()} renders` };
    }
  },
  streamUrl: (ses, it) => `${ses.base}/${it.href}`,
  offline: true,                                                         // songs' files, as they are (no conversion on this server)
  download: (ses, it) => ({ url: `${ses.base}/${it.href}`, ext: (it.rel.split('.').pop() || 'bin').toLowerCase(), quality: 'original' }),
  fetch: (ses, u, init) => netFetch(u, init),
  async playlists(ses) { if (ses.api < 2) return []; return (await call(ses, 'api/v2/playlists')).map(p => ({ id: p.name, name: p.name, owner: '', items: p.items })); },
  async setRating(ses, id, stars) { if (ses.api < 2) return; await call(ses, `api/v2/songs/${encodeURIComponent(id)}/annotations`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rating: stars }) }); },
  async setStarred(ses, id, on) { if (ses.api < 2) return; await call(ses, `api/v2/songs/${encodeURIComponent(id)}/annotations`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fav: !!on }) }); },
  // ask Composer (polling the server) to open a song
  async openInComposer(ses, id) { if (ses.api < 2) throw new Error('Needs a bootleg stem server (API v2)'); return call(ses, 'api/v2/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ song: id, app: 'composer' }) }); },
};
