// Annotations: ratings, free-form notes, timeline notes, provenance ("how did I get this recording").
// Source-agnostic: records key off a track key (`sourceKind:id`, plus an optional content fingerprint so
// notes survive file moves and re-imports from other sources). Backends: memory (tests) or IndexedDB.
// Everything round-trips through plain JSON ("bootleg-notes" v1) so a big library can be exported/imported/merged.

export const PROVENANCE_KINDS = ['vinyl-rip', 'cd-rip', 'mix-cd-rip', 'live-recording', 'digital-purchase', 'streaming', 'stem-render', 'other'];
export const NOTES_FORMAT = 'bootleg-notes', NOTES_VERSION = 1;
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export class MemoryBackend { constructor() { this.m = new Map(); } async get(k) { return this.m.get(k); } async put(k, v) { this.m.set(k, v); } async del(k) { this.m.delete(k); } async all() { return [...this.m.entries()].map(([key, value]) => ({ key, value })); } }
export class IdbBackend {
  constructor(name = 'bootleg-notes') { this.p = new Promise((ok, no) => { const r = indexedDB.open(name, 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); }); }
  async _s(mode) { return (await this.p).transaction('kv', mode).objectStore('kv'); }
  _r(req) { return new Promise((ok, no) => { req.onsuccess = () => ok(req.result); req.onerror = () => no(req.error); }); }
  async get(k) { return this._r((await this._s('readonly')).get(k)); } async put(k, v) { return this._r((await this._s('readwrite')).put(v, k)); } async del(k) { return this._r((await this._s('readwrite')).delete(k)); }
  async all() { const s = await this._s('readonly'), keys = await this._r(s.getAllKeys()), vals = await this._r(s.getAll()); return keys.map((key, i) => ({ key, value: vals[i] })); }
}

const blank = key => ({ key, rating: 0, tags: [], notes: [], provenance: null, fingerprint: null, updated: 0 });
export class NotesStore extends EventTarget {
  constructor(backend = new MemoryBackend()) { super(); this.b = backend; }
  async get(key) { return (await this.b.get('t:' + key)) || blank(key); }
  // read-modify-write ops run one at a time, so two quick edits (e.g. a select then a text field) never overwrite each other
  _q = Promise.resolve(); _lock(fn) { const run = this._q.then(fn, fn); this._q = run.catch(() => {}); return run; }
  async _save(rec) { rec.updated = Date.now(); await this.b.put('t:' + rec.key, rec); this.dispatchEvent(new CustomEvent('change', { detail: rec.key })); return rec; }
  async setRating(key, n) { const r = await this.get(key); r.rating = Math.max(0, Math.min(5, Math.round(n * 2) / 2)); return this._save(r); }   // half stars
  async setTags(key, tags) { const r = await this.get(key); r.tags = [...new Set(tags.map(s => s.trim()).filter(Boolean))]; return this._save(r); }
  async _setProv(key, p) { const r = await this.get(key); r.provenance = p && { kind: PROVENANCE_KINDS.includes(p.kind) ? p.kind : 'other', date: p.date || '', device: p.device || '', venue: p.venue || '', source: p.source || '', note: p.note || '' }; return this._save(r); }
  async patchProvenance(key, patch) { const r = await this.get(key); return this._setProv(key, { ...(r.provenance || { kind: 'other' }), ...patch }); }
  setProvenance(key, p) { return this._setProv(key, p); }   // merges against what is stored, not a stale view
  async setFingerprint(key, fp) { const r = await this.get(key); r.fingerprint = fp; return this._save(r); }
  // A note with `at` (seconds) lives on the timeline; with `to` it covers a range; without either it is a note on the whole recording.
  async addNote(key, { text, at = null, to = null, kind = 'note' }) { const r = await this.get(key), n = { id: uid(), text, at, to, kind, created: Date.now() }; r.notes.push(n); await this._save(r); return n; }
  async editNote(key, id, patch) { const r = await this.get(key), n = r.notes.find(x => x.id === id); if (n) Object.assign(n, patch, { id }); return this._save(r); }
  async removeNote(key, id) { const r = await this.get(key); r.notes = r.notes.filter(x => x.id !== id); return this._save(r); }
  async timeline(key) { return (await this.get(key)).notes.filter(n => n.at != null).sort((a, b) => a.at - b.at); }
  async find({ minRating = 0, tag, text } = {}) { const q = text?.toLowerCase(); return (await this.b.all()).map(x => x.value).filter(r => r.rating >= minRating && (!tag || r.tags.includes(tag)) && (!q || r.notes.some(n => n.text.toLowerCase().includes(q)) || (r.provenance && JSON.stringify(r.provenance).toLowerCase().includes(q)))); }

