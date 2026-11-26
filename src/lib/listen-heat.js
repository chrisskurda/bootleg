// What the Now playing timeline remembers per recording, outside the notes (it is derived, not something you wrote):
//   * the listening heatmap — how much of each part of the song has actually been heard (BINS slices; replays and
//     loops make a part hotter, skipped parts stay cold),
//   * the spectrogram cache (computing one means decoding the whole file).
// Backends: IndexedDB in the app, a Map in tests and wherever IndexedDB is unavailable.
export const BINS = 120;

export class MapKV { constructor() { this.m = new Map(); } async get(s, k) { return this.m.get(s + '|' + k); } async put(s, k, v) { this.m.set(s + '|' + k, v); } async keys(s) { return [...this.m.keys()].filter(k => k.startsWith(s + '|')).map(k => k.slice(s.length + 1)); } async del(s, k) { this.m.delete(s + '|' + k); } }
export class IdbKV {
  constructor(name = 'bootleg-now') {
    this.db = new Promise((ok, bad) => { const r = indexedDB.open(name, 1); r.onupgradeneeded = () => { for (const s of ['heat', 'spectro']) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s); }; r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error); });
  }
  async _do(s, mode, fn) { const db = await this.db; return new Promise((ok, bad) => { const tx = db.transaction(s, mode), req = fn(tx.objectStore(s)); tx.oncomplete = () => ok(req?.result); tx.onerror = () => bad(tx.error); }); }
  get(s, k) { return this._do(s, 'readonly', st => st.get(k)); }
  put(s, k, v) { return this._do(s, 'readwrite', st => st.put(v, k)); }
  del(s, k) { return this._do(s, 'readwrite', st => st.delete(k)); }
  keys(s) { return this._do(s, 'readonly', st => st.getAllKeys()); }
}

export class ListenHeat extends EventTarget {
  constructor(kv) { super(); this.kv = kv; this.key = null; this.bins = null; this._dirty = false; this._last = null; }
  async load(key) {
    await this.flush(); this.key = key; this._last = null; const v = key ? await this.kv.get('heat', key) : null;
    if (this.key !== key) return this.bins; this.bins = v?.length === BINS ? Float32Array.from(v) : new Float32Array(BINS); this.dispatchEvent(new Event('change')); return this.bins;
  }
  // Called often while playing. Only continuous listening counts: a jump (seek) starts a new stretch.
  tick(pos, dur, playing) {
    if (!this.bins || !dur || !playing) { this._last = null; return; } const last = this._last; this._last = pos;
    if (last == null || pos < last || pos - last > 1.5) return; const b = Math.min(BINS - 1, Math.floor(pos / dur * BINS)); this.bins[b] += pos - last; this._dirty = true;
  }
  async flush() { if (!this._dirty || !this.key || !this.bins) return; this._dirty = false; await this.kv.put('heat', this.key, Array.from(this.bins, v => Math.round(v * 10) / 10)).catch(() => {}); }
  // 0…1 per bin, relative to how long a bin takes to play once — so "1" means heard about once, and it saturates at 4 plays.
  levels(dur) { const once = dur / BINS || 1; return this.bins ? Array.from(this.bins, v => Math.min(1, v / once / 4)) : []; }
}

// Spectrograms, keyed by the recording, with the oldest dropped beyond `keep`.
export class SpectroCache {
  constructor(kv, keep = 400) { this.kv = kv; this.keep = keep; this.mem = new Map(); }
  async get(key) { if (this.mem.has(key)) return this.mem.get(key); const v = await this.kv.get('spectro', key).catch(() => null); if (v) this._mem(key, v); return v || null; }
  async put(key, s) {
    const v = { cols: s.cols, rows: s.rows, data: s.data, at: Date.now() }; this._mem(key, v); await this.kv.put('spectro', key, v).catch(() => {});
    if (Math.random() < 0.1) { const keys = await this.kv.keys('spectro').catch(() => []); if (keys.length > this.keep) { const ages = await Promise.all(keys.map(async k => [k, (await this.kv.get('spectro', k))?.at || 0])); ages.sort((a, b) => a[1] - b[1]); for (const [k] of ages.slice(0, keys.length - this.keep)) await this.kv.del('spectro', k); } }
  }
  _mem(k, v) { this.mem.set(k, v); if (this.mem.size > 8) this.mem.delete(this.mem.keys().next().value); }
}
