// A "source" is one file the player can read: from a browser File (web) or a path on disk (desktop, through Tauri's asset protocol).
//   { kind, name, path ('/'-separated; relative for web, absolute for desktop), size, reader(), url(), text() }
import { blobReader } from './tags.js';
const norm = p => String(p).replace(/\\/g, '/');
export const AUDIO_RE = /\.(mp3|flac|m4a|aac|ogg|opus|wav|aif|aiff|caf)$/i;

export function webSource(file, path) {
  let url = null;
  return { kind: 'web', name: file.name, path: norm(path || file.webkitRelativePath || file.name), size: file.size, reader: () => blobReader(file), url: () => (url ||= URL.createObjectURL(file)), text: () => file.text() };
}

function rangeReader(url, size) {
  return { size, read: async (o, l) => { const end = Math.min(size, o + l) - 1; if (end < o) return new Uint8Array(0); const r = await fetch(url, { headers: { Range: `bytes=${o}-${end}` } }); return new Uint8Array(await r.arrayBuffer()); } };
}
export function tauriSource(absPath, size) {
  const url = window.__TAURI__.core.convertFileSrc(absPath), p = norm(absPath);
  return { kind: 'tauri', name: p.split('/').pop(), path: p, size, reader: () => rangeReader(url, size), url: () => url, text: async () => (await fetch(url)).text() };
}

// Desktop: everything under a folder (recursively), as sources. The folder is first allowed for streaming (Rust command) — nothing outside what the user picked is readable.
export async function scanFolderTauri(dir) {
  const T = window.__TAURI__; await T.core.invoke('allow_path', { path: dir });
  const out = [];
  const walk = async d => { for (const e of await T.fs.readDir(d)) { if (e.name.startsWith('.')) continue; const p = norm(d) + '/' + e.name; if (e.isDirectory) await walk(p); else if (AUDIO_RE.test(e.name) || e.name === 'manifest.json' || e.name === 'clips.json') out.push(tauriSource(p, (await T.fs.stat(p)).size)); } };
  await walk(dir); return out;
}
export async function sourcesFromPathsTauri(paths) {
  const T = window.__TAURI__, out = [];
  for (const p of paths) { await T.core.invoke('allow_path', { path: p }); out.push(tauriSource(p, (await T.fs.stat(p)).size)); }
  return out;
}
// Web: File objects from <input type=file> (webkitdirectory gives relative paths) or a drop.
export const sourcesFromFiles = files => [...files].filter(f => AUDIO_RE.test(f.name) || f.name === 'manifest.json' || f.name === 'clips.json').map(f => webSource(f));
