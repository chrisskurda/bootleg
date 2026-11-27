// Library checker (docs/plugins/CHECKER.md): the Library check page. The native part (plugins/checker/native) decodes and
// measures every file; this page chooses what to check, runs it as a job, and writes what it finds into the library as
// tags, a note and defects (checker-logic.js decides what the measurements mean).
import { findings, arFinding, albums, annotation, LABEL, fmtT } from './checker-logic.js';

const ORDER = ['unreadable', 'damaged', 'truncated', 'md5', 'suspect', 'lossy', 'upsampled', 'padded', 'clipping', 'verified'];
const LEVEL = { unreadable: 'bad', damaged: 'bad', truncated: 'bad', md5: 'bad', suspect: 'warn', lossy: 'warn', upsampled: 'warn', padded: 'warn', clipping: 'info', verified: 'ok' };

export function activate(api) {
  if (!api.native) return { status: () => 'Needs the desktop app with the checker built in.' };
  const S = (k, d) => api.settings.get(k, d), set = (k, v) => api.settings.set(k, v);
  let job = null, progress = { fraction: 0, text: '' }, root = null, summary = null, error = '', open = new Set();
  const results = new Map();      // path → { check, error, ar }
  const el = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs || {})) { if (v == null || v === false) continue; if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (k in e) e[k] = v; else e.setAttribute(k, v); } for (const c of kids.flat()) if (c != null && c !== false && c !== '') e.append(c.nodeType ? c : String(c)); return e; };

  const local = () => api.library.tracks.filter(t => t.src?.kind === 'tauri' && t.src.path);
  const byPath = () => new Map(local().map(t => [t.src.path, t]));
  async function write(path) {
    const r = results.get(path); if (!r) return;
    try { await api.library.annotate(path, annotation(r.check, r.ar, r.error)); } catch (e) { console.warn('checker: annotate', path, e); }
  }

  async function start() {
    const scope = S('scope', 'all'), folder = S('folder', '');
    let tracks = local(); if (scope === 'folder' && folder) tracks = tracks.filter(t => t.src.path.startsWith(folder.replace(/[\\/]?$/, '/')));
    if (!tracks.length) { error = scope === 'folder' ? 'No tracks in that folder.' : 'No local files in the library to check.'; paint(); return; }
    results.clear(); summary = null; error = ''; progress = { fraction: 0, text: 'Starting…' }; paint();
    const request = { files: tracks.map(t => t.src.path), albums: albums(tracks), recheck: !!S('recheck', false), accuraterip: S('accuraterip', true) };
    const pending = [];
    job = api.native.job('check', { request }, ev => {
      if (ev.type === 'progress') { progress = ev; paintProgress(); }
      if (ev.type !== 'event') return; const d = ev.data;
      if (d.kind === 'file') { results.set(d.path, { check: d.check, error: d.error, ar: undefined }); pending.push(write(d.path)); }
      if (d.kind === 'album') d.paths.forEach((p, i) => { const r = results.get(p); if (!r) return; r.ar = arFinding(d.check, i); r.album = d.check.state; pending.push(write(p)); });
      schedule();
    });
    try { summary = await job.done; } catch (e) { error = e.cancelled ? 'Stopped. What was checked so far is in the library.' : String(e.message || e); }
    await Promise.all(pending); job = null; paint();
  }

  // ── the page ────────────────────────────────────────────────────────────────────────────────────────────────────
  let timer = 0; const schedule = () => { if (!timer) timer = setTimeout(() => { timer = 0; paint(); }, 400); };
  function groups() {
    const g = new Map(ORDER.map(k => [k, []])), tp = byPath();
    for (const [path, r] of results) {
      const t = tp.get(path), fs = r.check ? findings(r.check) : r.error ? [{ code: 'unreadable', text: r.error }] : [];
      for (const f of [...fs, ...(r.ar ? [r.ar] : [])]) g.get(f.code)?.push({ path, t, f, r });
    }
    return g;
  }
  function paintProgress() { const b = root?.querySelector('.ckbar > i'), t = root?.querySelector('.ckprog'); if (b) b.style.width = `${Math.round(progress.fraction * 100)}%`; if (t) t.textContent = progress.text; }
  function paint() {
    if (!root) return;
    const scope = S('scope', 'all'), folder = S('folder', ''), g = groups(), checked = results.size;
    const clean = [...results.values()].filter(r => r.check && !findings(r.check).length).length;
    const opt = (key, label, def) => el('label', { class: 'ckrow' }, el('input', { type: 'checkbox', checked: S(key, def), disabled: !!job, onchange: e => set(key, e.target.checked) }), label);
    root.replaceChildren(el('div', { class: 'ckpage' },
      el('div', { class: 'ckhead' }, el('h3', {}, 'Library check'),
        el('select', { disabled: !!job, onchange: e => { set('scope', e.target.value); paint(); } }, el('option', { value: 'all', selected: scope === 'all' }, 'The whole library'), el('option', { value: 'folder', selected: scope === 'folder' }, 'One folder')),
        scope === 'folder' ? el('button', { class: 'btn', disabled: !!job || !api.dialog, onclick: async () => { const f = await api.dialog.folder({ title: 'Folder to check' }); if (f) { set('folder', f); paint(); } } }, folder ? folder.split(/[\\/]/).pop() : 'Choose…') : '',
        job ? el('button', { class: 'btn', onclick: () => job.cancel() }, 'Stop') : el('button', { class: 'btn primary', onclick: start }, 'Check')),
      el('p', { class: 'muted small' }, 'Reads every file all the way through: damage, cut-off files, FLAC checksums, lossy files saved as lossless, upsampling, padded bit depth, clipping and dynamic range, and AccurateRip for CD rips. Files already checked and unchanged are not read again. What it finds is added to each track as tags (check:…, rip:verified, rip:suspect), a note and, for damage, ⚠ marks on the timeline.'),
      el('div', { class: 'ckopts' }, opt('accuraterip', 'Check CD rips with AccurateRip (internet)', true), opt('recheck', 'Read every file again (ignore earlier results)', false)),
      job || progress.fraction ? el('div', { class: 'ckrun' }, el('div', { class: 'ckbar' }, el('i', { style: `width:${Math.round(progress.fraction * 100)}%` })), el('span', { class: 'ckprog muted small' }, progress.text)) : '',
      error ? el('p', { class: 'err' }, error) : '',
      checked ? el('p', {}, `${checked.toLocaleString()} files checked${summary ? ` (${summary.read.toLocaleString()} read, ${summary.cached.toLocaleString()} unchanged since last time)` : ''}: ${clean.toLocaleString()} with nothing to report.`) : '',
      ...ORDER.filter(k => g.get(k).length).map(k => {
        const items = g.get(k), isOpen = open.has(k);
        return el('div', { class: 'ckgroup' },
          el('button', { class: `ckg ${LEVEL[k]}`, onclick: () => { isOpen ? open.delete(k) : open.add(k); paint(); } }, `${isOpen ? '▾' : '▸'} ${LABEL[k]}`, el('span', { class: 'ckn' }, items.length.toLocaleString())),
          isOpen ? el('ul', { class: 'cklist' }, ...items.slice(0, 500).map(({ path, t, f, r }) => el('li', {},
            el('div', {}, el('b', {}, t ? `${t.artist || '?'} – ${t.title || path.split(/[\\/]/).pop()}` : path.split(/[\\/]/).pop()), r.check?.measures?.dr != null ? el('span', { class: 'muted small' }, ` DR ${Math.round(r.check.measures.dr)}`) : '', t ? el('button', { class: 'link', onclick: () => api.player.playList([t], 0) }, ' play') : ''),
            el('div', { class: 'muted small' }, f.text), el('div', { class: 'faint small' }, path))), items.length > 500 ? el('li', { class: 'muted' }, `… and ${items.length - 500} more (search your notes for the tag)`) : '') : '');
      })));
  }
  const remove = api.ui.addView({ title: 'Library check', mount(r) { r.append(el('style', {}, CSS)); root = el('div'); r.append(root); paint(); return () => { root = null; }; } });
  return {
    stop() { job?.cancel(); clearTimeout(timer); remove(); },
    status: () => (job ? `checking… ${Math.round(progress.fraction * 100)}%` : results.size ? `${results.size} files checked` : ''),
    _test: { start, results, get summary() { return summary; } },
  };
}

const CSS = `
.ckpage { max-width: 980px; padding: 14px 4px 40px; display: grid; gap: 12px; }
.ckhead { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; } .ckhead h3 { margin: 0 8px 0 0; }
.ckopts { display: flex; gap: 18px; flex-wrap: wrap; } .ckrow { display: flex; gap: 6px; align-items: center; }
.ckrun { display: grid; gap: 6px; } .ckbar { height: 6px; border-radius: 3px; background: var(--panel2); overflow: hidden; } .ckbar > i { display: block; height: 100%; background: var(--accent); transition: width .2s; }
.ckgroup { display: grid; gap: 6px; } .ckg { all: unset; cursor: pointer; display: flex; gap: 10px; align-items: center; font-weight: 600; padding: 6px 10px; border-radius: 8px; background: var(--panel2); }
.ckg.bad { color: #ff8a8a; } .ckg.warn { color: #ffc65c; } .ckg.ok { color: #5fd28a; } .ckn { margin-left: auto; font-weight: 400; color: var(--muted); }
.cklist { list-style: none; margin: 0 0 0 10px; padding: 0; display: grid; gap: 8px; } .cklist li { display: grid; gap: 2px; } .faint { color: var(--faint); word-break: break-all; }
`;
