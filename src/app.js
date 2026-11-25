// bootleg — the app. Library, queue, player bar, stem mixer and the visualizer view.
import { AudioFeed } from '/vendor/bootleg-vizualizer/core/audio.js';
import { Library } from '/lib/library.js';
import { Player } from '/lib/player.js';
import { VizHost } from '/lib/viz.js';
import { h } from '/lib/controls.js';
import { initNotes, trackKey, stars } from '/lib/notes-ui.js';
import { AUDIO_RE, sourcesFromFiles, webSource, scanFolderTauri, sourcesFromPathsTauri } from '/lib/source.js';

const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const fmt = s => { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const TAURI = window.__TAURI__;
const lib = new Library(), feed = new AudioFeed(), player = new Player(feed);
const viz = new VizHost({ stage: $('#vizStage'), packSelect: $('#packSelect'), paramsEl: $('#packParams'), lookEl: $('#lookParams'), feed, player });
function toast(msg, bad = false) { const t = h('div', { class: 'toast' + (bad ? ' bad' : '') }, msg); document.body.append(t); setTimeout(() => t.remove(), bad ? 6000 : 3000); }
const store = { get: (k, d) => { try { const v = localStorage.getItem('bootleg.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } }, set: (k, v) => { try { localStorage.setItem('bootleg.' + k, JSON.stringify(v)); } catch { /* private mode */ } } };

// ------------------------------------------------------------------ views
let view = 'tracks';
function show(v) {
  view = v; $$('.view').forEach(s => { s.hidden = s.id !== 'view-' + v; }); $$('.nav').forEach(b => b.classList.toggle('on', b.dataset.view === v));
  v === 'now' ? viz.start() : viz.stop(); if (v === 'now') buildStems(); renderAll();
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
  $('#emptyTracks').hidden = lib.tracks.length > 0; $('.thead').hidden = !lib.tracks.length;
}
function renderAlbums() {
  const q = $('#search').value.toLowerCase(), list = lib.albums().filter(a => !q || (a.album + ' ' + a.artist).toLowerCase().includes(q));
  $('#albumGrid').replaceChildren(...list.map(a => h('div', { class: 'card', title: 'Play album', onclick: () => player.playList(a.tracks, 0) }, cover(a.coverUrl), h('div', { class: 't' }, a.album), h('div', { class: 's' }, `${a.artist || ''}${a.artist ? ' · ' : ''}${a.tracks.length} tracks`))));
  $('#emptyAlbums').hidden = list.length > 0;
}
function renderRenders() {
  const list = lib.search(lib.renders, $('#search').value);
  $('#renderList').replaceChildren(...list.map(r => h('div', { class: 'rcard', onclick: () => player.playList([r], 0) }, cover(r.coverUrl), h('div', {}, h('div', { class: 'big' }, r.title),
    h('div', { class: 'muted small' }, [r.artist, r.bpm && Math.round(r.bpm) + ' BPM', r.key, r.duration && fmt(r.duration)].filter(Boolean).join(' · ')),
    h('div', { class: 'badges' }, h('span', { class: 'badge ok' }, `${r.stems.length} stems`), r.sections.length ? h('span', { class: 'badge' }, `${r.sections.length} sections`) : null, r.clips ? h('span', { class: 'badge' }, 'sample labels') : null)))));
  $('#emptyRenders').hidden = list.length > 0;
}
function renderAll() {
  $('#nTracks').textContent = lib.tracks.length || ''; $('#nRenders').textContent = lib.renders.length || ''; $('#nAlbums').textContent = lib.albums().length || '';
  if (view === 'tracks') renderTracks(); else if (view === 'albums') renderAlbums(); else if (view === 'renders') renderRenders();
  const left = lib._q.length + lib._busy; $('#status').textContent = left ? `Reading tags… ${left} left` : lib.tracks.length || lib.renders.length ? `${lib.tracks.length} tracks · ${lib.renders.length} renders` : '';
  $('#forget').hidden = !(TAURI && store.get('roots', []).length);
}
let rTimer = 0; lib.addEventListener('change', () => { if (rTimer) return; rTimer = setTimeout(() => { rTimer = 0; renderAll(); }, 250); });
$('#search').oninput = () => renderAll();

// ------------------------------------------------------------------ adding music
async function addSources(sources, label) {
  if (!sources.length) return toast('No music found there', true);
  const r = await lib.add(sources); toast(`${label || 'Added'}: ${r.tracks} tracks, ${r.renders} renders`); renderAll();
}
async function addFolderDesktop() {
  const dir = await TAURI.dialog.open({ directory: true, multiple: false, title: 'Add a music folder' }); if (!dir) return;
  const roots = store.get('roots', []); if (!roots.includes(dir)) { roots.push(dir); store.set('roots', roots); } await addSources(await scanFolderTauri(dir), 'Scanned');
}
async function addFilesDesktop() {
  const picked = await TAURI.dialog.open({ multiple: true, title: 'Add music files', filters: [{ name: 'Audio', extensions: ['mp3', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wav', 'aif', 'aiff', 'caf'] }] }); if (!picked) return;
  await addSources(await sourcesFromPathsTauri(Array.isArray(picked) ? picked : [picked]));
}
$('#addFolder').onclick = () => (TAURI ? addFolderDesktop().catch(e => toast(String(e), true)) : $('#folderIn').click());
$('#addFiles').onclick = () => (TAURI ? addFilesDesktop().catch(e => toast(String(e), true)) : $('#filesIn').click());
$('#folderIn').onchange = e => { addSources(sourcesFromFiles(e.target.files), 'Scanned'); e.target.value = ''; };
$('#filesIn').onchange = e => { addSources(sourcesFromFiles(e.target.files)); e.target.value = ''; };
$('#forget').onclick = () => { store.set('roots', []); lib.clear(); player.clear(); renderAll(); toast('Library forgotten'); };

// drag & drop: files and folders in the browser; paths from Tauri on the desktop
async function filesFromDrop(dt) {
  const out = [], walk = async (entry, base) => {
    if (entry.isFile) await new Promise(res => entry.file(f => { out.push(webSource(f, (base + f.name))); res(); }, res));
    else if (entry.isDirectory) { const rd = entry.createReader(); for (;;) { const batch = await new Promise((res, rej) => rd.readEntries(res, rej)); if (!batch.length) break; for (const c of batch) await walk(c, base + entry.name + '/'); } }
  };
  for (const it of dt.items || []) { const e = it.webkitGetAsEntry?.(); if (e) await walk(e, ''); }
  return out.filter(s => AUDIO_RE.test(s.name) || s.name === 'manifest.json' || s.name === 'clips.json');
}
addEventListener('dragover', e => { e.preventDefault(); document.body.classList.add('drop'); });
addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('drop'); });
addEventListener('drop', async e => { e.preventDefault(); document.body.classList.remove('drop'); if (!TAURI) addSources(await filesFromDrop(e.dataTransfer), 'Dropped'); });
if (TAURI?.event) TAURI.event.listen('tauri://drag-drop', async ev => {
  document.body.classList.remove('drop'); const sources = []; for (const p of ev.payload.paths || []) { try { const st = await TAURI.fs.stat(p); if (st.isDirectory) sources.push(...await scanFolderTauri(p)); else sources.push(...await sourcesFromPathsTauri([p])); } catch (err) { toast(String(err), true); } } addSources(sources, 'Dropped');
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

// ------------------------------------------------------------------ notes, ratings, playlists
async function saveText(name, text, mime) {
  if (TAURI?.dialog && TAURI?.fs?.writeTextFile) { const p = await TAURI.dialog.save({ defaultPath: name }); if (!p) return; await TAURI.fs.writeTextFile(p, text); toast('Saved ' + p.split('/').pop()); return; }
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: mime })), download: name }); document.body.append(a); a.click(); a.remove(); toast('Saved ' + name);
}
const notes = initNotes({ player, lib, h, fmt, toast, show, saveText, $ });

// ------------------------------------------------------------------ desktop self-test (BOOTLEG_SELFTEST=<music dir> BOOTLEG_SELFTEST_OUT=<file>): proves the packaged app can scan, tag, stream and analyse real files
async function selfTest(dir) {
  const out = { ok: false }, wait = async (f, ms = 20000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + f); await new Promise(r => setTimeout(r, 100)); } };
  try {
    await addSources(await scanFolderTauri(dir), 'self-test'); await wait(() => (lib.tracks.length || lib.renders.length) && lib.tracks.every(t => t.tagged));
    out.tracks = lib.tracks.length; out.renders = lib.renders.length; out.firstTitle = lib.sortedTracks()[0]?.title; out.cover = lib.tracks.some(t => !!t.coverUrl);
    if (lib.tracks.length) { await player.playList(lib.sortedTracks(), 0); await wait(() => player.playing && player.pos() > 0.7); let peak = 0; for (let i = 0; i < 20; i++) { const A = feed.update(0.05); peak = Math.max(peak, ...A.spectrum); await new Promise(r => setTimeout(r, 50)); } out.pos = player.pos(); out.peak = peak; out.mode = player.mode; }
    if (lib.renders.length) { await player.playList([lib.renders[0]], 0); await wait(() => player.mode === 'deck' && player.deck.stems.length > 0 && player.playing && player.pos() > 0.7); out.stems = player.deck.stems.length; }
    await notes.store.setRating('selftest', 4); out.notesDb = (await notes.store.get('selftest')).rating === 4; await notes.store.setRating('selftest', 0);
    out.ok = true;
  } catch (e) { out.error = String(e && e.message || e); }
  await TAURI.core.invoke('selftest_done', { result: JSON.stringify(out) });
}

// ------------------------------------------------------------------ start
(async function init() {
  $('#sys').replaceChildren(TAURI ? h('span', {}, 'desktop') : h('span', {}, 'web'));
  await viz.init(); updateBar(); renderAll();
  if (TAURI) for (const dir of store.get('roots', [])) { try { await lib.add(await scanFolderTauri(dir)); } catch (e) { console.warn('could not rescan', dir, e); } }
  if (TAURI) { const dir = await TAURI.core.invoke('selftest_config'); if (dir) selfTest(dir); }
  window.__bootleg = { notes, lib, player, viz, feed, addSources, show };       // for tests and the desktop self-test
})();
