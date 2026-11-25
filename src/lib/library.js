// The library: plain tracks and stem renders, found in the sources you add. Tags are read in the background.
import { readTags } from './tags.js';
import { AUDIO_RE } from './source.js';

const dirOf = p => p.slice(0, Math.max(0, p.lastIndexOf('/')));
const stem = n => n.replace(/\.[^.]+$/, '');
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export const sortKey = t => [t.artist || '', t.album || '', t.disc || 0, t.track || 0, t.title || ''];

export class Library extends EventTarget {
  constructor() { super(); this.tracks = []; this.renders = []; this._n = 0; this._seen = new Set(); this._q = []; this._busy = 0; this._covers = new Map(); this._pending = false; }
  _changed() { if (this._pending) return; this._pending = true; requestAnimationFrame(() => { this._pending = false; this.dispatchEvent(new Event('change')); }); }
  _cover(c) { if (!c || !c.data.length) return null; const k = c.data.length + ':' + Array.from(c.data.subarray(0, 24)).join(','); let u = this._covers.get(k); if (!u) { u = URL.createObjectURL(new Blob([c.data], { type: c.mime })); this._covers.set(k, u); } return u; }

  async add(sources) {
    const fresh = sources.filter(s => !this._seen.has(s.path)); fresh.forEach(s => this._seen.add(s.path));
    const renderDirs = [];
    for (const m of fresh.filter(s => s.name === 'manifest.json')) {            // a stem render: manifest.json beside a stems/ folder of audio
      const dir = dirOf(m.path), stems = fresh.filter(s => AUDIO_RE.test(s.name) && dirOf(s.path) === dir + '/stems').sort((a, b) => a.name.localeCompare(b.name));
      if (!stems.length) continue; renderDirs.push(dir);
      const r = { id: 'r' + (++this._n), kind: 'render', dir, src: m, title: dir.split('/').pop() || 'Render', artist: '', album: 'Stem renders', stems: stems.map(s => ({ name: stem(s.name), src: s })), clips: null, manifest: null, mix: fresh.find(s => AUDIO_RE.test(s.name) && dirOf(s.path) === dir && /^mix\./i.test(s.name)) || null,
        clipsSrc: fresh.find(s => s.name === 'clips.json' && dirOf(s.path) === dir) || null, bpm: undefined, key: '', duration: undefined, sections: [], coverUrl: null };
      this.renders.push(r); this._enqueue(() => this._loadRender(r));
    }
    for (const s of fresh) {                                                      // plain tracks: audio that is not part of a render
      if (!AUDIO_RE.test(s.name) || renderDirs.some(d => s.path.startsWith(d + '/'))) continue;
      const t = { id: 't' + (++this._n), kind: 'track', src: s, title: stem(s.name), artist: '', album: '', year: '', track: 0, disc: 0, genre: '', bpm: undefined, key: '', duration: undefined, coverUrl: null, tagged: false };
      this.tracks.push(t); this._enqueue(() => this._loadTags(t));
    }
    this._changed(); return { tracks: this.tracks.length, renders: this.renders.length };
  }
  _enqueue(job) { this._q.push(job); this._pump(); }
  _pump() { while (this._busy < 6 && this._q.length) { const j = this._q.shift(); this._busy++; j().catch(() => {}).finally(() => { this._busy--; this._changed(); this._pump(); }); } }
  async _loadTags(t) {
    const g = await readTags(t.src.reader()); Object.assign(t, { tagged: true }, Object.fromEntries(Object.entries(g).filter(([k, v]) => k !== 'cover' && v !== undefined)));
    t.track = t.track || 0; t.disc = t.disc || 0; if (!t.title) t.title = stem(t.src.name); t.coverUrl = this._cover(g.cover);
  }
  async _loadRender(r) {
    try { r.manifest = JSON.parse(await r.src.text()); } catch { r.manifest = {}; }
    const m = r.manifest; r.title = m.title || m.name || r.title; r.bpm = m.bpm; r.key = m.key_label || m.key || ''; r.duration = m.seconds; r.sections = (m.sections || []).map(s => ({ name: s.name, start: s.start_s ?? s.start, end: s.end_s ?? s.end }));
    if (r.clipsSrc) { try { r.clips = JSON.parse(await r.clipsSrc.text()); } catch { r.clips = null; } }
    if (r.mix) { const g = await readTags(r.mix.reader()); r.coverUrl = this._cover(g.cover); if (g.artist) r.artist = g.artist; if (g.title && !m.name) r.title = g.title; if (g.duration && !r.duration) r.duration = g.duration; }
  }

  sortedTracks() { return this.tracks.slice().sort((a, b) => { const x = sortKey(a), y = sortKey(b); for (let i = 0; i < x.length; i++) { const c = typeof x[i] === 'number' ? x[i] - y[i] : collator.compare(x[i], y[i]); if (c) return c; } return 0; }); }
  search(list, q) { q = q.trim().toLowerCase(); if (!q) return list; const w = q.split(/\s+/); return list.filter(t => { const h = [t.title, t.artist, t.album, t.genre, t.src?.name, t.dir].join(' ').toLowerCase(); return w.every(x => h.includes(x)); }); }
  albums() { const m = new Map(); for (const t of this.sortedTracks()) { const k = (t.albumArtist || t.artist || '') + '\u0000' + (t.album || ''); if (!t.album) continue; if (!m.has(k)) m.set(k, { key: k, album: t.album, artist: t.albumArtist || t.artist, coverUrl: t.coverUrl, tracks: [] }); const a = m.get(k); a.tracks.push(t); a.coverUrl ||= t.coverUrl; } return [...m.values()]; }
  clear() { this.tracks = []; this.renders = []; this._seen.clear(); this._changed(); }
}
