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
    this.stats = { read: 0, cached: 0 }; this.concurrency = 6; this.useNfo = true; this.nfoFill = true; this.nfos = new Map(); this._nfoT = 0;
  }
  _changed() { if (this._pending) return; this._pending = true; requestAnimationFrame(() => { this._pending = false; this.dispatchEvent(new Event('change')); }); }
  async attachCache(cache) { this.cache = cache; this.fileCache = await cache.loadFiles(); for (const [k, b] of await cache.loadCovers()) this._covers.set(k, URL.createObjectURL(b)); }
  _remember(rec) { this._dirty.push(rec); this.fileCache.set(rec.path, rec); if (!this._flushT) this._flushT = setTimeout(() => this.flush(), 800); }
  async flush() { clearTimeout(this._flushT); this._flushT = 0; const d = this._dirty; this._dirty = []; if (d.length) try { await this.cache.putFiles(d); } catch { /* cache is best-effort */ } }

  async _coverFrom(c) {
    if (!c || !c.data.length) return { key: null, url: null };
    const key = c.data.length + ':' + Array.from(c.data.subarray(0, 24)).join(','); if (this._covers.has(key)) return { key, url: this._covers.get(key) };
    if (!this._coverP.has(key)) this._coverP.set(key, (async () => { const blob = await thumb(new Blob([c.data], { type: c.mime })), url = URL.createObjectURL(blob); this._covers.set(key, url); this.cache.putCover(key, blob).catch(() => {}); return url; })());
    return { key, url: await this._coverP.get(key) };
  }

  add(sources) {
    const fresh = [];
    for (const s of sources) { const old = this._byPath.get(s.path); if (!old) { if (!this._seen.has(s.path)) fresh.push(s); } else if (!same(old.src, s)) this._update(old, s); }
    fresh.forEach(s => this._seen.add(s.path));
    const renderDirs = [];
    for (const m of fresh.filter(s => s.name === 'manifest.json')) {            // a stem render: manifest.json beside a stems/ folder of audio
      const dir = dirOf(m.path), stems = fresh.filter(s => AUDIO_RE.test(s.name) && dirOf(s.path) === dir + '/stems').sort((a, b) => a.name.localeCompare(b.name));
      if (!stems.length) continue; renderDirs.push(dir);
      const r = { id: 'r' + (++this._n), kind: 'render', dir, src: m, title: dir.split('/').pop() || 'Render', artist: '', album: 'Stem renders', stems: stems.map(s => ({ name: stem(s.name), src: s })), clips: null, manifest: null, mix: fresh.find(s => AUDIO_RE.test(s.name) && dirOf(s.path) === dir && /^mix\./i.test(s.name)) || null,
        clipsSrc: fresh.find(s => s.name === 'clips.json' && dirOf(s.path) === dir) || null, bpm: undefined, key: '', duration: undefined, sections: [], coverUrl: null };
      this.renders.push(r); this._byPath.set(m.path, r); this._enqueue(() => this._loadRender(r));
    }
    for (const s of fresh) {
      if (NFO_RE.test(s.name)) { const n = { kind: 'nfo', src: s, dir: dirOf(s.path), parsed: null }; this._byPath.set(s.path, n); this._enqueue(() => this._loadNfo(n)); continue; }
      if (!AUDIO_RE.test(s.name) || renderDirs.some(d => s.path.startsWith(d + '/'))) continue;     // plain tracks: audio that is not part of a render
      const t = { id: 't' + (++this._n), kind: 'track', src: s, title: stem(s.name), artist: '', album: '', year: '', track: 0, disc: 0, genre: '', bpm: undefined, key: '', duration: undefined, coverUrl: null, tagged: false, nfo: null };
      this.tracks.push(t); this._byPath.set(s.path, t);
      const rec = this.fileCache.get(s.path);
      if (rec && rec.kind === 'track' && same(rec, s)) { this._applyTags(t, rec.data); this.stats.cached++; } else this._enqueue(() => this._loadTags(t));
    }
    this._changed(); return { tracks: this.tracks.length, renders: this.renders.length };
  }
  _enqueue(job) { if (!this._q.length && !this._busy) { this.total = 0; this.done = 0; } this.total++; this._q.push(job); this._pump(); }
  _pump() {
    while (this._busy < this.concurrency && this._q.length) { const j = this._q.shift(); this._busy++; j().catch(() => {}).finally(() => { this._busy--; this.done++; if (!this._busy && !this._q.length) this.flush(); this._changed(); this._pump(); }); }
  }
  _applyTags(t, data) {
    Object.assign(t, { tagged: true }, data.tags); t.track = t.track || 0; t.disc = t.disc || 0; if (!t.title) t.title = stem(t.src.name); t.coverUrl = data.coverKey ? this._covers.get(data.coverKey) || null : null; this._nfoFor(t);
  }
  async _loadTags(t) {
    const g = await readTags(t.src.reader()), { key, url } = await this._coverFrom(g.cover), tags = Object.fromEntries(Object.entries(g).filter(([k, v]) => k !== 'cover' && v !== undefined));
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
    if (!this.useNfo || !this.nfos.size) { t.nfo = null; return; }
    const dir = dirOf(t.src.path), here = this.nfos.get(dir) || [], pick = (list, kind) => list.find(x => x.parsed?.kind === kind);
    const album = pick(here, 'album') || null, texts = here.filter(x => x.parsed?.kind === 'text'); let artist = pick(here, 'artist') || null;
    for (let d = dir; !artist; d = dirOf(d)) { artist = pick(this.nfos.get(d) || [], 'artist') || null; if (!d.includes('/')) break; }
    if (!album && !artist && !texts.length) { t.nfo = null; return; }
    t.nfo = { album: album && { ...album.parsed, path: album.src.path }, artist: artist && { ...artist.parsed, path: artist.src.path }, texts: texts.map(x => ({ text: x.parsed.text, path: x.src.path })) };
    if (this.nfoFill) {     // tags win; the NFO only fills what is missing
      const a = t.nfo.album, r = t.nfo.artist;
      if (!t.album && a?.album) t.album = a.album; if (!t.artist && (a?.artist || r?.artist)) t.artist = a?.artist || r.artist; if (!t.year && a?.year) t.year = a.year; if (!t.genre && (a?.genres || r?.genres)?.length) t.genre = (a?.genres?.length ? a.genres : r.genres).join(', ');
    }
  }
  setNfoOptions({ useNfo, nfoFill }) { this.useNfo = useNfo; this.nfoFill = nfoFill; this._nfoSoon(); }

  // ---- keeping up with the disk
  _update(old, s) {
    old.src = s; if (old.kind === 'track') { old.tagged = false; this._enqueue(() => this._loadTags(old)); } else if (old.kind === 'nfo') this._enqueue(() => this._loadNfo(old)); else if (old.kind === 'render') { old.src = s; this._enqueue(() => this._loadRender(old)); }
  }
  // Drop everything under `root` that a fresh scan no longer finds (deleted/moved files). Returns how many entries went away.
  removeMissing(root, present) {
    const gone = [], under = p => p.startsWith(root.replace(/\/+$/, '') + '/');
    for (const [p, e] of this._byPath) if (under(p) && !present.has(p)) gone.push([p, e]);
    if (!gone.length) return 0; const dead = new Set(gone.map(x => x[1]));
    this.tracks = this.tracks.filter(t => !dead.has(t)); this.renders = this.renders.filter(r => !dead.has(r));
    for (const [p, e] of gone) { this._byPath.delete(p); this._seen.delete(p); this.fileCache.delete(p); if (e.kind === 'nfo') { this.nfos.set(e.dir, (this.nfos.get(e.dir) || []).filter(x => x !== e)); } }
    for (const p of [...this._seen]) if (under(p) && !present.has(p)) this._seen.delete(p);
    this.cache.delFiles(gone.map(x => x[0])).catch(() => {}); this._nfoSoon(); this._changed(); return gone.length;
  }

  sortedTracks() { return this.tracks.slice().sort((a, b) => { const x = sortKey(a), y = sortKey(b); for (let i = 0; i < x.length; i++) { const c = typeof x[i] === 'number' ? x[i] - y[i] : collator.compare(x[i], y[i]); if (c) return c; } return 0; }); }
  search(list, q) { q = q.trim().toLowerCase(); if (!q) return list; const w = q.split(/\s+/); return list.filter(t => { const h = [t.title, t.artist, t.album, t.genre, t.src?.name, t.dir].join(' ').toLowerCase(); return w.every(x => h.includes(x)); }); }
  albums() { const m = new Map(); for (const t of this.sortedTracks()) { const k = (t.albumArtist || t.artist || '') + '\u0000' + (t.album || ''); if (!t.album) continue; if (!m.has(k)) m.set(k, { key: k, album: t.album, artist: t.albumArtist || t.artist, coverUrl: t.coverUrl, tracks: [] }); const a = m.get(k); a.tracks.push(t); a.coverUrl ||= t.coverUrl; } return [...m.values()]; }
  clear() { this.tracks = []; this.renders = []; this._seen.clear(); this._byPath.clear(); this.nfos.clear(); this._changed(); }
}
