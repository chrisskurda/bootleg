// A "source" is one file the player can read: from a browser File (web) or a path on disk (desktop, through Tauri's asset protocol).
//   { kind, name, path ('/'-separated; relative for web, absolute for desktop), size, reader(), url(), text() }
import { blobReader } from './tags.js';
const norm = p => String(p).replace(/\\/g, '/');
export const AUDIO_RE = /\.(mp3|flac|m4a|aac|ogg|opus|wav|aif|aiff|caf)$/i;
export const NFO_RE = /\.nfo$/i;
export const wanted = name => AUDIO_RE.test(name) || NFO_RE.test(name) || name === 'manifest.json' || name === 'clips.json';

export function webSource(file, path) {
  let url = null;
  return { kind: 'web', name: file.name, path: norm(path || file.webkitRelativePath || file.name), size: file.size, mtime: file.lastModified || 0, reader: () => blobReader(file), url: () => (url ||= URL.createObjectURL(file)), text: () => file.text() };
}

function rangeReader(url, size) {
  return { size, read: async (o, l) => { const end = Math.min(size, o + l) - 1; if (end < o) return new Uint8Array(0); const r = await fetch(url, { headers: { Range: `bytes=${o}-${end}` } }); return new Uint8Array(await r.arrayBuffer()); } };
}
export function tauriSource(absPath, size, mtime = 0) {
  const p = norm(absPath); let url = null; const U = () => (url ||= window.__TAURI__.core.convertFileSrc(absPath));      // lazy: libraries have tens of thousands of these
  return { kind: 'tauri', name: p.split('/').pop(), path: p, size, mtime, reader: () => rangeReader(U(), size), url: U, text: async () => (await fetch(U())).text() };
}

// Desktop: everything under a folder (recursively), as sources. The folder is first allowed for streaming (Rust command) — nothing outside what the user picked is readable.
export async function scanFolderTauri(dir, onProgress = () => {}) {
  const T = window.__TAURI__; await T.core.invoke('allow_path', { path: dir });
  try {      // fast path: the whole walk happens in Rust (parallel); one call returns every file with size + mtime
    const ch = new T.core.Channel(); ch.onmessage = p => onProgress(p);
    const entries = await T.core.invoke('scan_dir', { path: dir, onProgress: ch }); onProgress({ dirs: 0, files: entries.length });
    return entries.map(e => tauriSource(e.path, e.size, e.mtime));
  } catch (e) { console.warn('native scan unavailable, falling back to the slow path', e); }
  const out = [], todo = [dir]; let dirs = 0, files = 0, active = 0;
  const one = async d => {
    let entries; try { entries = await T.fs.readDir(d); } catch { return; } dirs++;
    await Promise.all(entries.filter(e => !e.name.startsWith('.')).map(async e => { const p = norm(d) + '/' + e.name; if (e.isDirectory) todo.push(p); else if (wanted(e.name)) { try { const st = await T.fs.stat(p); out.push(tauriSource(p, st.size, st.mtime ? +new Date(st.mtime) : 0)); if (AUDIO_RE.test(e.name)) files++; } catch { /* unreadable file: skip */ } } }));
    onProgress({ dirs, files });
  };
  await new Promise(done => { const pump = () => { while (active < 8 && todo.length) { active++; one(todo.pop()).finally(() => { active--; pump(); }); } if (!active && !todo.length) done(); }; pump(); });
  return out;
}
export async function sourcesFromPathsTauri(paths) {
  const T = window.__TAURI__, out = [];
  for (const p of paths) { await T.core.invoke('allow_path', { path: p }); { const st = await T.fs.stat(p); out.push(tauriSource(p, st.size, st.mtime ? +new Date(st.mtime) : 0)); } }
  return out;
}
// Web: File objects from <input type=file> (webkitdirectory gives relative paths) or a drop.
export const sourcesFromFiles = files => [...files].filter(f => wanted(f.name)).map(f => webSource(f));

// Native tag reading (desktop): requests are gathered for a few milliseconds and read in one batch by Rust (threaded).
// Resolves to the same fields as the page-side reader, or null (then the caller falls back to the page-side reader).
export function makeNativeTagReader(knownCovers) {
  const T = window.__TAURI__; let queue = [], timer = 0;
  const b64 = s => { const bin = atob(s), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
  const flush = async () => {
    timer = 0; const batch = queue; queue = [];
    try {
      const res = await T.core.invoke('read_tags_batch', { paths: batch.map(b => b.path), knownCovers: knownCovers() }), decoded = new Map();
      batch.forEach((b, i) => { const t = res.tags[i]; if (!t) return b.ok(null); const g = { ...t }, c = t.coverKey && res.covers[t.coverKey]; if (c) { if (!decoded.has(t.coverKey)) decoded.set(t.coverKey, { mime: c.mime, data: b64(c.dataB64) }); g.cover = decoded.get(t.coverKey); } b.ok(g); });
    } catch { batch.forEach(b => b.ok(null)); }
  };
  return path => new Promise(ok => { queue.push({ path, ok }); if (queue.length >= 256) { clearTimeout(timer); flush(); } else if (!timer) timer = setTimeout(flush, 5); });
}
