// Persistent library cache (IndexedDB): what we learned about each file (tags, cover, parsed .nfo), keyed by path and
// validated by size + modified time, plus the file index of each library root so the app can show the whole library
// instantly on startup and then look for changes in the background.
const STORES = ['files', 'covers', 'index'];
export class LibCache {
  constructor(name = 'bootleg-lib') {
    this.p = new Promise((ok, no) => { const r = indexedDB.open(name, 1); r.onupgradeneeded = () => STORES.forEach(s => r.result.createObjectStore(s)); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
    this.p.catch(() => {});
  }
  async _tx(store, mode, fn) { const db = await this.p, tx = db.transaction(store, mode), s = tx.objectStore(store); const res = fn(s); return new Promise((ok, no) => { tx.oncomplete = () => ok(res && 'result' in res ? res.result : undefined); tx.onerror = tx.onabort = () => no(tx.error); }); }
  async _all(store) { const db = await this.p, s = db.transaction(store).objectStore(store); const [k, v] = await Promise.all([new Promise((ok, no) => { const r = s.getAllKeys(); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); }), new Promise((ok, no) => { const r = s.getAll(); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); })]); return new Map(k.map((key, i) => [key, v[i]])); }
  loadFiles() { return this._all('files'); } loadCovers() { return this._all('covers'); }
  putFiles(recs) { return this._tx('files', 'readwrite', s => { for (const r of recs) s.put(r, r.path); }); }
  delFiles(paths) { return this._tx('files', 'readwrite', s => { for (const p of paths) s.delete(p); }); }
  putCover(key, blob) { return this._tx('covers', 'readwrite', s => { s.put(blob, key); }); }
  putIndex(root, entries) { return this._tx('index', 'readwrite', s => { s.put({ root, entries, at: Date.now() }, root); }); }
  async indexes() { return [...(await this._all('index')).values()]; }
  delIndex(root) { return this._tx('index', 'readwrite', s => { s.delete(root); }); }
  async stats() { const [f, c, i] = await Promise.all(STORES.map(s => this._all(s))); return { files: f.size, covers: c.size, roots: i.size, indexed: [...i.values()].reduce((n, x) => n + x.entries.length, 0) }; }
  async clear() { for (const s of STORES) await this._tx(s, 'readwrite', st => { st.clear(); }); }
}
export class NullCache { async loadFiles() { return new Map(); } async loadCovers() { return new Map(); } async putFiles() {} async delFiles() {} async putCover() {} async putIndex() {} async indexes() { return []; } async delIndex() {} async stats() { return { files: 0, covers: 0, roots: 0, indexed: 0 }; } async clear() {} }
