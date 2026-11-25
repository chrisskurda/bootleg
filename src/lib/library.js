// The library: plain tracks and stem renders, found in the sources you add. Tags are read in the background,
// remembered in a persistent cache (validated by size + mtime), and .nfo files in the folders add/fill metadata.
import { readTags } from './tags.js';
import { AUDIO_RE, NFO_RE } from './source.js';
import { NullCache } from './cache.js';
import { parseNfo } from './nfo.js';

const dirOf = p => p.slice(0, Math.max(0, p.lastIndexOf('/')));
const stem = n => n.replace(/\.[^.]+$/, '');
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export const sortKey = t => [t.artist || '', t.album || '', t.disc || 0, t.track || 0, t.title || ''];
const same = (a, b) => a.size === b.size && (a.mtime || 0) === (b.mtime || 0);

// Covers are shrunk to <=512px JPEG: smaller cache, less memory, plenty for lists, cards and the visualizer.
async function thumb(blob) {
  try {
    if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') return blob;
    const bmp = await createImageBitmap(blob), k = Math.min(1, 512 / Math.max(bmp.width, bmp.height)); if (k === 1 && blob.size < 150000) { bmp.close(); return blob; }
    const c = new OffscreenCanvas(Math.max(1, Math.round(bmp.width * k)), Math.max(1, Math.round(bmp.height * k))); c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); bmp.close();
    return await c.convertToBlob({ type: 'image/jpeg', quality: 0.86 });
  } catch { return blob; }
}

export class Library extends EventTarget {
  constructor() {
    super(); this.tracks = []; this.renders = []; this._n = 0; this._seen = new Set(); this._byPath = new Map(); this._q = []; this._busy = 0; this.total = 0; this.done = 0; this._pending = false;
    this._covers = new Map(); this._coverP = new Map(); this.cache = new NullCache(); this.fileCache = new Map(); this._dirty = []; this._flushT = 0;
    this.stats = { read: 0, cached: 0 }; this.concurrency = 6; this.useNfo = true; this.nfoFill = true; this.nfos = new Map(); this._nfoT = 0; this.scope = 'all'; this.ver = 0; this._memo = {}; this.nativeReader = null;
  }
  _changed() { this.ver++; if (this._pending) return; this._pending = true; requestAnimationFrame(() => { this._pending = false; this.dispatchEvent(new Event('change')); }); }
  async attachCache(cache) { this.cache = cache; this.fileCache = await cache.loadFiles(); for (const [k, b] of await cache.loadCovers()) this._covers.set(k, URL.createObjectURL(b)); }
  _remember(rec) { this._dirty.push(rec); this.fileCache.set(rec.path, rec); if (!this._flushT) this._flushT = setTimeout(() => this.flush(), 800); }
  async flush() { clearTimeout(this._flushT); this._flushT = 0; const d = this._dirty; this._dirty = []; if (d.length) try { await this.cache.putFiles(d); } catch { /* cache is best-effort */ } }

  async _coverFrom(c) {
    if (!c || !c.data.length) return { key: null, url: null };
    const key = c.data.length + ':' + Array.from(c.data.subarray(0, 24)).join(','); if (this._covers.has(key)) return { key, url: this._covers.get(key) };
    if (!this._coverP.has(key)) this._coverP.set(key, (async () => { const blob = await thumb(new Blob([c.data], { type: c.mime })), url = URL.createObjectURL(blob); this._covers.set(key, url); this.cache.putCover(key, blob).catch(() => {}); return url; })());
    return { key, url: await this._coverP.get(key) };
  }

