// Turns a plugin's Items into library "sources": the same shape the folder scanner produces (name/path/size/mtime/url),
// plus `meta` (already-known tags, so nothing is read from the file) and `remote` (how to get it back after a restart).
const clean = s => String(s || 'track').replace(/[\\/:*?"<>|]+/g, '_');
export const rootKey = (plugin, connId) => `${plugin.id}:${connId}`;

export function remoteSource(plugin, session, connId, item) {
  const root = rootKey(plugin, connId), cover = plugin.coverUrl ? plugin.coverUrl(session, item, 512) : '';
  return {
    kind: 'remote', name: `${clean(item.title)}.${item.suffix || 'mp3'}`, path: `${root}/${item.id}`, size: item.size || 0, mtime: item.changed || 0,
    url: () => plugin.streamUrl(session, item), fetch: plugin.fetch ? (init) => plugin.fetch(session, plugin.streamUrl(session, item), init) : null,
    reader: null, text: async () => '',
    meta: { title: item.title, artist: item.artist || '', album: item.album || '', albumArtist: item.albumArtist || '', year: item.year || '', track: item.track || 0, disc: item.disc || 0, genre: item.genre || '', duration: item.duration || undefined, coverUrl: cover || null, remote: plugin.id },
    remote: { plugin: plugin.id, conn: connId, item },   // persisted in the file index so the library appears instantly (and offline) on the next start
  };
}
// Index entries (what the cache stores) ↔ sources
export const toIndexEntry = s => ({ path: s.path, size: s.size, mtime: s.mtime, remote: s.remote });
export const fromIndexEntry = (e, getPlugin, getSession) => { const p = getPlugin(e.remote.plugin), ses = p && getSession(e.remote); return p && ses ? remoteSource(p, ses, e.remote.conn, e.remote.item) : null; };

// Scan a whole connection → sources, reporting progress.
export async function scanConnection(plugin, session, connId, { onProgress = () => {}, signal } = {}) {
  const out = []; for await (const page of plugin.scan(session, { signal })) { for (const it of page.items) out.push(remoteSource(plugin, session, connId, it)); onProgress(page.progress || `${out.length} tracks`); } return out;
}
