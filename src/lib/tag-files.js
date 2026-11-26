// Writing tag edits into the files themselves (desktop app; off until turned on in Settings → Tag edits → files).
// Until then, and until written, an edit only changes what bootleg shows (library.js setEdits).
//
//   local track  → its own file. The file must still be the one bootleg read (same size), else it is skipped.
//   server track → the server's music folder as this computer sees it (an SMB share, …), chosen once per connection.
//                  The file is found by the path the server reports (Navidrome: Settings → Players → bootleg → Report Real
//                  Path); the share may sit higher or lower than the server's folder, which `detect` works out. Without a
//                  usable path, the file is found by its exact size (and type) — never guessed when two files share a size.
//                  After writing, the server is asked to rescan; once it reports the new tags the bootleg edit is dropped
//                  (prune), so the file is the single truth again.
// Every write goes through the native writer: a copy gets the new tags and replaces the file in one rename.
const shown = v => (v == null || v === 0 ? '' : String(v));
const join = (...p) => p.filter(Boolean).join('/').replace(/\/{2,}/g, '/');
const ext = p => (p.split('.').pop() || '').toLowerCase();
const relOf = (path, drop) => path.split('/').filter(Boolean).slice(drop).join('/');

export class TagFiles extends EventTarget {
  // fs: { stat(path) → { size } (throws if missing), readDir(path) → [{ name, isDirectory }], scan(root) → [{ path, size }],
  //       allow(path), write(path, fields) → { size, mtime } } · makeSource(path, size, mtime) → a local library source
  // patchIndex(path, size, mtime): keeps the remembered folder index in step with a file bootleg rewrote
  constructor({ lib, store, kv, keyOf, fs, getPlugin, sessionOf, makeSource, patchIndex = async () => {} }) {
    super(); Object.assign(this, { lib, store, kv, keyOf, fs, getPlugin, sessionOf, makeSource, patchIndex }); this._sizes = new Map(); this.running = false;
  }
  folders() { return this.kv.get('tagFolders', {}); }
  async setFolder(conn, root) {
    const all = this.folders(); if (!root) delete all[conn]; else { await this.fs.allow(root); all[conn] = { root, prefix: '', drop: 0 }; } this.kv.set('tagFolders', all); this._sizes.delete(conn);
    return root ? this.detect(conn) : null;
  }
  async allowFolders() { for (const f of Object.values(this.folders())) await this.fs.allow(f.root).catch(() => {}); }
  async reachable(root) { try { await this.fs.stat(root); return true; } catch { return false; } }
  async _sizeOk(p, size) { try { const st = await this.fs.stat(p); return !size || st.size === size; } catch { return false; } }

  // Works out how the server's paths sit under the chosen folder, from a sample of its tracks: the folder may be the server's
  // music folder itself, its parent (then a subfolder is the prefix), or the server may report longer paths (drop leading parts).
  async detect(conn) {
    const f = this.folders()[conn]; if (!f) return null; const items = this._items(conn).filter(i => i.path).slice(0, 8);
    const res = { conn, root: f.root, reachable: await this.reachable(f.root), sample: items.length, matched: 0, prefix: '', drop: 0, realPaths: items.length > 0 };
    if (!res.reachable || !items.length) return res;
    let prefixes = ['']; try { prefixes = ['', ...(await this.fs.readDir(f.root)).filter(e => e.isDirectory && !e.name.startsWith('.')).map(e => e.name)]; } catch { /* keep '' */ }
    let best = { n: 0 };
    for (const prefix of prefixes) for (let drop = 0; drop <= 3; drop++) {
      let n = 0; for (const it of items) if (await this._sizeOk(join(f.root, prefix, relOf(it.path, drop)), it.size)) n++;
      if (n > best.n) best = { n, prefix, drop }; if (n === items.length) break;
    }
    Object.assign(res, { matched: best.n, prefix: best.prefix || '', drop: best.drop || 0 });
    if (best.n) { const all = this.folders(); all[conn] = { ...all[conn], prefix: res.prefix, drop: res.drop }; this.kv.set('tagFolders', all); }
    return res;
  }
  _items(conn) { return this.lib.tracks.filter(t => t.src?.kind === 'remote' && t.src.remote?.conn === conn).map(t => t.src.remote.item); }
  async _sizeIndex(conn, root) {
    if (!this._sizes.has(conn)) this._sizes.set(conn, (async () => { const m = new Map(); for (const e of await this.fs.scan(root)) { const k = e.size + '.' + ext(e.path); (m.get(k) || m.set(k, []).get(k)).push(e.path); } return m; })());
    return this._sizes.get(conn);
  }