  // `libId`: which library these sources belong to. The same file can be in several libraries.
  // Derived lists are memoized per (data version, library scope): big libraries re-render often while tags stream in.
  _memoed(key, build) { const k = this.ver + '|' + this.scope, m = this._memo[key]; if (m && m.k === k) return m.v; const v = build(); this._memo[key] = { k, v }; return v; }
  get visibleTracks() { return this.scope === 'all' ? this.tracks : this._memoed('vt', () => this.tracks.filter(t => t.libs.has(this.scope))); }
  get visibleRenders() { return this.scope === 'all' ? this.renders : this._memoed('vr', () => this.renders.filter(r => r.libs.has(this.scope))); }
  add(sources, libId = 'music') {
    const fresh = [];
    for (const s of sources) { const old = this._byPath.get(s.path); if (!old) { if (!this._seen.has(s.path)) fresh.push(s); } else { if (old.libs) old.libs.add(libId); if (!same(old.src, s)) this._update(old, s); } }
    fresh.forEach(s => this._seen.add(s.path));
    const renderDirs = [];
    for (const m of fresh.filter(s => s.name === 'manifest.json')) {            // a stem render: manifest.json beside a stems/ folder of audio
      const dir = dirOf(m.path), stems = fresh.filter(s => AUDIO_RE.test(s.name) && dirOf(s.path) === dir + '/stems').sort((a, b) => a.name.localeCompare(b.name));
      if (!stems.length) continue; renderDirs.push(dir);
      const r = { id: 'r' + (++this._n), kind: 'render', dir, src: m, title: dir.split('/').pop() || 'Render', artist: '', album: 'Stem renders', stems: stems.map(s => ({ name: stem(s.name), src: s })), clips: null, manifest: null, mix: fresh.find(s => AUDIO_RE.test(s.name) && dirOf(s.path) === dir && /^mix\./i.test(s.name)) || null,
        clipsSrc: fresh.find(s => s.name === 'clips.json' && dirOf(s.path) === dir) || null, libs: new Set([libId]), bpm: undefined, key: '', duration: undefined, sections: [], coverUrl: null };
      this.renders.push(r); this._byPath.set(m.path, r); this._enqueue(() => this._loadRender(r));
    }
    for (const s of fresh) {
      if (NFO_RE.test(s.name)) { const n = { kind: 'nfo', src: s, dir: dirOf(s.path), parsed: null }; this._byPath.set(s.path, n); this._enqueue(() => this._loadNfo(n)); continue; }
      if (!(s.meta || AUDIO_RE.test(s.name)) || renderDirs.some(d => s.path.startsWith(d + '/'))) continue;     // plain tracks: audio that is not part of a render
      const t = { id: 't' + (++this._n), kind: 'track', src: s, title: stem(s.name), artist: '', album: '', year: '', track: 0, disc: 0, genre: '', bpm: undefined, key: '', duration: undefined, coverUrl: null, tagged: false, nfo: null, libs: new Set([libId]) };
      this.tracks.push(t); this._byPath.set(s.path, t);
      const rec = this.fileCache.get(s.path);
      if (s.meta) this._applyRemote(t, s);
      else if (rec && rec.kind === 'track' && same(rec, s)) { this._applyTags(t, rec.data); this.stats.cached++; } else this._enqueue(() => this._loadTags(t));
    }
    this._changed(); return { tracks: this.tracks.length, renders: this.renders.length };
  }
  // Adds many sources without freezing the UI: in slices (never splitting a stem-render folder), yielding between them.
  async addChunked(sources, libId = 'music', { chunk = 1500, onProgress = () => {} } = {}) {
    const dirOf2 = p => p.slice(0, p.lastIndexOf('/')).replace(/\/stems$/, ''); let i = 0;
    while (i < sources.length) {
      let end = Math.min(sources.length, i + chunk); while (end < sources.length && dirOf2(sources[end].path) === dirOf2(sources[end - 1].path)) end++;
      this.add(sources.slice(i, end), libId); i = end; onProgress(i, sources.length); await new Promise(r => setTimeout(r, 0));
    }
    return { tracks: this.tracks.length, renders: this.renders.length };
  }
  _enqueue(job) { if (!this._q.length && !this._busy) { this.total = 0; this.done = 0; } this.total++; this._q.push(job); this._pump(); }
  _pump() {
    const limit = this.nativeReader ? Math.max(this.concurrency, 192) : this.concurrency;      // native reading batches many files per call
    while (this._busy < limit && this._q.length) { const j = this._q.shift(); this._busy++; j().catch(() => {}).finally(() => { this._busy--; this.done++; if (!this._busy && !this._q.length) this.flush(); this._changed(); this._pump(); }); }
  }
  // Items from a source plugin arrive already tagged (nothing to read from a file).
  _applyRemote(t, s) { t._hay = null; const { coverUrl, remote, ...tags } = s.meta; Object.assign(t, { tagged: true, remote: true }, tags); t.coverUrl = coverUrl || null; this._nfoFor(t); }
  _applyTags(t, data) {
    t._hay = null;
    Object.assign(t, { tagged: true }, data.tags); t.track = t.track || 0; t.disc = t.disc || 0; if (!t.title) t.title = stem(t.src.name); t.coverUrl = data.coverKey ? this._covers.get(data.coverKey) || null : null; this._nfoFor(t);
  }
  async _loadTags(t) {
    let g = null; if (this.nativeReader && t.src.kind === 'tauri') g = await this.nativeReader(t.src.path);
    if (!g) g = await readTags(t.src.reader());                                  // web, or a format the native reader can't handle
    const { key, url } = g.cover ? await this._coverFrom(g.cover) : g.coverKey && this._covers.has(g.coverKey) ? { key: g.coverKey, url: this._covers.get(g.coverKey) } : { key: null, url: null };
    const tags = Object.fromEntries(Object.entries(g).filter(([k, v]) => k !== 'cover' && k !== 'coverKey' && v !== undefined));
    const data = { tags, coverKey: key }; this._applyTags(t, data); this.stats.read++; this._remember({ path: t.src.path, size: t.src.size, mtime: t.src.mtime || 0, kind: 'track', data });
  }
  async _loadRender(r) {
    try { r.manifest = JSON.parse(await r.src.text()); } catch { r.manifest = {}; }
    const m = r.manifest; r.title = m.title || m.name || r.title; r.bpm = m.bpm; r.key = m.key_label || m.key || ''; r.duration = m.seconds; r.sections = (m.sections || []).map(s => ({ name: s.name, start: s.start_s ?? s.start, end: s.end_s ?? s.end }));
    if (r.clipsSrc) { try { r.clips = JSON.parse(await r.clipsSrc.text()); } catch { r.clips = null; } }
    if (r.mix) { const g = await readTags(r.mix.reader()); r.coverUrl = (await this._coverFrom(g.cover)).url; if (g.artist) r.artist = g.artist; if (g.title && !m.name) r.title = g.title; if (g.duration && !r.duration) r.duration = g.duration; }
  }

