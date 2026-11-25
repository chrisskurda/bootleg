// bootleg — the app. Library, queue, player bar, stem mixer and the visualizer view.
import { AudioFeed } from '/vendor/bootleg-vizualizer/core/audio.js';
import { Library } from '/lib/library.js';
import { Player } from '/lib/player.js';
import { VizHost } from '/lib/viz.js';
import { h } from '/lib/controls.js';
import { MemoryBackend } from '/lib/notes.js';
import { initNotes, trackKey, stars } from '/lib/notes-ui.js';
import { getSource, listSources } from '/lib/sources/index.js';
import { scanConnection, fromIndexEntry, toIndexEntry, rootKey } from '/lib/sources/remote.js';
import { Libraries, MODES } from '/lib/libraries.js';
import { LibCache, NullCache } from '/lib/cache.js';
import { AUDIO_RE, wanted, sourcesFromFiles, webSource, tauriSource, scanFolderTauri, sourcesFromPathsTauri } from '/lib/source.js';

const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const fmt = s => { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const TAURI = window.__TAURI__;
const lib = new Library(), feed = new AudioFeed(), player = new Player(feed);
const viz = new VizHost({ stage: $('#vizStage'), packSelect: $('#packSelect'), paramsEl: $('#packParams'), lookEl: $('#lookParams'), feed, player });
function toast(msg, bad = false) { const t = h('div', { class: 'toast' + (bad ? ' bad' : '') }, msg); document.body.append(t); setTimeout(() => t.remove(), bad ? 6000 : 3000); }
const SELF = window.__BOOTLEG_SELFTEST || null, mem = new Map();    // self-test mode: the shell injects this flag, and nothing below touches the real settings, library or notes
const store = SELF ? { get: (k, d) => (mem.has(k) ? JSON.parse(mem.get(k)) : d), set: (k, v) => { mem.set(k, JSON.stringify(v)); } } : { get: (k, d) => { try { const v = localStorage.getItem('bootleg.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } }, set: (k, v) => { try { localStorage.setItem('bootleg.' + k, JSON.stringify(v)); } catch { /* private mode */ } } };

// ------------------------------------------------------------------ views
let view = 'tracks';
function show(v) {
  view = v; $$('.view').forEach(s => { s.hidden = s.id !== 'view-' + v; }); $$('.nav').forEach(b => b.classList.toggle('on', b.dataset.view === v));
  v === 'now' ? viz.start() : viz.stop(); if (v === 'now') buildStems(); if (v === 'settings') { $('#settingsBody').replaceChildren(); paintSettings(); } renderAll();
}
$$('.nav').forEach(b => b.onclick = () => show(b.dataset.view)); $('#np').onclick = () => show('now');

// ------------------------------------------------------------------ lists
let shown = [];
const cover = (url, cls = 'cover') => url ? h('img', { class: cls, src: url, alt: '', loading: 'lazy' }) : h('div', { class: cls + ' ph' }, '♪');
function trackRow(t, i) {
  return h('div', { class: 'row' + (player.item?.id === t.id ? ' playing' : ''), 'data-id': t.id, ondblclick: () => player.playList(shown, i) },
    h('span', {}, h('span', { class: 'n' }, String(i + 1)), h('button', { class: 'pl', title: 'Play', onclick: () => player.playList(shown, i) }, '▶')),
    h('span', { class: 'tt' }, t.title), h('span', { class: 'muted' }, t.artist || ''), h('span', { class: 'muted' }, t.album || ''),
    h('span', { class: 'tm' }, t.duration ? fmt(t.duration) : ''), h('span', { class: 'acts' }, h('button', { class: 'mini', onclick: () => { player.enqueue([t], true); toast('Plays next'); } }, 'next'), h('button', { class: 'mini', onclick: () => { player.enqueue([t]); toast('Added to queue'); } }, '+ queue')));
}
function renderTracks() {
  shown = lib.search(lib.sortedTracks(), $('#search').value); const list = $('#trackList'); list.replaceChildren(...shown.map(trackRow));
  $('#emptyTracks').hidden = lib.visibleTracks.length > 0; $('.thead').hidden = !lib.visibleTracks.length;
}
function renderAlbums() {
  const q = $('#search').value.toLowerCase(), list = lib.albums().filter(a => !q || (a.album + ' ' + a.artist).toLowerCase().includes(q));
  $('#albumGrid').replaceChildren(...list.map(a => h('div', { class: 'card', title: 'Play album', onclick: () => player.playList(a.tracks, 0) }, cover(a.coverUrl), h('div', { class: 't' }, a.album), h('div', { class: 's' }, `${a.artist || ''}${a.artist ? ' · ' : ''}${a.tracks.length} tracks`))));
  $('#emptyAlbums').hidden = list.length > 0;
}
function renderRenders() {
  const list = lib.search(lib.visibleRenders, $('#search').value);
  $('#renderList').replaceChildren(...list.map(r => h('div', { class: 'rcard', onclick: () => player.playList([r], 0) }, cover(r.coverUrl), h('div', {}, h('div', { class: 'big' }, r.title),
    h('div', { class: 'muted small' }, [r.artist, r.bpm && Math.round(r.bpm) + ' BPM', r.key, r.duration && fmt(r.duration)].filter(Boolean).join(' · ')),
    h('div', { class: 'badges' }, h('span', { class: 'badge ok' }, `${r.stems.length} stems`), r.sections.length ? h('span', { class: 'badge' }, `${r.sections.length} sections`) : null, r.clips ? h('span', { class: 'badge' }, 'sample labels') : null)))));
  $('#emptyRenders').hidden = list.length > 0;
}
function renderAll() {
  const vt = lib.visibleTracks.length, vr = lib.visibleRenders.length; $('#nTracks').textContent = vt || ''; $('#nRenders').textContent = vr || ''; $('#nAlbums').textContent = lib.albums().length || '';
  if (view === 'tracks') renderTracks(); else if (view === 'albums') renderAlbums(); else if (view === 'renders') renderRenders();
  const left = lib._q.length + lib._busy; $('#status').textContent = left ? `Reading tags… ${left} left` : vt || vr ? `${vt} tracks · ${vr} renders` : '';
  $('#forget').hidden = !scopeRoots().length;
}
let rTimer = 0; lib.addEventListener('change', () => { if (rTimer) return; rTimer = setTimeout(() => { rTimer = 0; renderAll(); }, 250); });
$('#search').oninput = () => renderAll();

// ------------------------------------------------------------------ adding music
const libs = new Libraries(store); lib.scope = libs.active;
const DEFAULTS = { cacheEnabled: true, scanOnStart: true, rescanMinutes: 0, tagConcurrency: 6, useNfo: true, nfoFill: true };
const settings = { ...DEFAULTS, ...store.get('settings', {}) };
let cache; try { cache = SELF ? new LibCache('bootleg-selftest-' + Date.now()) : settings.cacheEnabled ? new LibCache() : new NullCache(); } catch { cache = new NullCache(); }
function applySettings() { lib.concurrency = Math.max(1, Math.min(32, +settings.tagConcurrency || 6)); lib.setNfoOptions({ useNfo: settings.useNfo, nfoFill: settings.nfoFill }); store.set('settings', settings); armRescan(); }
let rescanTimer = 0; function armRescan() { clearInterval(rescanTimer); rescanTimer = 0; if (TAURI && settings.rescanMinutes > 0) rescanTimer = setInterval(() => syncAll(true), settings.rescanMinutes * 60000); }
const scan = { on: false, text: '' };
function paintProgress() {
  const pr = $('#progress'), left = lib._q.length + lib._busy; let text = '', frac = null;
  if (scan.on) text = scan.text; else if (left) { text = `Reading tags… ${lib.done.toLocaleString()} of ${lib.total.toLocaleString()}`; frac = lib.total ? lib.done / lib.total : 0; }
  pr.hidden = !text; if (!text) return; $('#ptext').textContent = text; pr.classList.toggle('indet', frac == null); $('#pfill').style.width = frac == null ? '' : Math.round(frac * 100) + '%';
}
setInterval(paintProgress, 150);
async function addSources(sources, label) {
  if (!sources.length) return toast('No music found there', true);
  const r = lib.add(sources, libs.target().id); paintProgress(); toast(`${label || 'Added'}: ${r.tracks} tracks, ${r.renders} renders`); renderAll();
}
async function scanFolder(dir) {
  scan.on = true; scan.text = 'Scanning folder…'; paintProgress();
  try { return await scanFolderTauri(dir, ({ dirs, files }) => { scan.text = `Scanning ${dir.split('/').pop()}… ${files.toLocaleString()} audio files in ${dirs.toLocaleString()} folders`; }); } finally { scan.on = false; }
}
async function addFolderDesktop() {
  const dir = await TAURI.dialog.open({ directory: true, multiple: false, title: 'Add a music folder' }); if (!dir) return;
  libs.addRoot(libs.target().id, dir); const srcs = await scanFolder(dir); await addSources(srcs, 'Scanned'); cache.putIndex(dir, srcs.map(x => ({ path: x.path, size: x.size, mtime: x.mtime }))).catch(() => {});
}
async function addFilesDesktop() {
  const picked = await TAURI.dialog.open({ multiple: true, title: 'Add music files', filters: [{ name: 'Audio', extensions: ['mp3', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wav', 'aif', 'aiff', 'caf'] }] }); if (!picked) return;
  await addSources(await sourcesFromPathsTauri(Array.isArray(picked) ? picked : [picked]));
}
$('#addFolder').onclick = () => (TAURI ? addFolderDesktop().catch(e => toast(String(e), true)) : $('#folderIn').click());
$('#addFiles').onclick = () => (TAURI ? addFilesDesktop().catch(e => toast(String(e), true)) : $('#filesIn').click());
$('#folderIn').onchange = e => { addSources(sourcesFromFiles(e.target.files), 'Scanned'); e.target.value = ''; };
$('#filesIn').onchange = e => { addSources(sourcesFromFiles(e.target.files)); e.target.value = ''; };
const scopeRoots = () => { const ls = libs.active === 'all' ? libs.list : [libs.get(libs.active)].filter(Boolean); return ls.flatMap(L => [...L.roots, ...L.connections]).map(x => ({ root: x })); };
async function forgetLibrary(L) { for (const c of [...L.connections]) { libs.removeConnection(L.id, c.id); await cache.delIndex(`${c.plugin}:${c.id}`).catch(() => {}); } for (const r of [...L.roots]) { libs.removeRoot(L.id, r); if (!libs.ofRoot(r)) await cache.delIndex(r).catch(() => {}); } lib.dropLibrary(L.id); }
$('#forget').onclick = async () => { const targets = libs.active === 'all' ? libs.list : [libs.get(libs.active)]; for (const L of targets) await forgetLibrary(L); player.clear(); renderAll(); paintLibSel(); toast(libs.active === 'all' ? 'All libraries forgotten' : 'Library forgotten'); };
function paintLibSel() {
  const sel = $('#libSel'); sel.replaceChildren(...libs.list.map(l => h('option', { value: l.id, selected: l.id === libs.active }, `${l.name}${l.mode === 'studio' ? ' ✎' : ''}`)), libs.list.length > 1 ? h('option', { value: 'all', selected: libs.active === 'all' }, 'All libraries') : null); sel.hidden = false; sel.value = libs.active;
}
$('#libSel').onchange = e => { libs.setActive(e.target.value); lib.scope = libs.active; renderAll(); notes?.refresh?.(); };

// Desktop: show the whole library from the cache immediately, then look for changes in the background.
const sessionOf = r => { const c = libs.connection(r.conn), p = getSource(r.plugin); return c && p ? p.session(c.config) : null; };
async function restoreFromCache() {
  for (const ix of await cache.indexes()) {
    const owner = libs.ofRoot(ix.root); if (!owner) continue;
    try {
      if (ix.entries[0]?.remote) { lib.add(ix.entries.map(e => fromIndexEntry(e, getSource, sessionOf)).filter(Boolean), owner.id); continue; }     // a source plugin's library: no disk, no network needed
      if (!TAURI) continue; await TAURI.core.invoke('allow_path', { path: ix.root }); lib.add(ix.entries.map(e => tauriSource(e.path, e.size, e.mtime)), owner.id);
    } catch (e) { console.warn('cached root unavailable', ix.root, e); }
  } renderAll();
}
async function syncConnection(conn, L) {
  const p = getSource(conn.plugin); if (!p) throw new Error(`The “${conn.plugin}” source plugin is not installed`);
  const key = rootKey(p, conn.id); scan.on = true; scan.text = 'Connecting…'; paintProgress();
  try { const srcs = await scanConnection(p, p.session(conn.config), conn.id, { onProgress: t => { scan.text = t; } }); const before = lib.tracks.length; lib.add(srcs, L.id); const removed = lib.removeMissing(key, new Set(srcs.map(x => x.path)), L.id); await cache.putIndex(key, srcs.map(toIndexEntry)); return { added: Math.max(0, lib.tracks.length - before), removed, total: srcs.length }; }
  finally { scan.on = false; }
}
let syncing = false;
async function syncAll(quiet = false) {
  if (syncing || (!TAURI && !libs.allConnections().length)) return; syncing = true; let added = 0, removed = 0;
  try { for (const { conn, lib: L } of libs.allConnections()) { try { const r = await syncConnection(conn, L); added += r.added; removed += r.removed; } catch (e) { toast(`${conn.title}: ${e.message || e}`, true); } } }
  catch { /* handled per connection */ }
  try { if (TAURI) for (const { root, lib: L } of libs.allRoots()) { try { const before = lib.tracks.length, srcs = await scanFolder(root, 'Checking for changes in'); lib.add(srcs, L.id); removed += lib.removeMissing(root, new Set(srcs.map(x => x.path)), L.id); added += Math.max(0, lib.tracks.length - before); await cache.putIndex(root, srcs.map(x => ({ path: x.path, size: x.size, mtime: x.mtime }))); } catch (e) { console.warn('could not rescan', root, e); } } }
  finally { syncing = false; }
  if (!quiet || added || removed) toast(added || removed ? `Library updated: ${added} new, ${removed} removed` : 'Library is up to date'); renderAll(); if (view === 'settings') paintSettings();
}

// drag & drop: files and folders in the browser; paths from Tauri on the desktop
async function filesFromDrop(dt) {
  const out = [], walk = async (entry, base) => {
    if (entry.isFile) await new Promise(res => entry.file(f => { out.push(webSource(f, (base + f.name))); res(); }, res));
    else if (entry.isDirectory) { const rd = entry.createReader(); for (;;) { const batch = await new Promise((res, rej) => rd.readEntries(res, rej)); if (!batch.length) break; for (const c of batch) await walk(c, base + entry.name + '/'); } }
  };
  for (const it of dt.items || []) { const e = it.webkitGetAsEntry?.(); if (e) await walk(e, ''); }
  return out.filter(s => wanted(s.name));
}
addEventListener('dragover', e => { e.preventDefault(); document.body.classList.add('drop'); });
addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('drop'); });
addEventListener('drop', async e => { e.preventDefault(); document.body.classList.remove('drop'); if (!TAURI) addSources(await filesFromDrop(e.dataTransfer), 'Dropped'); });
if (TAURI?.event) TAURI.event.listen('tauri://drag-drop', async ev => {
  document.body.classList.remove('drop'); const sources = []; for (const p of ev.payload.paths || []) { try { const st = await TAURI.fs.stat(p); if (st.isDirectory) sources.push(...await scanFolder(p)); else sources.push(...await sourcesFromPathsTauri([p])); } catch (err) { toast(String(err), true); } } addSources(sources, 'Dropped');
});

// ------------------------------------------------------------------ player bar
const playBtn = $('#play'), seek = $('#seek');
function updateBar() {
  const it = player.item, playing = player.playing; playBtn.textContent = playing ? '⏸' : '▶'; playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  $('#npTitle').textContent = it ? it.title : 'Nothing playing'; $('#npSub').textContent = it ? [it.artist, it.album].filter(Boolean).join(' · ') + (player.loading ? ` — loading stems ${player.loading.n}/${player.loading.total}…` : '') : '';
  const c = $('#npCover'); if (it && it.coverUrl) { c.src = it.coverUrl; c.hidden = false; } else c.hidden = true;
  $('#shuffle').classList.toggle('on', player.shuffle); const rp = $('#repeat'); rp.classList.toggle('on', player.repeat !== 'off'); rp.textContent = player.repeat === 'one' ? '⟲1' : '⟲'; rp.title = 'Repeat: ' + player.repeat;
  $('#qCount').textContent = player.queue.length || ''; $$('.row').forEach(r => r.classList.toggle('playing', it && r.dataset.id === it.id)); $('#vizMsg').textContent = it ? '' : 'Play something to see it react. Until then the pack plays its idle demo.';
  renderQueue(); if (view === 'now') buildStems();
}
player.addEventListener('change', updateBar);
let drag = false; seek.oninput = () => { drag = true; }; seek.onchange = () => { const d = player.dur(); if (d) player.seek(seek.value / 1000 * d); drag = false; };
(function loop() { const d = player.dur(), p = player.pos(); if (!drag) seek.value = d ? Math.round(p / d * 1000) : 0; $('#tcur').textContent = fmt(p); $('#tdur').textContent = fmt(d); paintMeters(); requestAnimationFrame(loop); })();
playBtn.onclick = () => { if (!player.item) { if (shown.length) player.playList(shown, 0); else if (lib.renders.length) player.playList(lib.renders, 0); return; } player.toggle(); };
$('#prev').onclick = () => player.prev(); $('#next').onclick = () => player.next();
$('#shuffle').onclick = () => player.setShuffle(!player.shuffle); $('#repeat').onclick = () => player.setRepeat({ off: 'all', all: 'one', one: 'off' }[player.repeat]);
const vol = $('#volume'); vol.value = player.volume; vol.oninput = () => player.setVolume(+vol.value);

// ------------------------------------------------------------------ queue
function renderQueue() {
  const q = player.queue, list = $('#queueList'); $('#queueEmpty').hidden = q.length > 0;
  list.replaceChildren(...q.map((t, i) => h('div', { class: 'qi' + (i === player.index ? ' cur' : ''), onclick: () => player.jump(i) }, h('div', { style: 'min-width:0' }, h('div', { class: 't' }, t.title), h('div', { class: 's' }, t.artist || (t.kind === 'render' ? 'stem render' : ''))), h('button', { class: 'mini', title: 'Remove', onclick: e => { e.stopPropagation(); player.remove(i); } }, '✕'))));
}
$('#qToggle').onclick = () => { const q = $('#queue'); q.hidden = !q.hidden; $('#qToggle').classList.toggle('on', !q.hidden); }; $('#qClear').onclick = () => player.clear();

// ------------------------------------------------------------------ stems mixer
let stemEls = [];
function buildStems() {
  const it = player.item, deck = player.deck, panel = $('#stemsPanel'), on = it && it.kind === 'render' && player.mode === 'deck' && deck.stems.length > 0; panel.hidden = !on; if (!on) { stemEls = []; return; }
  if (stemEls.length === deck.stems.length && stemEls[0].deckStem === deck.stems[0]) return;       // already built for this render
  $('#stemsHint').textContent = 'M mute · S solo · the visualizer follows each stem'; stemEls = [];
  $('#stemRows').replaceChildren(...deck.stems.map(s => {
    const meter = h('i'), lbl = h('div', { class: 'lbl' }), m = h('button', { class: 'btn ms m', title: 'Mute', onclick: () => { s.mute = !s.mute; deck.applyGains(); sync(); } }, 'M'), so = h('button', { class: 'btn ms s', title: 'Solo', onclick: () => { s.solo = !s.solo; deck.applyGains(); sync(); } }, 'S');
    const trim = h('input', { type: 'range', min: -24, max: 6, step: 0.5, value: 0, title: 'trim (dB)', oninput: () => { s.trimDb = +trim.value; deck.applyGains(); } });
    const row = h('div', { class: 'stem' }, h('div', {}, h('div', { class: 'nm' }, s.name), h('div', { class: 'role' }, s.role)), h('span'), h('div', {}, h('div', { class: 'meter' }, meter), lbl), trim, m, so);
    const sync = () => { m.classList.toggle('on', s.mute); so.classList.toggle('on', s.solo); $$('.stem').forEach((el, i) => el.classList.toggle('dim', !(!deck.stems[i].mute && (!deck.stems.some(x => x.solo) || deck.stems[i].solo)))); };
    row.deckStem = s; row._r = { meter, lbl }; stemEls.push(row); return row;
  }));
}
function paintMeters() {
  if (view !== 'now' || !stemEls.length || !viz.lastA || !viz.lastA.stems) return; const by = Object.fromEntries(viz.lastA.stems.map(s => [s.name, s]));
  for (const row of stemEls) { const st = by[row.deckStem.name]; if (!st) continue; row._r.meter.style.width = Math.round(st.level * 100) + '%'; row._r.lbl.textContent = st.label ? `${st.label}${st.kit ? ' — ' + st.kit : ''}` : ''; }
}
$('#fsBtn').onclick = () => viz.fullscreen(); $('#lookReset').onclick = () => viz.resetLook();

// ------------------------------------------------------------------ keyboard
addEventListener('keydown', e => {
  const typing = /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) && document.activeElement.type !== 'range' && document.activeElement.type !== 'checkbox';
  if (e.key === '/' && !typing) { e.preventDefault(); $('#search').focus(); return; } if (typing) { if (e.key === 'Escape') document.activeElement.blur(); return; }
  if (e.code === 'Space') { e.preventDefault(); playBtn.click(); }
  else if (e.key === 'ArrowRight') { e.shiftKey ? player.next() : player.seek(player.pos() + 5); } else if (e.key === 'ArrowLeft') { e.shiftKey ? player.prev() : player.seek(player.pos() - 5); }
  else if (e.key === 'ArrowUp') { vol.value = Math.min(1, +vol.value + 0.05); vol.oninput(); } else if (e.key === 'ArrowDown') { vol.value = Math.max(0, +vol.value - 0.05); vol.oninput(); }
  else if (e.key === 'f' && view === 'now') viz.fullscreen(); else if (e.key === 'n') { e.preventDefault(); $('#markHere').click(); }
});

// ------------------------------------------------------------------ settings
// Connect a library to a source plugin (Subsonic, …): the form is built from the plugin's declared fields.
const formOpen = new Set();
function connectForm(L) {
  const wrap = h('div', { class: 'connect' }); if (!formOpen.has(L.id)) { wrap.append(h('button', { class: 'link', id: 'connectOpen-' + L.id, onclick: () => { formOpen.add(L.id); paintSettings(); } }, '＋ Connect a server or service…')); return wrap; }
  const plugins = listSources(), sel = h('select', { 'aria-label': 'Service' }, ...plugins.map(p => h('option', { value: p.id }, p.name))), fields = h('div', { class: 'cfields' }), err = h('div', { class: 'err', role: 'alert' }), vals = {};
  const draw = () => { const p = getSource(sel.value); fields.replaceChildren(h('div', { class: 'muted small' }, p.description || ''), ...p.fields.map(f => h('label', { class: 'f' }, h('span', {}, f.label + (f.required ? ' *' : '')), h('input', { type: f.type === 'password' ? 'password' : f.type === 'url' ? 'url' : 'text', name: f.key, placeholder: f.placeholder || '', autocomplete: 'off', oninput: e => { vals[f.key] = e.target.value; } }), f.hint ? h('small', { class: 'muted' }, f.hint) : ''))); };
  sel.onchange = draw; draw();
  const go = h('button', { class: 'btn primary', onclick: async () => {
    const p = getSource(sel.value); err.textContent = ''; for (const f of p.fields) if (f.required && !vals[f.key]) { err.textContent = `${f.label} is required`; return; }
    go.disabled = true; go.textContent = 'Connecting…';
    try { const { config, title } = await p.connect(vals), conn = { id: 'c' + Date.now().toString(36), plugin: p.id, title, config }; libs.addConnection(L.id, conn); formOpen.delete(L.id); const r = await syncConnection(conn, L); toast(`${title}: ${r.total.toLocaleString()} tracks`); renderAll(); paintSettings(); paintLibSel(); }
    catch (e) { err.textContent = e.message || String(e); go.disabled = false; go.textContent = 'Connect'; } } }, 'Connect');
  wrap.append(h('div', { class: 'lib-head' }, sel), fields, err, h('div', { class: 'cbtns' }, go, h('button', { class: 'btn', onclick: () => { formOpen.delete(L.id); paintSettings(); } }, 'Cancel')));
  return wrap;
}
async function paintSettings() {
  const box = $('#settingsBody'), st = await cache.stats(), row = (label, hint, input) => h('label', { class: 'srow' }, h('span', {}, h('b', {}, label), hint ? h('small', {}, hint) : ''), input);
  const chk = k => h('input', { type: 'checkbox', checked: !!settings[k], onchange: e => { settings[k] = e.target.checked; applySettings(); } });
  const num = (k, min, max) => h('input', { type: 'number', min, max, value: settings[k], onchange: e => { settings[k] = Math.max(min, Math.min(max, +e.target.value || 0)); applySettings(); } });
  const libCards = libs.list.map(L => h('div', { class: 'lib-card' },
    h('div', { class: 'lib-head' }, h('input', { value: L.name, 'aria-label': 'Library name', onchange: e => { libs.update(L.id, { name: e.target.value }); paintLibSel(); } }),
      h('select', { 'aria-label': 'Mode', onchange: e => { libs.update(L.id, { mode: e.target.value }); paintLibSel(); notes.refresh(); } }, ...Object.entries(MODES).map(([k, m]) => h('option', { value: k, selected: k === L.mode }, m.label))),
      h('button', { class: 'btn', onclick: async () => { libs.setActive(L.id); lib.scope = L.id; paintLibSel(); TAURI ? await addFolderDesktop().catch(e => toast(String(e), true)) : $('#folderIn').click(); paintSettings(); } }, 'Add folder here'),
      h('button', { class: 'btn', disabled: libs.list.length < 2, title: libs.list.length < 2 ? 'Keep at least one library' : 'Remove this library (your files are untouched; notes are kept)', onclick: async () => { await forgetLibrary(L); libs.remove(L.id); lib.scope = libs.active; renderAll(); paintLibSel(); paintSettings(); } }, 'Delete')),
    h('div', { class: 'muted small' }, MODES[L.mode].label === 'Studio' ? 'Studio: status, ideas, to-dos, mix notes and versions; how-it-was-made provenance.' : 'Listening: ratings, memories, stories; where-the-recording-came-from provenance.'),
    L.connections.length ? h('div', { class: 'lib-roots' }, ...L.connections.map(c => h('span', {}, '☁ ', h('b', {}, c.title), ' ', h('span', { class: 'muted' }, getSource(c.plugin)?.name || c.plugin), ' ', h('button', { class: 'link', onclick: () => syncAll().then(paintSettings) }, 'sync'), ' ', h('button', { class: 'link', onclick: async () => { libs.removeConnection(L.id, c.id); await cache.delIndex(`${c.plugin}:${c.id}`).catch(() => {}); lib.removeMissing(`${c.plugin}:${c.id}`, new Set(), L.id); renderAll(); paintSettings(); } }, 'disconnect')))) : '',
    connectForm(L),
    L.roots.length ? h('div', { class: 'lib-roots' }, ...L.roots.map(r => h('span', {}, h('code', {}, r), ' ', h('button', { class: 'link', onclick: async () => { libs.removeRoot(L.id, r); if (!libs.ofRoot(r)) await cache.delIndex(r).catch(() => {}); lib.removeMissing(r, new Set(), L.id); renderAll(); paintSettings(); } }, 'remove')))) : h('div', { class: 'muted small' }, TAURI ? 'No folders yet.' : 'In the browser, files you add stay for this session (the desktop app remembers folders).')));
  const newName = h('input', { placeholder: 'New library name…', id: 'newLibName' }), newMode = h('select', { id: 'newLibMode' }, ...Object.entries(MODES).map(([k, m]) => h('option', { value: k }, m.label)));
  box.replaceChildren(
    h('h3', {}, 'Libraries'), ...libCards,
    h('div', { class: 'lib-head' }, newName, newMode, h('button', { class: 'btn primary', id: 'newLibBtn', onclick: () => { const l = libs.add(newName.value, newMode.value); libs.setActive(l.id); lib.scope = l.id; paintLibSel(); renderAll(); paintSettings(); } }, 'Create library')),
    h('div', { class: 'muted small' }, 'Notes, ratings and tags belong to the recording, so they follow it across libraries. A library’s mode only chooses which fields and tools are offered.'),
    h('h3', {}, 'Library scanning'),
    row('Remember the library (cache)', 'Tags, covers and the file list are kept on this device, so the library appears instantly next time. Takes effect after a restart.', chk('cacheEnabled')),
    row('Check for changes on startup', TAURI ? 'Looks for added, changed and removed files in the background.' : 'Desktop app only — a browser cannot see the disk without being given files.', chk('scanOnStart')),
    row('Re-check every N minutes', '0 = only on startup or when you ask.', num('rescanMinutes', 0, 1440)),
    row('Tag-reading parallelism', 'Higher is faster on fast disks; lower is gentler on network drives.', num('tagConcurrency', 1, 32)),
    h('h3', {}, '.nfo files'),
    row('Read .nfo files', 'album.nfo / artist.nfo (Kodi style) and plain-text .nfo in your folders: shown with the track and searchable.', chk('useNfo')),
    row('Fill missing tags from .nfo', 'Tags in the files always win; an .nfo only supplies what is missing (album, artist, year, genre).', chk('nfoFill')),
    h('h3', {}, 'Maintenance'),
    h('div', { class: 'srow' }, h('span', {}, h('b', {}, 'Cache'), h('small', {}, `${st.files.toLocaleString()} files remembered · ${st.covers.toLocaleString()} covers · ${st.indexed.toLocaleString()} files indexed in ${st.roots} folders`)),
      h('span', { class: 'sbtns' }, h('button', { class: 'btn', disabled: !TAURI && !libs.allConnections().length, onclick: () => syncAll() }, 'Check for changes now'), h('button', { class: 'btn', onclick: async () => { await cache.clear(); lib.fileCache.clear(); toast('Cache cleared — tags will be re-read on the next scan'); paintSettings(); } }, 'Clear cache'))));
}

// ------------------------------------------------------------------ notes, ratings, playlists
async function saveText(name, text, mime, fullPath) {
  if (TAURI?.dialog && TAURI?.fs?.writeTextFile) { const p = await TAURI.dialog.save({ defaultPath: fullPath || name }); if (!p) return; await TAURI.fs.writeTextFile(p, text); toast('Saved ' + p.split('/').pop()); return; }
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: mime })), download: name }); document.body.append(a); a.click(); a.remove(); toast('Saved ' + name);
}
const notes = initNotes({ backend: SELF ? new MemoryBackend() : null, player, lib, libs, h, fmt, toast, show, saveText, $ });

// ------------------------------------------------------------------ desktop self-test (BOOTLEG_SELFTEST=<music dir> BOOTLEG_SELFTEST_OUT=<file>): proves the packaged app can scan, tag, stream and analyse real files
async function selfTest(dir) {
  const out = { ok: false }, wait = async (f, ms = 20000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + f); await new Promise(r => setTimeout(r, 100)); } };
  try {
    await addSources(await scanFolderTauri(dir), 'self-test'); await wait(() => (lib.tracks.length || lib.renders.length) && lib.tracks.every(t => t.tagged));
    out.tracks = lib.tracks.length; out.renders = lib.renders.length; out.firstTitle = lib.sortedTracks()[0]?.title; out.cover = lib.tracks.some(t => !!t.coverUrl);
    if (lib.tracks.length) { await player.playList(lib.sortedTracks(), 0); await wait(() => player.playing && player.pos() > 0.7); let peak = 0; for (let i = 0; i < 20; i++) { const A = feed.update(0.05); peak = Math.max(peak, ...A.spectrum); await new Promise(r => setTimeout(r, 50)); } out.pos = player.pos(); out.peak = peak; out.mode = player.mode; }
    if (lib.renders.length) { await player.playList([lib.renders[0]], 0); await wait(() => player.mode === 'deck' && player.deck.stems.length > 0 && player.playing && player.pos() > 0.7); out.stems = player.deck.stems.length; }
    { await lib.flush(); const read = lib.stats.read, srcs = await scanFolder(dir); lib.clear(); lib.add(srcs); await wait(() => lib.tracks.every(t => t.tagged)); out.cachedRescan = lib.stats.read === read && lib.stats.cached >= out.tracks; out.cacheFiles = (await cache.stats()).files; await cache.putIndex(dir, srcs.map(x => ({ path: x.path, size: x.size, mtime: x.mtime }))); libs.addRoot(libs.target().id, dir); lib.clear(); const r0 = lib.stats.read; await restoreFromCache(); await wait(() => lib.tracks.every(t => t.tagged)); out.restored = lib.tracks.length === out.tracks && lib.renders.length === out.renders && lib.stats.read === r0; libs.removeRoot(libs.target().id, dir); await cache.delIndex(dir); }
    const sub = await TAURI.core.invoke('selftest_subsonic');
    if (sub) {      // a source plugin end to end: connect, scan, stream (WebKit can't read it cross-origin, so this exercises the HTTP plugin + blob fallback)
      const L = libs.target(), { config, title } = await getSource('subsonic').connect({ url: sub, username: 'alice', password: 'secret' }), conn = { id: 'st', plugin: 'subsonic', title, config }; libs.addConnection(L.id, conn);
      const r = await syncConnection(conn, L); out.remoteTracks = r.total; const rt = lib.tracks.find(t => t.remote); await player.playList([rt], 0); await wait(() => player.playing && player.pos() > 0.7); let pk = 0; for (let i = 0; i < 20; i++) { pk = Math.max(pk, ...feed.update(0.05).spectrum); await new Promise(r => setTimeout(r, 50)); } out.remotePeak = pk; out.remoteBlob = player.audio.src.startsWith('blob:');
    }
    await notes.store.setRating('selftest', 4); out.notesDb = (await notes.store.get('selftest')).rating === 4; await notes.store.setRating('selftest', 0);
    out.ok = true;
  } catch (e) { out.error = String(e && e.message || e); const a = player.audio; out.diag = { err: a.error && (a.error.code + ' ' + a.error.message), ready: a.readyState, net: a.networkState, paused: a.paused, ctx: feed.ctx && feed.ctx.state, src: (a.currentSrc || '').slice(0, 60), canFlac: a.canPlayType('audio/flac'), canMp3: a.canPlayType('audio/mpeg'), canM4a: a.canPlayType('audio/mp4') }; }
  await TAURI.core.invoke('selftest_done', { result: JSON.stringify(out) });
}

// ------------------------------------------------------------------ start
(async function init() {
  $('#sys').replaceChildren(TAURI ? h('span', {}, 'desktop') : h('span', {}, 'web'));
  await viz.init(); await lib.attachCache(cache).catch(() => {}); applySettings(); paintLibSel(); updateBar(); renderAll();
  const selfDir = TAURI ? await TAURI.core.invoke('selftest_config') : null; if (selfDir) selfTest(selfDir);
  else (async () => { await restoreFromCache(); if (settings.scanOnStart) await syncAll(true); else if (!lib.tracks.length && !lib.renders.length) await syncAll(true); })();   // in the background: the window is usable right away
  window.__bootleg = { sessionOf, libs, settings, cache, syncAll, notes, lib, player, viz, feed, addSources, show };       // for tests and the desktop self-test
})();
