// The offline store's rules and planning: what to keep on this computer, in what order, at what quality, and what to
// let go when space runs out. No Tauri and no DOM here (tested in Node); offline-ui.js runs it against the Rust store
// (src-tauri/src/offline.rs) and device sync uses it to get server tracks onto cards.
//
// Settings (localStorage `offline`):
//   { on, dir, maxGB, quality: 'original'|'high'|'saver', stems, rules: [Rule…], auto, autoGB, cardFetch: 'keep'|'temp' }
// Rule (in priority order: when space runs out, the last rules lose first):
//   { type: 'playlist', id, name } · { type: 'album', key, name } · { type: 'track', key, name }
//   · { type: 'rating', min } · { type: 'starred' }
// What can be kept: server tracks whose plugin allows it (`offline: true`, src/lib/sources/plugin.js) and local files
// (a library folder on a NAS share: the copy plays when the share isn't there).

export const QUALITIES = {
  original: 'Original (the file as it is)',
  high: 'High: MP3 320 (the server converts)',
  saver: 'Space saver: MP3 128 (the server converts)',
};
export const OFFLINE_DEFAULTS = { on: true, dir: '', maxGB: 20, quality: 'original', stems: false, rules: [], auto: false, autoGB: 5, cardFetch: 'keep' };
const PREFER = ['original', 'high', 'saver'];
const GB = 1e9;

export const ruleId = r => r.type === 'playlist' ? `playlist:${r.id}` : r.type === 'album' || r.type === 'track' ? `${r.type}:${r.key}` : r.type === 'rating' ? 'rating' : r.type;
export function ruleLabel(r) {
  switch (r.type) {
    case 'playlist': return `Playlist “${r.name || r.id}”`;
    case 'album': return `Album “${r.name || r.key.split('\u0000').pop()}”`;
    case 'track': return `Track “${r.name || r.key}”`;
    case 'rating': return `Everything rated ${r.min}★ or more`;
    case 'starred': return 'Everything starred';
    default: return r.type;
  }
}
/** Add a rule (or move it to the end if it is there already); returns the new list. */
export const addRule = (rules, r) => [...rules.filter(x => ruleId(x) !== ruleId(r)), r];
export const removeRule = (rules, r) => rules.filter(x => ruleId(x) !== ruleId(r));
export const hasRule = (rules, r) => rules.some(x => ruleId(x) === ruleId(r));
export function moveRule(rules, r, by) {
  const i = rules.findIndex(x => ruleId(x) === ruleId(r)), j = i + by; if (i < 0 || j < 0 || j >= rules.length) return rules;
  const out = rules.slice(); [out[i], out[j]] = [out[j], out[i]]; return out;
}

/** The library items one rule asks for. ctx: { byKey, playlists, albums: Map(key → { tracks }), records } */
export function ruleTracks(rule, { byKey, playlists = [], albums = new Map(), records = [] }) {
  switch (rule.type) {
    case 'playlist': { const p = playlists.find(x => x.id === rule.id); return p ? p.items.map(k => byKey.get(typeof k === 'string' ? k : k?.key)).filter(Boolean) : []; }
    case 'album': return albums.get(rule.key)?.tracks || [];
    case 'track': { const t = byKey.get(rule.key); return t ? [t] : []; }
    case 'rating': return records.filter(r => (r.rating || 0) >= (+rule.min || 5)).map(r => byKey.get(r.key)).filter(Boolean);
    case 'starred': return records.filter(r => (r.tags || []).includes('starred')).map(r => byKey.get(r.key)).filter(Boolean);
    default: return [];
  }
}

/** The files an item needs to play offline: a track's file; a stem set's mix and details (and stems when asked, or when it has no mix); a package whole. */
export function sourcesOf(t, { stems = false } = {}) {
  if (t.kind !== 'render') return t.src ? [t.src] : [];
  if (t.pkgSrc) return [t.pkgSrc];
  const withStems = stems || !t.mix;
  return [t.mix, t.manifestSrc, t.clipsSrc, t.coverSrc, ...(withStems ? (t.stems || []).map(s => s.src) : [])].filter(Boolean);
}

