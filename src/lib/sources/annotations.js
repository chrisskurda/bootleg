// What a server can keep about its tracks, kept in step with bootleg — for source plugins that offer it (Subsonic):
//   * rating: bootleg's half stars ↔ the server's whole stars (3.5 is sent as 4; bootleg keeps its half star unless the
//     server's value changes),
//   * star: the server's favourite ↔ the bootleg tag "starred" (so it is filterable in Notes like any tag),
//   * playlists: copies of the server's playlists in Playlists, refreshed on every sync (read-only here).
// Conflicts: we remember what the server said at the last sync. A side that changed since then wins; if both did, the server.
// The memory is only of non-default values ({ itemId: [stars, starred] }), so it stays small for big libraries.
export const STAR_TAG = 'starred';
export const serverPlaylistId = (plugin, connId, id) => `srv:${plugin}:${connId}:${id}`;
const KEY_RE = /^file:([\w-]+):([^/]+)\/(.+)#\d*$/;           // a server track's notes key: file:<plugin>:<connection>/<item id>#<size>
const stars = r => Math.round(r || 0);

export class RemoteAnnotations {
  // notes: NotesStore · kv: { get(k, d), set(k, v) } · getPlugin(id) · sessionOf({ plugin, conn }) · onError(message)
  constructor({ notes, kv, getPlugin, sessionOf, onError = () => {} }) {
    Object.assign(this, { notes, kv, getPlugin, sessionOf, onError }); this._seen = new Map();
    notes.addEventListener('change', e => { if (typeof e.detail === 'string' && KEY_RE.test(e.detail)) this.push(e.detail).catch(err => this.onError(String(err.message || err))); });
  }
  seen(conn) { if (!this._seen.has(conn)) this._seen.set(conn, this.kv.get('remoteSeen.' + conn, {})); return this._seen.get(conn); }
  _remember(conn, id, [r, s]) { const m = this.seen(conn); if (r || s) m[id] = [r, s]; else delete m[id]; this.kv.set('remoteSeen.' + conn, m); }

  // After a scan. `tracks`: [{ key, item }] for this connection's tracks (item = the plugin's Item, with rating/starred).
  async pull(plugin, connId, session, tracks) {
    const out = { ratings: 0, stars: 0, pushed: 0, playlists: 0 };
    if (plugin.setRating || plugin.setStarred) {
      const recs = new Map((await this.notes.b.all()).filter(x => x.key.startsWith('t:')).map(x => [x.value.key, x.value])), was = this.seen(connId), push = [];
      for (const { key, item } of tracks) {
        const rec = recs.get(key), local = [stars(rec?.rating), !!rec?.tags?.includes(STAR_TAG)], srv = [item.rating || 0, !!item.starred], prev = was[item.id] || [0, false];
        const want = [0, 1].map(i => (srv[i] !== prev[i] ? srv[i] : local[i]));        // the server changed since last time → it wins; otherwise ours
        this._remember(connId, item.id, srv);                                           // before writing locally, so our own change events see nothing to push
        if (plugin.setRating && want[0] !== local[0]) { await this.notes.setRating(key, want[0]); out.ratings++; }
        if (plugin.setStarred && want[1] !== local[1]) { const tags = rec?.tags || []; await this.notes.setTags(key, want[1] ? [...tags, STAR_TAG] : tags.filter(t => t !== STAR_TAG)); out.stars++; }
        if ((plugin.setRating && want[0] !== srv[0]) || (plugin.setStarred && want[1] !== srv[1])) push.push(key);   // changed here while we were away
      }
      for (const key of push) { await this.push(key); out.pushed++; }
    }
    if (plugin.playlists) out.playlists = await this.pullPlaylists(plugin, connId, session, tracks);
    return out;
  }
  async pullPlaylists(plugin, connId, session, tracks) {
    const keyOf = new Map(tracks.map(t => [t.item.id, t.key])), keep = new Set(), lists = await plugin.playlists(session);
    for (const p of lists) {
      const id = serverPlaylistId(plugin.id, connId, p.id); keep.add(id);
      await this.notes.savePlaylist({ id, name: p.name, items: p.items.map(i => keyOf.get(i)).filter(Boolean), server: { plugin: plugin.id, conn: connId, id: p.id, owner: p.owner || '' } });
    }
    for (const p of await this.notes.playlists()) if (p.server?.plugin === plugin.id && p.server.conn === connId && !keep.has(p.id)) await this.notes.deletePlaylist(p.id);
    return lists.length;
  }
  // A rating or the "starred" tag changed in bootleg: tell the server, if it differs from what the server last said.
  // One push at a time: two quick edits (rate, then star) must not both read the old memory and send the rating twice.
  push(key) { const run = this._chain.then(() => this._push(key)); this._chain = run.catch(() => {}); return run; }
  _chain = Promise.resolve();
  async _push(key) {
    const m = KEY_RE.exec(key); if (!m) return; const [, pid, conn, id] = m, plugin = this.getPlugin(pid), session = plugin && this.sessionOf({ plugin: pid, conn }); if (!session) return;
    const rec = await this.notes.get(key), local = [stars(rec.rating), rec.tags.includes(STAR_TAG)], prev = [...(this.seen(conn)[id] || [0, false])];
    if (plugin.setRating && local[0] !== prev[0]) { await plugin.setRating(session, id, local[0]); prev[0] = local[0]; }
    if (plugin.setStarred && local[1] !== prev[1]) { await plugin.setStarred(session, id, local[1]); prev[1] = local[1]; }
    this._remember(conn, id, prev);
  }
  // A connection was removed: its playlist copies and sync memory go (ratings and notes stay — they are yours).
  async forget(pluginId, connId) {
    for (const p of await this.notes.playlists()) if (p.server?.plugin === pluginId && p.server.conn === connId) await this.notes.deletePlaylist(p.id);
    this._seen.delete(connId); this.kv.set('remoteSeen.' + connId, {});
  }
}