  // ---- .nfo: Kodi-style album.nfo / artist.nfo (or any *.nfo) in a track's folder or above it
  async _loadNfo(n) {
    const rec = this.fileCache.get(n.src.path);
    if (rec && rec.kind === 'nfo' && same(rec, n.src)) n.parsed = rec.data; else { n.parsed = parseNfo(await n.src.text()); this._remember({ path: n.src.path, size: n.src.size, mtime: n.src.mtime || 0, kind: 'nfo', data: n.parsed }); }
    const list = this.nfos.get(n.dir) || []; this.nfos.set(n.dir, [...list.filter(x => x !== n), n]); this._nfoSoon();
  }
  _nfoSoon() { if (this._nfoT) return; this._nfoT = setTimeout(() => { this._nfoT = 0; this.tracks.forEach(t => this._nfoFor(t)); this._changed(); }, 50); }
  _nfoFor(t) {
    t._hay = null;
    if (!this.useNfo || !this.nfos.size) { t.nfo = null; return; }
    const dir = dirOf(t.src.path), here = this.nfos.get(dir) || [], pick = (list, kind) => list.find(x => x.parsed?.kind === kind);
    const album = pick(here, 'album') || null, texts = here.filter(x => x.parsed?.kind === 'text'); let artist = pick(here, 'artist') || null;
    for (let d = dir; !artist; d = dirOf(d)) { artist = pick(this.nfos.get(d) || [], 'artist') || null; if (!d.includes('/')) break; }
    if (!album && !artist && !texts.length) { t.nfo = null; return; }
    t.nfo = { album: album && { ...album.parsed, path: album.src.path }, artist: artist && { ...artist.parsed, path: artist.src.path }, texts: texts.map(x => ({ text: x.parsed.text, path: x.src.path })) };
    if (this.nfoFill) {     // tags win; the NFO only fills what is missing
      const a = t.nfo.album, r = t.nfo.artist;
      const fill = (k, v) => { t[k] = v; (t._nfoFilled ||= new Set()).add(k); };      // remember which fields came from the NFO, so the UI can say so
      if (!t.album && a?.album) fill('album', a.album); if (!t.artist && (a?.artist || r?.artist)) fill('artist', a?.artist || r.artist); if (!t.year && a?.year) fill('year', a.year); if (!t.genre && (a?.genres || r?.genres)?.length) fill('genre', (a?.genres?.length ? a.genres : r.genres).join(', '));
    }
  }
  setNfoOptions({ useNfo, nfoFill }) { this.useNfo = useNfo; this.nfoFill = nfoFill; this._nfoSoon(); }

