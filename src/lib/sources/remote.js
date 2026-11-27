// Turns a plugin's Items into library "sources": the same shape the folder scanner produces (name/path/size/mtime/url),
// plus `meta` (already-known tags, so nothing is read from the file) and `remote` (how to get it back after a restart).
import { offlineUrl } from '../offline-hook.js';
import { mediaUrl } from './net.js';
const clean = s => String(s || 'track').replace(/[\\/:*?"<>|]+/g, '_');
export const rootKey = (plugin, connId) => `${plugin.id}:${connId}`;

export function remoteSource(plugin, session, connId, item) {
  if (item.kind === 'file') return fileSource(plugin, session, connId, item);
  const root = rootKey(plugin, connId), cover = plugin.coverUrl ? plugin.coverUrl(session, item, 512) : '';
  return {
    kind: 'remote', name: `${clean(item.title)}.${item.suffix || (item.kind === 'video' ? 'mp4' : 'mp3')}`, path: `${root}/${item.id}`, size: item.size || 0, mtime: item.changed || 0,
    url: () => offlineUrl(`${root}/${item.id}`) || plugin.streamUrl(session, item),          // a kept offline copy first
    ...(plugin.cors === false ? { urlAsync: async () => offlineUrl(`${root}/${item.id}`) || mediaUrl(plugin.streamUrl(session, item)) } : {}),      // what the player loads (src/lib/sources/net.js)
    fetch: init => { const off = offlineUrl(`${root}/${item.id}`); return off ? fetch(off, init) : plugin.fetch ? plugin.fetch(session, plugin.streamUrl(session, item), init) : fetch(plugin.streamUrl(session, item), init); },
    reader: null, text: async () => '',
    meta: { title: item.title, artist: item.artist || '', album: item.album || '', albumArtist: item.albumArtist || '', year: item.year || '', track: item.track || 0, disc: item.disc || 0, genre: item.genre || '', duration: item.duration || undefined, coverUrl: cover || null, remote: plugin.id, ...(item.kind === 'video' ? { video: true } : {}) },
    remote: { plugin: plugin.id, conn: connId, item },   // persisted in the file index so the library appears instantly (and offline) on the next start
  };
}
// A plain file a plugin offers (a song's stem, mix, manifest, cover): no tags of its own; laid out under `rel` like a
// folder on disk, so the library finds stem sets in it the same way. `text` may come inline (a manifest in the listing).
function fileSource(plugin, session, connId, item) {
  const root = rootKey(plugin, connId), key = `${root}/${item.rel}`, online = () => plugin.streamUrl(session, item), url = () => offlineUrl(key) || online();
  const get = init => { const off = offlineUrl(key); return off ? fetch(off, init) : plugin.fetch ? plugin.fetch(session, online(), init) : fetch(online(), init); };
  return {
    kind: 'remote', name: item.rel.split('/').pop(), path: `${root}/${item.rel}`, size: item.size || 0, mtime: item.changed || 0, url, fetch: get, reader: null,
    text: item.text != null ? async () => item.text : async () => { const r = await get(); if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); },
    remote: { plugin: plugin.id, conn: connId, item },
  };
}
// Index entries (what the cache stores) ↔ sources
export const toIndexEntry = s => ({ path: s.path, size: s.size, mtime: s.mtime, remote: s.remote });
export const fromIndexEntry = (e, getPlugin, getSession) => { const p = getPlugin(e.remote.plugin), ses = p && getSession(e.remote); return p && ses ? remoteSource(p, ses, e.remote.conn, e.remote.item) : null; };

// Scan a whole connection → sources, reporting progress.
export async function scanConnection(plugin, session, connId, { onProgress = () => {}, signal } = {}) {
  const out = []; for await (const page of plugin.scan(session, { signal })) { for (const it of page.items) out.push(remoteSource(plugin, session, connId, it)); onProgress(page.progress || `${out.length} tracks`); } return out;
}