  // → { path, how } or { error, offline? }
  async resolve(t) {
    const s = t.src;
    if (s?.kind === 'tauri') return (await this._sizeOk(s.path, s.size)) ? { path: s.path, how: 'library file' } : { error: 'the file changed on disk since bootleg read it — check for changes first' };
    if (s?.kind !== 'remote') return { error: 'only files on this computer or in a server’s shared folder can be written' };
    const { conn, item } = s.remote, f = this.folders()[conn]; if (!f?.root) return { error: 'choose the folder this server’s music is shared from (Settings → Tag edits → files)' };
    if (!(await this.reachable(f.root))) return { error: `${f.root} is not reachable (is the share mounted?)`, offline: true };
    if (item.path) { const p = join(f.root, f.prefix, relOf(item.path, f.drop || 0)); if (await this._sizeOk(p, item.size)) return { path: p, how: 'server path' }; }
    if (!item.size) return { error: 'the server reports neither a usable path nor a size for this track' };
    const m = (await this._sizeIndex(conn, f.root)).get(item.size + '.' + (item.suffix || ext(s.name))) || [];
    return m.length === 1 ? { path: m[0], how: 'matched by size' } : { error: m.length ? `${m.length} files have exactly this size — cannot tell which one` : 'no file in the folder matches this track' };
  }

  // Edited tracks with their changes and state, for the review list.
  async pending() {
    const out = [];
    for (const t of this.lib.tracks) {
      if (!t.edited || !t.orig) continue; const key = this.keyOf(t), rec = await this.store.get(key);
      out.push({ t, key, approved: !!rec.editState?.approved, written: rec.editState?.written || 0, changes: [...t.edited].map(k => ({ field: k, from: shown(t.orig[k]), to: shown(t[k]) })) });
    }
    return out;
  }

  // Writes the given pending entries. Returns [{ entry, ok, path?, how?, error?, offline? }].
  async apply(entries, { onProgress = () => {} } = {}) {
    if (this.running) throw new Error('already writing'); this.running = true; const results = [], rescan = new Set(); let i = 0;
    try {
      for (const e of entries) {
        onProgress(++i, entries.length, e); const { t } = e; if (e.written && t.src?.kind === 'remote') { results.push({ entry: e, ok: true, skipped: 'already written; waiting for the server to rescan' }); continue; }
        const r = await this.resolve(t); if (r.error) { results.push({ entry: e, ok: false, ...r }); continue; }
        const edited = [...t.edited], fields = Object.fromEntries(edited.map(k => [k, t[k] ?? '']));      // captured now: moving the notes re-derives the track
        try {
          const w = await this.fs.write(r.path, fields);
          if (t.src.kind === 'tauri') {      // the file is now the truth: move the notes to the new size's key, drop the edit, re-read
            const src = this.makeSource(r.path, w.size, w.mtime), newKey = this.keyOf({ ...t, src });
            await this.store.rekey({ [e.key]: newKey }); await this.patchIndex(r.path, w.size, w.mtime); this.lib._update(t, src);
            await this.store.setEdits(newKey, Object.fromEntries(edited.map(k => [k, null])));
          } else { await this.store.setEditState(e.key, { written: Date.now() }); rescan.add(t.src.remote.plugin + '|' + t.src.remote.conn); }
          results.push({ entry: e, ok: true, path: r.path, how: r.how });
        } catch (err) { results.push({ entry: e, ok: false, path: r.path, error: String(err?.message || err) }); }
      }
      for (const pc of rescan) { const [plugin, conn] = pc.split('|'), p = this.getPlugin(plugin), ses = this.sessionOf({ plugin, conn }); if (p?.rescan && ses) await p.rescan(ses).catch(() => {}); }
    } finally { this.running = false; }
    const log = { at: Date.now(), ok: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, lines: results.filter(r => !r.ok).slice(0, 50).map(r => `${r.entry.t.title}: ${r.error}`) };
    this.kv.set('tagWriteLog', log); this.dispatchEvent(new CustomEvent('done', { detail: log })); return results;
  }
  lastRun() { return this.kv.get('tagWriteLog', null); }

  // An edit the source now agrees with (the server re-read the file we wrote, or someone fixed the file) is no longer needed.
  async prune() {
    let n = 0;
    for (const t of this.lib.tracks) {
      if (!t.edited || !t.orig) continue; const same = [...t.edited].filter(k => shown(t.orig[k]) === shown(t[k])); if (!same.length) continue;
      await this.store.setEdits(this.keyOf(t), Object.fromEntries(same.map(k => [k, null]))); n++;
    }
    return n;
  }
}