/** Whether a source may be stored: a local file, or a server track whose plugin allows offline copies. */
export const canKeep = (src, getPlugin) => !!src && (src.kind === 'tauri' || (src.kind === 'remote' && !!src.remote && !!getPlugin(src.remote.plugin)?.offline));

const extOf = p => { const m = /\.([^./]+)$/.exec(p || ''); return m ? m[1].toLowerCase() : 'bin'; };
/** The fetch job for one source at a quality (null when it can't be stored). Local files are always kept as they are. */
export function jobFor(src, quality, { getPlugin, sessionOf }) {
  if (src.kind === 'tauri') return { id: `${src.path}|original`, key: src.path, quality: 'original', path: src.path, ext: extOf(src.path), fp: `${src.size || 0}:${src.mtime || 0}`, size: src.size || 0 };
  if (src.kind !== 'remote' || !src.remote) return null;
  const p = getPlugin(src.remote.plugin); if (!p?.offline || !p.download) return null;
  const ses = sessionOf(src.remote); if (!ses) return null;
  const it = src.remote.item, d = p.download(ses, it, quality); if (!d?.url) return null;
  const q = d.quality || quality;
  return { id: `${src.path}|${q}`, key: src.path, quality: q, url: d.url, headers: d.headers || {}, ext: d.ext || extOf(src.name), fp: `${it.size || 0}:${it.changed || 0}`, size: d.bytes || it.size || src.size || 0 };
}

/** What the rules want, in priority order, as unique sources with the rule that asked first. */
export function wantedBy(rules, ctx, { stems = false, getPlugin } = {}) {
  const out = [], seen = new Set();
  for (const rule of rules) for (const t of ruleTracks(rule, ctx)) for (const src of sourcesOf(t, { stems })) {
    if (seen.has(src.path) || !canKeep(src, getPlugin)) continue;
    seen.add(src.path); out.push({ src, track: t, rule });
  }
  return out;
}

/**
 * Plan a sync of the store. `wanted`: [{ job, rule }] in priority order (jobs from jobFor); `entries`: the store's
 * entries ({ id, key, quality, size, fp, played }); `held`: ids kept for device cards (kept, counted, never evicted here).
 * Returns { fetch: [job], keep: Set(id), remove: [id], over: [{ job, rule }] (no room), bytes (planned use) }.
 */
export function planOffline({ wanted, entries, maxBytes, held = new Set(), auto = false, autoBytes = 0 }) {
  const byId = new Map(entries.map(e => [e.id, e])), keep = new Set(), fetch = [], over = [];
  let bytes = 0;
  for (const id of held) { const e = byId.get(id); if (e) { keep.add(id); bytes += e.size; } }
  for (const w of wanted) {
    const e = byId.get(w.job.id), fresh = e && e.fp === w.job.fp;
    if (keep.has(w.job.id)) continue;
    const size = fresh ? e.size : w.job.size || e?.size || 0;
    if (bytes + size > maxBytes) { over.push(w); continue; }
    bytes += size; keep.add(w.job.id); if (!fresh) fetch.push(w.job);
  }
  // played tracks the rules don't ask for: kept by "also keep what I play" up to its own limit, most recently played first
  let autoUsed = 0;
  if (auto) for (const e of entries.filter(e => !keep.has(e.id) && e.played).sort((a, b) => b.played - a.played)) {
    if (autoUsed + e.size > autoBytes) continue; autoUsed += e.size; keep.add(e.id);
  }
  return { fetch, keep, remove: entries.filter(e => !keep.has(e.id)).map(e => e.id), over, bytes, autoBytes: autoUsed };
}

/** key → best kept copy ({ path, quality }): original first, then high, then saver. */
export function bestCopies(entries) {
  const out = new Map();
  for (const e of entries) {
    const cur = out.get(e.key);
    if (!cur || PREFER.indexOf(e.quality) < PREFER.indexOf(cur.quality)) out.set(e.key, { path: e.path, quality: e.quality, id: e.id });
  }
  return out;
}

/** Is everything this item needs kept? */
export const isKept = (t, copies, opts) => { const s = sourcesOf(t, opts); return s.length > 0 && s.every(x => copies.has(x.path)); };

export const gb = n => (n / GB).toFixed(n >= 10 * GB ? 0 : 1) + ' GB';
export const bytesOfGB = g => Math.max(0, +g || 0) * GB;