  async export() { const recs = (await this.b.all()).filter(x => x.key.startsWith('t:')).map(x => x.value).filter(r => r.rating || r.tags.length || r.notes.length || r.provenance); const pl = (await this.b.all()).filter(x => x.key.startsWith('p:')).map(x => x.value); return { format: NOTES_FORMAT, version: NOTES_VERSION, exported: new Date().toISOString(), tracks: recs, playlists: pl }; }
  // Merge: newer record wins per track; notes are unioned by id so two devices don't lose each other's work.
  async import(doc) {
    if (!doc || doc.format !== NOTES_FORMAT) throw new Error('not a bootleg notes file'); if (doc.version > NOTES_VERSION) throw new Error('notes file is from a newer bootleg');
    let added = 0, merged = 0;
    for (const inc of doc.tracks || []) { const cur = await this.b.get('t:' + inc.key); if (!cur) { await this.b.put('t:' + inc.key, { ...blank(inc.key), ...inc }); added++; continue; } const ids = new Set(cur.notes.map(n => n.id)), newer = inc.updated > cur.updated, out = newer ? { ...cur, ...inc } : cur; out.notes = [...cur.notes, ...inc.notes.filter(n => !ids.has(n.id))]; out.tags = [...new Set([...cur.tags, ...inc.tags])]; await this.b.put('t:' + inc.key, out); merged++; }
    for (const p of doc.playlists || []) await this.b.put('p:' + p.id, p);
    this.dispatchEvent(new CustomEvent('change', { detail: '*' })); return { added, merged, playlists: (doc.playlists || []).length };
  }

  // ---- playlists: entries are track keys + a human line so a list survives a missing library (resolved by key, then fingerprint, then "artist - title")
  async savePlaylist({ id = uid(), name, items }) { const p = { id, name, items, updated: Date.now() }; await this.b.put('p:' + id, p); this.dispatchEvent(new CustomEvent('change', { detail: 'playlist' })); return p; }
  async playlists() { return (await this.b.all()).filter(x => x.key.startsWith('p:')).map(x => x.value).sort((a, b) => a.name.localeCompare(b.name)); }
  async deletePlaylist(id) { await this.b.del('p:' + id); }
}

for (const n of ['setRating', 'setTags', 'setProvenance', 'patchProvenance', 'setFingerprint', 'addNote', 'editNote', 'removeNote']) { const f = NotesStore.prototype[n]; NotesStore.prototype[n] = function (...a) { return this._lock(() => f.apply(this, a)); }; }

// ---- M3U / M3U8 (the interchange format every other player speaks)
export function toM3U(name, tracks, { relativeTo = '' } = {}) {
  const out = ['#EXTM3U', `#PLAYLIST:${name}`];
  for (const t of tracks) { out.push(`#EXTINF:${Math.round(t.duration || -1)},${[t.artist, t.title].filter(Boolean).join(' - ') || t.name || ''}`); if (t.artist) out.push(`#EXTART:${t.artist}`); if (t.album) out.push(`#EXTALB:${t.album}`); let p = t.path || t.url || t.name || ''; if (relativeTo && p.startsWith(relativeTo)) p = p.slice(relativeTo.length).replace(/^\/+/, ''); out.push(p); }
  return out.join('\n') + '\n';
}
export function parseM3U(text) {
  const items = []; let name = '', cur = {};
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) { const l = raw.trim(); if (!l) continue;
    if (l.startsWith('#PLAYLIST:')) name = l.slice(10); else if (l.startsWith('#EXTINF:')) { const m = /^#EXTINF:(-?\d+)\s*,?\s*(.*)$/.exec(l); if (m) { cur.duration = +m[1] > 0 ? +m[1] : 0; const parts = m[2].split(' - '); if (parts.length > 1) { cur.artist = parts.shift(); cur.title = parts.join(' - '); } else cur.title = m[2]; } }
    else if (l.startsWith('#EXTART:')) cur.artist = l.slice(8); else if (l.startsWith('#EXTALB:')) cur.album = l.slice(8); else if (l.startsWith('#')) continue;
    else { items.push({ ...cur, path: l }); cur = {}; } }
  return { name, items };
}
// Resolve imported entries against the library: exact path/name, then artist+title, then title.
export function matchEntries(items, tracks) {
  const norm = s => (s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim(), base = p => norm((p || '').split(/[\\/]/).pop().replace(/\.[a-z0-9]+$/i, ''));
  const byName = new Map(), byAT = new Map(), byT = new Map(); for (const t of tracks) { byName.set(base(t.src?.name || t.name), t); byAT.set(norm(t.artist) + '|' + norm(t.title), t); if (!byT.has(norm(t.title))) byT.set(norm(t.title), t); }
  return items.map(it => ({ item: it, track: byName.get(base(it.path)) || byAT.get(norm(it.artist) + '|' + norm(it.title)) || byT.get(norm(it.title)) || null }));
}