  // ---- keeping up with the disk
  _update(old, s) {
    old.src = s; if (old.kind === 'track' && s.meta) this._applyRemote(old, s); else if (old.kind === 'track') { old.tagged = false; this._enqueue(() => this._loadTags(old)); } else if (old.kind === 'nfo') this._enqueue(() => this._loadNfo(old)); else if (old.kind === 'render') { old.src = s; this._enqueue(() => this._loadRender(old)); }
  }
  // Drop everything under `root` that a fresh scan no longer finds (deleted/moved files). Returns how many entries went away.
  removeMissing(root, present, libId = 'music') {
    const gone = [], under = p => p.startsWith(root.replace(/\/+$/, '') + '/');
    for (const [p, e] of this._byPath) if (under(p) && !present.has(p)) { if (e.libs && (e.libs.delete(libId), e.libs.size)) continue; gone.push([p, e]); }
    if (!gone.length) return 0; const dead = new Set(gone.map(x => x[1]));
    this.tracks = this.tracks.filter(t => !dead.has(t)); this.renders = this.renders.filter(r => !dead.has(r));
    for (const [p, e] of gone) { this._byPath.delete(p); this._seen.delete(p); this.fileCache.delete(p); if (e.kind === 'nfo') { this.nfos.set(e.dir, (this.nfos.get(e.dir) || []).filter(x => x !== e)); } }
    for (const p of [...this._seen]) if (under(p) && !present.has(p)) this._seen.delete(p);
    this.cache.delFiles(gone.map(x => x[0])).catch(() => {}); this._nfoSoon(); this._changed(); return gone.length;
  }

  sortedTracks() { return this._memoed('sorted', () => this._sort()); }
  _sort() { return this.visibleTracks.slice().sort((a, b) => { const x = sortKey(a), y = sortKey(b); for (let i = 0; i < x.length; i++) { const c = typeof x[i] === 'number' ? x[i] - y[i] : collator.compare(x[i], y[i]); if (c) return c; } return 0; }); }
  search(list, q) { q = q.trim().toLowerCase(); if (!q) return list; if (this._sq && this._sq.list === list && this._sq.q === q) return this._sq.out; const w = q.split(/\s+/), out = list.filter(t => { const h = t._hay ||= [t.title, t.artist, t.album, t.genre, t.src?.name, t.dir].join(' ').toLowerCase(); return w.every(x => h.includes(x)); }); this._sq = { list, q, out }; return out; }
  albums() { return this._memoed('albums', () => this._albums()); }
  _albums() { const m = new Map(); for (const t of this.sortedTracks()) { const k = (t.albumArtist || t.artist || '') + '\u0000' + (t.album || ''); if (!t.album) continue; if (!m.has(k)) m.set(k, { key: k, album: t.album, artist: t.albumArtist || t.artist, coverUrl: t.coverUrl, tracks: [] }); const a = m.get(k); a.tracks.push(t); a.coverUrl ||= t.coverUrl; } return [...m.values()]; }
  // Remove a library's claim on everything; entities no library claims any more go away (their cache entries stay: another library or a re-add may want them).
  dropLibrary(libId) { const dead = new Set(); for (const [p, e] of this._byPath) if (e.libs) { e.libs.delete(libId); if (!e.libs.size) { dead.add(e); this._byPath.delete(p); this._seen.delete(p); } } this.tracks = this.tracks.filter(t => !dead.has(t)); this.renders = this.renders.filter(r => !dead.has(r)); this._changed(); return dead.size; }
  clear() { this.tracks = []; this.renders = []; this._seen.clear(); this._byPath.clear(); this.nfos.clear(); this._changed(); }
}
