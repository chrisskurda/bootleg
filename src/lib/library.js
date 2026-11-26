// The library: plain tracks and stem renders, found in the sources you add. Tags are read in the background,
// remembered in a persistent cache (validated by size + mtime), and .nfo files in the folders add/fill metadata.
import { readTags } from './tags.js';
import { AUDIO_RE, NFO_RE, PKG_RE } from './source.js';
import { openPackage } from './stempkg.js';
import { NullCache } from './cache.js';
import { parseNfo } from './nfo.js';

const dirOf = p => p.slice(0, Math.max(0, p.lastIndexOf('/')));
const stem = n => n.replace(/\.[^.]+$/, '');
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
// Tag edits made in bootleg (stored with the notes, keyed like them — see setEdits) win over what the file or server says,
// in bootleg only. A track's fields are always derived in this order: source tags → .nfo fill → edits.
export const EDIT_FIELDS = ['title', 'artist', 'album', 'albumArtist', 'year', 'track', 'disc', 'genre'];
const pickFields = t => Object.fromEntries(EDIT_FIELDS.map(k => [k, t[k] ?? '']));
const blankFields = t => { for (const k of EDIT_FIELDS) t[k] = k === 'track' || k === 'disc' ? 0 : ''; };
export const sortKey = t => [t.artist || '', t.album || '', t.disc || 0, t.track || 0, t.title || ''];
// Stem sets: files in a library that are the *parts* of one piece of music. They are shown as one item (the piece), never as tracks.
const STEM_WORDS = new Set(['bed', 'drums', 'drum', 'kick', 'snare', 'hats', 'hat', 'perc', 'bass', 'sub', 'lead', 'pad', 'arp', 'keys', 'vox', 'vocals', 'fx', 'riser', 'stab', 'chords', 'clap', 'crash', 'fill', 'drop', 'shaker', 'hoover', 'smpfx', 'other', 'guitar', 'piano', 'melody', 'instrumental', 'accompaniment', 'vocal', 'voice']);   // the last row: stem splitters (Demucs, Spleeter)
const stemWord = name => name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const isStemName = name => { const w = stemWord(name); return STEM_WORDS.has(w) || (typeof window !== 'undefined' && window.VisStems ? window.VisStems.roleOf(name) !== 'other' : false); };
const isMixName = name => /^(mix|master|final|bounce)\.[a-z0-9]+$/i.test(name);
const GENERIC_TITLE = /^(mix|master|final|bounce|render|untitled)$/i;
// A file called "mix.flac" is better named after the folder it lives in.
const titleFromFile = src => { const base = src.name.replace(/\.[^.]+$/, ''); if (!GENERIC_TITLE.test(base)) return base; const parts = src.path.split('/').slice(0, -1).filter(Boolean); return parts.length ? parts[parts.length - 1] : base; };
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
    this.stats = { read: 0, cached: 0 }; this.concurrency = 6; this.useNfo = true; this.nfoFill = true; this.nfos = new Map(); this._nfoT = 0; this.scope = 'all'; this.ver = 0; this._memo = {}; this.nativeReader = null; this.includeRenders = true; this.edits = new Map(); this.editKey = () => null;
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
    const { renderDirs, renderFiles } = this._findRenders(fresh, libId);
    for (const s of fresh) {
      if (NFO_RE.test(s.name)) { const n = { kind: 'nfo', src: s, dir: dirOf(s.path), parsed: null }; this._byPath.set(s.path, n); this._enqueue(() => this._loadNfo(n)); continue; }
      if (!(s.meta || AUDIO_RE.test(s.name)) || renderFiles.has(s.path) || renderDirs.some(d => s.path.startsWith(d + '/'))) continue;     // plain tracks: audio that is not part of a stem set
      const t = { id: 't' + (++this._n), kind: 'track', src: s, title: titleFromFile(s), artist: '', album: '', year: '', track: 0, disc: 0, genre: '', bpm: undefined, key: '', duration: undefined, coverUrl: null, tagged: false, nfo: null, libs: new Set([libId]) };
      this.tracks.push(t); this._byPath.set(s.path, t);
      const rec = this.fileCache.get(s.path);
      if (s.meta) this._applyRemote(t, s);
      else if (rec && rec.kind === 'track' && same(rec, s)) { this._applyTags(t, rec.data); this.stats.cached++; } else this._enqueue(() => this._loadTags(t));
    }
    this._changed(); return { tracks: this.tracks.length, renders: this.renders.length };
  }
  // Finds stem sets among newly-seen files and creates one library item for each:
  //   1. a `stems/` folder of audio (manifest.json / clips.json / mix.* beside it are optional — the manifest only adds detail)
  //   2. a loose set: a folder whose audio files are (mostly) stem-named (kick, bass, pad, bed, …), optionally with manifest/musicset.json and mix.*
  _findRenders(fresh, libId) {
    const idx = new Map(fresh.map(s => [s.path, s])), byDir = new Map(), renderDirs = [], renderFiles = new Set(), claimed = new Set();
    for (const s of fresh) if (AUDIO_RE.test(s.name)) { const d = dirOf(s.path); (byDir.get(d) || byDir.set(d, []).get(d)).push(s); }
    const mixIn = dir => { for (const f of byDir.get(dir) || []) if (isMixName(f.name)) return f; return null; };
    const make = (dir, stems, manifest, clips, mix, loose) => {
      const name = dir.split('/').pop() || 'Render', parent = dir.split('/').slice(-2, -1)[0] || '';
      const cover = ['jpg', 'jpeg', 'png', 'webp'].map(x => idx.get(dir + '/cover.' + x)).find(Boolean) || null;
      const r = { id: 'r' + (++this._n), kind: 'render', dir, src: manifest || stems[0], manifestSrc: manifest || null, coverSrc: cover, loose, title: /^(gm|render|out|output|stems?|mix)$/i.test(name) && parent ? parent : name, artist: '', album: '', year: '', genre: '', track: 0, disc: 0, tagged: true, nfo: null,
        stems: stems.slice().sort((a, b) => a.name.localeCompare(b.name)).map(x => ({ name: stem(x.name), src: x })), clips: null, manifest: null, mix: mix || null, clipsSrc: clips || null, libs: new Set([libId]), bpm: undefined, key: '', duration: undefined, sections: [], coverUrl: null };
      this.renders.push(r); this._byPath.set(r.src.path, r); this._enqueue(() => this._loadRender(r));
      if (loose) { stems.forEach(x => renderFiles.add(x.path)); if (mix) renderFiles.add(mix.path); } else renderDirs.push(dir);
    };
    for (const s of fresh) if (PKG_RE.test(s.name) && s.reader) {                       // 0. .bstem / .bsong packages: one song each (opened in _loadRender)
      const r = { id: 'r' + (++this._n), kind: 'render', dir: s.path, src: s, pkgSrc: s, manifestSrc: null, coverSrc: null, loose: false, title: s.name.replace(PKG_RE, ''), artist: '', album: '', year: '', genre: '', track: 0, disc: 0, tagged: true, nfo: null,
        stems: [], clips: null, manifest: null, mix: null, clipsSrc: null, libs: new Set([libId]), bpm: undefined, key: '', duration: undefined, sections: [], coverUrl: null, project: /\.bsong$/i.test(s.name) };
      this.renders.push(r); this._byPath.set(s.path, r); this._enqueue(() => this._loadRender(r)); renderFiles.add(s.path);
    }
    for (const [d, files] of byDir) {                                                    // 1. stems/ folders
      if (!d.endsWith('/stems')) continue; const dir = d.slice(0, -6), manifest = idx.get(dir + '/manifest.json');
      if (files.length >= 2 || manifest) { make(dir, files, manifest, idx.get(dir + '/clips.json'), mixIn(dir), false); claimed.add(d); claimed.add(dir); }
    }
    for (const [d, files] of byDir) {                                                    // 2. loose stem sets
      if (claimed.has(d)) continue; const parts = files.filter(f => !isMixName(f.name)), named = parts.filter(f => isStemName(f.name)), meta = idx.get(d + '/musicset.json') || idx.get(d + '/manifest.json');
      if (named.length >= (meta ? 2 : 3) && named.length >= parts.length * 0.6) { make(d, named, meta && meta.name !== 'manifest.json' ? null : meta, idx.get(d + '/clips.json'), mixIn(d), true); claimed.add(d); }
    }
    return { renderDirs, renderFiles };
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
  _applyRemote(t, s) { t._hay = null; const { coverUrl, remote, ...tags } = s.meta; blankFields(t); Object.assign(t, { tagged: true, remote: true }, tags); t.coverUrl = coverUrl || null; t._src = pickFields(t); this._nfoFor(t); }
  _applyTags(t, data) {
    t._hay = null;
    blankFields(t); Object.assign(t, { tagged: true }, data.tags); t.track = t.track || 0; t.disc = t.disc || 0; if (!t.title) t.title = titleFromFile(t.src); t.coverUrl = data.coverKey ? this._covers.get(data.coverKey) || null : null; t._src = pickFields(t); this._nfoFor(t);
  }
  async _tagsOf(src) {
    let g = null; if (this.nativeReader && src.kind === 'tauri') g = await this.nativeReader(src.path);
    return g || await readTags(src.reader());                                    // web, or a format the native reader can't handle
  }
  async _loadTags(t) {
    const g = await this._tagsOf(t.src);
    const { key, url } = g.cover ? await this._coverFrom(g.cover) : g.coverKey && this._covers.has(g.coverKey) ? { key: g.coverKey, url: this._covers.get(g.coverKey) } : { key: null, url: null };
    const tags = Object.fromEntries(Object.entries(g).filter(([k, v]) => k !== 'cover' && k !== 'coverKey' && v !== undefined));
    const data = { tags, coverKey: key }; this._applyTags(t, data); this.stats.read++; this._remember({ path: t.src.path, size: t.src.size, mtime: t.src.mtime || 0, kind: 'track', data });
  }
  // Light metadata only (manifest + the mix's tags), cached like a track's tags. The heavy parts — clips.json and the stems'
  // audio — are loaded when the render is played (see loadClips and the player).
  async _loadRender(r) {
    if (r.pkgSrc && !r.pkg) {                                                    // a package: its directory is read every time (cheap: the end of the file), so its parts can play
      try {
        const p = r.pkg = await openPackage(r.pkgSrc); r.mix = p.mix ? p.sourceFor(p.mix) : null; r.stems = p.stems.map(x => ({ name: p.names[x] || stem(x.split('/').pop()), src: p.sourceFor(x) }));
        r.clipsSrc = p.clips ? p.sourceFor(p.clips) : null; r.coverSrc = p.cover ? p.sourceFor(p.cover) : null; r.manifestSrc = { text: async () => JSON.stringify(p.manifest) }; r.songId = p.manifest.id || null;
        if (r.coverSrc) r.coverUrl = await r.coverSrc.urlAsync();
      } catch (e) { r.broken = String(e.message || e); }
      this._changed();
    }
    const rec = this.fileCache.get(r.src.path);
    if (rec && rec.kind === 'render' && same(rec, r.src)) { Object.assign(r, rec.data.meta); r.manifest = rec.data.manifest || {}; r.coverUrl = rec.data.coverKey ? this._covers.get(rec.data.coverKey) || null : r.coverUrl || (r.coverSrc ? r.coverSrc.url() : null); this.stats.cached++; return; }
    try { r.manifest = r.manifestSrc ? JSON.parse(await r.manifestSrc.text()) : {}; } catch { r.manifest = {}; }
    const m = r.manifest; r.bpm = m.bpm; r.key = m.key_label || m.key || ''; r.duration = m.seconds; r.sections = (m.sections || []).map(x => ({ name: x.name, start: x.start_s ?? x.start, end: x.end_s ?? x.end })); if (m.title || m.name) r.title = m.title || m.name;
    let coverKey = null;
    if (r.mix && r.mix.reader) { try { const g = await this._tagsOf(r.mix); const c = g.cover ? await this._coverFrom(g.cover) : g.coverKey && this._covers.has(g.coverKey) ? { key: g.coverKey, url: this._covers.get(g.coverKey) } : { key: null, url: null }; r.coverUrl = c.url; coverKey = c.key;
      if (g.title) r.title = g.title; if (g.artist) r.artist = g.artist; if (g.album) r.album = g.album; if (g.year) r.year = g.year; if (g.genre) r.genre = g.genre; if (g.duration && !r.duration) r.duration = g.duration; } catch { /* a mix without readable tags is fine */ } }
    if (!r.coverUrl && r.coverSrc) r.coverUrl = r.coverSrc.urlAsync ? await r.coverSrc.urlAsync() : r.coverSrc.url();          // a song's own picture (packages and stem server songs carry cover.*)
    if (m.artist && !r.artist) r.artist = m.artist; if (m.album && !r.album) r.album = m.album;
    this._remember({ path: r.src.path, size: r.src.size, mtime: r.src.mtime || 0, kind: 'render', data: { meta: { title: r.title, artist: r.artist, album: r.album, year: r.year, genre: r.genre, bpm: r.bpm, key: r.key, duration: r.duration, sections: r.sections, ...(r.coverSrc && !coverKey && !r.pkgSrc ? { coverUrl: r.coverUrl } : {}) }, manifest: r.manifest, coverKey } });
  }
  async loadClips(r) { if (r.clips || !r.clipsSrc) return r.clips; try { r.clips = JSON.parse(await r.clipsSrc.text()); } catch { r.clips = null; } return r.clips; }

  // ---- .nfo: Kodi-style album.nfo / artist.nfo (or any *.nfo) in a track's folder or above it
  async _loadNfo(n) {
    const rec = this.fileCache.get(n.src.path);
    if (rec && rec.kind === 'nfo' && same(rec, n.src)) n.parsed = rec.data; else { n.parsed = parseNfo(await n.src.text()); this._remember({ path: n.src.path, size: n.src.size, mtime: n.src.mtime || 0, kind: 'nfo', data: n.parsed }); }
    const list = this.nfos.get(n.dir) || []; this.nfos.set(n.dir, [...list.filter(x => x !== n), n]); this._nfoSoon();
  }
  _nfoSoon() { if (this._nfoT) return; this._nfoT = setTimeout(() => { this._nfoT = 0; this.tracks.forEach(t => this._nfoFor(t)); this._changed(); }, 50); }
  _nfoFor(t) { if (t._src) { Object.assign(t, t._src); t._nfoFilled = null; } this._nfoFill(t); this._applyEdits(t); }
  // t.orig: what the source (+ .nfo) says, kept only for edited tracks — the editor shows it, and a future tag writer diffs against it
  _applyEdits(t) { const e = t.kind === 'track' && this.edits.get(this.editKey(t)); if (!e) { t.orig = null; t.edited = null; return; } t.orig = pickFields(t); Object.assign(t, e); t.edited = new Set(Object.keys(e)); t._hay = null; }
  // edits: Map(notes key → { field: value }). setEdit(key, null) removes a track's edits.
  setEdits(map) { const keys = new Set([...this.edits.keys(), ...map.keys()]); this.edits = new Map(map); this._reEdit(keys); }
  setEdit(key, e) { const had = this.edits.has(key); if (e && Object.keys(e).length) this.edits.set(key, e); else if (had) this.edits.delete(key); else return; this._reEdit(new Set([key])); }
  _reEdit(keys) { let n = 0; for (const k of keys) { const m = /^file:(.*)#\d*$/.exec(k), t = m && this._byPath.get(m[1]); if (t?.kind === 'track' && t._src) { this._nfoFor(t); n++; } } if (n) this._changed(); }
  _nfoFill(t) {
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
  // tracks and stem sets together: this is what the lists show (a stem set is one item; its parts never appear)
  get visibleItems() { return this.includeRenders ? this._memoed('items', () => [...this.visibleTracks, ...this.visibleRenders]) : this.visibleTracks; }
  _sort() { return this.visibleItems.slice().sort((a, b) => { const x = sortKey(a), y = sortKey(b); for (let i = 0; i < x.length; i++) { const c = typeof x[i] === 'number' ? x[i] - y[i] : collator.compare(x[i], y[i]); if (c) return c; } return 0; }); }
  search(list, q) { q = q.trim().toLowerCase(); if (!q) return list; if (this._sq && this._sq.list === list && this._sq.q === q) return this._sq.out; const w = q.split(/\s+/), out = list.filter(t => { const h = t._hay ||= [t.title, t.artist, t.album, t.genre, t.kind === 'render' ? t.dir : t.src?.name, t.dir, t.kind === 'render' ? 'stems' : ''].join(' ').toLowerCase(); return w.every(x => h.includes(x)); }); this._sq = { list, q, out }; return out; }
  albums() { return this._memoed('albums', () => this._albums()); }
  _albums() { const m = new Map(); for (const t of this.sortedTracks()) { const k = (t.albumArtist || t.artist || '') + '\u0000' + (t.album || ''); if (!t.album) continue; if (!m.has(k)) m.set(k, { key: k, album: t.album, artist: t.albumArtist || t.artist, coverUrl: t.coverUrl, tracks: [] }); const a = m.get(k); a.tracks.push(t); a.coverUrl ||= t.coverUrl; } return [...m.values()]; }
  // Remove a library's claim on everything; entities no library claims any more go away (their cache entries stay: another library or a re-add may want them).
  dropLibrary(libId) { const dead = new Set(); for (const [p, e] of this._byPath) if (e.libs) { e.libs.delete(libId); if (!e.libs.size) { dead.add(e); this._byPath.delete(p); this._seen.delete(p); } } this.tracks = this.tracks.filter(t => !dead.has(t)); this.renders = this.renders.filter(r => !dead.has(r)); this._changed(); return dead.size; }
  clear() { this.tracks = []; this.renders = []; this._seen.clear(); this._byPath.clear(); this.nfos.clear(); this._changed(); }
}
