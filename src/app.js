// bootleg — the app. Library, queue, player bar, stem mixer and the visualizer view.
import { AudioFeed } from '/vendor/bootleg-vizualizer/core/audio.js';
import { Library } from '/lib/library.js';
import { Player, TRANSITIONS, transitionOf } from '/lib/player.js';
import { initDJ } from '/lib/dj-panel.js';
import { VizHost } from '/lib/viz.js';
import { h, plural } from '/lib/controls.js';
import { MemoryBackend } from '/lib/notes.js';
import { VirtualList } from '/lib/vlist.js';
import { albumPane } from '/lib/album-pane.js';
import { albumKey } from '/lib/album-details.js';
import { initNotes, trackKey, stars, migrateRemoteKeys } from '/lib/notes-ui.js';
import { getSource, listSources, registerSource, unregisterSource } from '/lib/sources/index.js';
import { scanConnection, fromIndexEntry, toIndexEntry, rootKey } from '/lib/sources/remote.js';
import { RemoteAnnotations } from '/lib/sources/annotations.js';
import { openTagEditor } from '/lib/tag-editor.js';
import { TagFiles } from '/lib/tag-files.js';
import { openTagReview } from '/lib/tag-files-ui.js';
import { Extensions, nativeApi } from '/lib/extensions.js';
import { netFetch } from '/lib/sources/net.js';
import { Outputs } from '/lib/outputs/manager.js';
import { getOutput } from '/lib/outputs/index.js';
import { readTags } from '/lib/tags.js';
import { Libraries, MODES } from '/lib/libraries.js';
import { LibCache, NullCache } from '/lib/cache.js';
import { makeNativeTagReader, AUDIO_RE, wanted, sourcesFromFiles, webSource, tauriSource, scanFolderTauri, sourcesFromPathsTauri } from '/lib/source.js';
import { initNowView } from '/lib/now-view.js';
import { VizDock } from '/lib/viz-dock.js';
import { ListenHeat, SpectroCache, IdbKV, MapKV } from '/lib/listen-heat.js';
import { MiniHost } from '/lib/mini-host.js';
import { SHARE_DEFAULTS, openExternal } from '/lib/share.js';
import { playActions, PLAY_DEFAULTS, PLAY_MODELS, ALBUM_CLICKS } from '/lib/play-actions.js';
import { initDevices } from '/lib/devices-ui.js';
import { initOffline } from '/lib/offline-ui.js';
import { filesFor } from '/lib/devices.js';
import { registerProvider, listProviders, lookupAll, Chosen } from '/lib/metadata.js';
import { Secrets, connKey, splitConfig, fullConfig, migrateConnections } from '/lib/secrets.js';
import { VideoLinks } from '/lib/videos.js';
import { initVideos } from '/lib/videos-ui.js';

const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const fmt = s => { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const TAURI = window.__TAURI__;
const lib = new Library(), feed = new AudioFeed(), player = new Player(feed);
const viz = new VizHost({ stage: $('#vizStage'), packSelect: $('#packSelect'), paramsEl: $('#packParams'), lookEl: $('#lookParams'), feed, player });
function toast(msg, bad = false) { const t = h('div', { class: 'toast' + (bad ? ' bad' : '') }, msg); document.body.append(t); setTimeout(() => t.remove(), bad ? 6000 : 3000); }
lib.editKey = trackKey;      // tag edits made in bootleg are stored with the notes, under the same key
const editTags = (ts, title, suggest = null) => openTagEditor(ts, { h, store: notes.store, keyOf: trackKey, toast, title, suggest });
const acts = playActions(player, { model: () => settings.playModel, toast, plural });       // what ▶ / double-click do (Settings → Playing)
const SELF = window.__BOOTLEG_SELFTEST || null, mem = new Map();    // self-test mode: the shell injects this flag, and nothing below touches the real settings, library or notes
const store = SELF ? { get: (k, d) => (mem.has(k) ? JSON.parse(mem.get(k)) : d), set: (k, v) => { mem.set(k, JSON.stringify(v)); } } : { get: (k, d) => { try { const v = localStorage.getItem('bootleg.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } }, set: (k, v) => { try { localStorage.setItem('bootleg.' + k, JSON.stringify(v)); } catch { /* private mode */ } } };

// ------------------------------------------------------------------ views
let view = 'tracks', devices = null, offline = null;      // devices: the Devices page; offline: the offline store (both set up once the notes store exists)
// The visualizer stage sits over the Now playing tile or the Visualizer page, or floats as a mini player elsewhere (viz-dock.js).
const vizDock = new VizDock({ stage: $('#vizStage'), area: $('#main'), onChange: () => syncViz() });
// analysing while the stage shows, and on Now playing even with the tile scrolled away (the stem meters use the same analysis)
const vizShown = () => vizDock.visible || view === 'now';
function syncViz() { vizShown() ? viz.start() : viz.stop(); ensureForViz(); }
function placeViz() {
  const home = view === 'viz', side = $('#vizSide'); (home ? $('#vizSideHome') : $('#vizDrawer')).append(side); if (home) setDrawer(false);
  vizDock.place(view === 'now' ? $('#nowVizSlot') : home ? $('#vizSlot') : null, settings.vizFloat && !!player.item);
  $('#vizExpand').hidden = home; $('#vizGear').hidden = home; $('#vizFloat').classList.toggle('on', !!settings.vizFloat);
}
function setDrawer(open) { $('#vizDrawer').hidden = !open; $('#vizStage').classList.toggle('drawer', open); $('#vizGear').classList.toggle('on', open); }
function show(v) {
  view = v; $$('.view').forEach(s => { s.hidden = s.id !== 'view-' + v; }); $$('.nav').forEach(b => b.classList.toggle('on', b.dataset.view === v)); placeViz();
  syncViz(); if (v === 'videos') videosUI?.render($('#search').value); if (v === 'now') videosUI?.paintNow(); if (v === 'settings') { $('#settingsBody').replaceChildren(); paintSettings(); } if (v === 'notes' || v === 'playlists') { $('#noteCards').replaceChildren(); $('#plList').replaceChildren(); notes.paintLists(); } extViews.get(v)?.shown?.(); if (v === 'devices') devices?.shown(); renderAll();
}
const navClick = b => { b.onclick = () => show(b.dataset.view); }; $$('.nav').forEach(navClick); $('#np').onclick = () => show('now');
$('#vizGear').onclick = () => setDrawer($('#vizDrawer').hidden); $('#drawerClose').onclick = () => setDrawer(false);
$('#vizExpand').onclick = () => { if (document.fullscreenElement) document.exitFullscreen(); show('viz'); };
$('#vizFloat').onclick = () => { settings.vizFloat = !settings.vizFloat; applySettings(); placeViz(); toast(settings.vizFloat ? 'The mini visualizer stays in the corner while you browse' : 'Mini visualizer off'); };
$('#vizPop').onclick = () => $('#screenBtn').click();
addEventListener('fullscreenchange', () => vizDock.update());

// ------------------------------------------------------------------ lists
let shown = [];
const cover = (url, cls = 'cover') => url ? h('img', { class: cls, src: url, alt: '', loading: 'lazy' }) : h('div', { class: cls + ' ph' }, '♪');
// Recordings with defects (damaged rips and the like, plugin spec 2.0 §6): a ⚠ in the lists, searchable as has:defects.
const damaged = new Map();       // track key → defects
async function loadDamaged(key) {
  if (typeof key === 'string' && key !== '*') { const r = await notes.store.get(key); r.defects?.length ? damaged.set(key, r.defects) : damaged.delete(key); }
  else { damaged.clear(); for (const { key: k, value } of await notes.store.b.all()) if (k.startsWith('t:') && value.defects?.length) damaged.set(value.key, value.defects); }
  trackVL.schedule();
}
const defectChip = t => { const d = damaged.get(trackKey(t)); return d ? h('span', { class: 'chip defchip', title: `Damaged: ${d.length} stretch${d.length === 1 ? '' : 'es'} did not read cleanly (${[...new Set(d.map(x => x.kind))].join(', ')}). See Now playing.` }, '⚠') : ''; };
function trackRow(t, i) {
  return h('div', { class: 'row' + (player.item?.id === t.id ? ' playing' : ''), 'data-id': t.id, ondblclick: () => acts.activate(shown, i, true) },
    h('span', {}, h('span', { class: 'n' }, String(i + 1)), h('button', { class: 'pl', title: 'Play', onclick: () => acts.now(shown, i, true) }, '▶')),
    h('span', { class: 'tt' }, t.title, defectChip(t), videosUI?.chip(t), t.edited ? h('span', { class: 'chip', title: 'Tags edited in bootleg (the file/server is unchanged)' }, '✎') : '', t.kind === 'render' ? h('span', { class: 'chip stemchip', title: `A stem set: the mix plays instantly; ${t.stems.length} stems load on demand` }, `♫ ${t.stems.length} stems`) : ''), h('span', { class: 'muted' }, t.artist || ''), h('span', { class: 'muted' }, t.album || ''),
    h('span', { class: 'tm' }, t.duration ? fmt(t.duration) : ''), h('span', { class: 'acts' }, t.kind === 'track' ? h('button', { class: 'mini', title: 'Edit tags (in bootleg)', onclick: () => editTags([t]) }, 'edit') : '', h('button', { class: 'mini', onclick: () => { player.enqueue([t], true); toast('Plays next'); } }, 'next'), h('button', { class: 'mini', onclick: () => { player.enqueue([t]); toast('Added to queue'); } }, '+ queue')));
}
const trackVL = new VirtualList({ scroller: $('#view-tracks'), container: $('#trackList'), rowH: 38, render: (t, i) => trackRow(t, i) });
function renderTracks() {
  const q = $('#search').value, hasDef = /(^|\s)has:defects(\s|$)/.test(q), base = hasDef ? lib.sortedTracks().filter(t => damaged.has(trackKey(t))) : lib.sortedTracks();
  const next = lib.search(base, hasDef ? q.replace(/(^|\s)has:defects(\s|$)/, ' ').trim() : q); if (next !== shown) { shown = next; trackVL.setItems(shown); } else trackVL.schedule();
  $('#emptyTracks').hidden = lib.visibleItems.length > 0; $('.thead').hidden = !lib.visibleItems.length;
}
// ---- albums: grid / list / cover flow
let flowIdx = 0, openKey = null, listShown = null, gridLimit = 300, gridKey = null;
// Every album view shares one gesture: a click opens the album (shows its tracks) — or plays it, if Settings says so —
// and a double-click opens and plays. The second click of a double-click (e.detail 2) is left to the dblclick handler.
const albumGesture = (a, open) => ({
  onclick: e => { if (e.detail > 1) return; open(a, e); if (settings.albumClick === 'play') acts.activate(a.tracks); },
  ondblclick: e => { if (settings.albumClick === 'play') return; open(a, e, true); acts.activate(a.tracks); },
});
const albumVL = new VirtualList({ scroller: $('#albumList'), container: $('#albumListVc'), rowH: 52, render: a => { const i = albumInfo(a); return h('div', { class: 'arow' + (openKey === a.key ? ' sel' : ''), ...albumGesture(a, () => { openKey = a.key; renderAlbums(); }) },
  cover(a.coverUrl, 'cover sm'), h('span', { class: 'tt' }, a.album), h('span', { class: 'muted' }, a.artist || ''), h('span', { class: 'r muted' }, i.year || ''), h('span', { class: 'r muted' }, a.tracks.length), h('span', { class: 'r muted' }, i.dur ? hms(i.dur) : '')); } });
const albumInfo = a => { const yrs = a.tracks.map(t => +t.year).filter(Boolean), dur = a.tracks.reduce((n, t) => n + (t.duration || 0), 0); return { year: yrs.length ? Math.min(...yrs) : '', dur }; };
const hms = s => { s = Math.round(s); const hh = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return hh ? `${hh} h ${m} min` : `${m} min`; };
function albumTracks(a) {
  return h('div', { class: 'atracks' }, ...a.tracks.map((t, i) => h('div', { class: 'atrack' + (player.item?.id === t.id ? ' playing' : ''), 'data-id': t.id, ondblclick: () => acts.activate(a.tracks, i, true) },
    h('span', { class: 'n' }, String(t.track || i + 1)), h('span', { class: 'tt' }, t.title), h('span', { class: 'muted' }, t.artist && t.artist !== a.artist ? t.artist : ''), h('span', { class: 'tm' }, t.duration ? fmt(t.duration) : ''),
    h('span', { class: 'acts' }, h('button', { class: 'mini', onclick: () => acts.now(a.tracks, i, true) }, '▶'), h('button', { class: 'mini', title: 'Edit tags (in bootleg)', onclick: () => editTags([t]) }, 'edit'), h('button', { class: 'mini', onclick: () => { player.enqueue([t]); toast('Added to queue'); } }, '+ queue')))));
}
function albumActions(a) {
  return h('div', { class: 'cbtns' }, h('button', { class: 'btn primary', onclick: () => acts.now(a.tracks) }, '▶ Play album'),
    h('button', { class: 'btn', onclick: () => acts.now(a.tracks.slice().sort(() => Math.random() - 0.5)) }, 'Shuffle'), h('button', { class: 'btn', onclick: () => { player.enqueue(a.tracks); toast(`Queued ${plural(a.tracks.length, 'track')}`); } }, '+ Queue'), h('button', { class: 'btn', title: 'Album, artist, year and genre for every track (in bootleg)', onclick: () => editTags(a.tracks, `Edit album — ${a.album}`) }, '✎ Edit album'));
}
function albumHead(a) { const i = albumInfo(a); return h('div', { class: 'ahead' }, cover(a.coverUrl, 'cover big'), h('div', {}, h('div', { class: 'big' }, a.album), h('div', { class: 'muted' }, [a.artist, i.year, plural(a.tracks.length, 'track'), i.dur ? hms(i.dur) : ''].filter(Boolean).join(' · ')), albumActions(a))); }
// Grid: an opened album unfolds in a full-width panel under its row (the cards after it backfill the row — CSS
// grid-auto-flow: dense), so the card you clicked stays where it was and a double-click lands on it again.
function paintGrid(items) {
  const open = items.find(a => a.key === gridKey); if (!open) gridKey = null; const out = [];
  for (const a of items) {
    out.push(h('div', { class: 'card' + (a === open ? ' sel' : ''), 'data-key': a.key, title: settings.albumClick === 'play' ? 'Play album' : 'Show tracks · double-click to play', ...albumGesture(a, openGridAlbum) }, cover(a.coverUrl), h('div', { class: 't' }, a.album), h('div', { class: 's' }, `${a.artist || ''}${a.artist ? ' · ' : ''}${plural(a.tracks.length, 'track')}`)));
    if (a === open) out.push(h('div', { class: 'adetail ginline', role: 'region', 'aria-label': a.album }, h('button', { class: 'link gclose', title: 'Close (Esc)', 'aria-label': 'Close', onclick: () => { gridKey = null; renderAlbums(); } }, '✕'), albumHead(a), albumTracks(a)));
  }
  $('#albumGrid').replaceChildren(...out);
}
function openGridAlbum(a, e, keep = false) {
  const scroller = $('#view-albums'), y0 = e?.currentTarget?.getBoundingClientRect().top;
  gridKey = keep || gridKey !== a.key ? a.key : null; renderAlbums();          // a click on the open album folds it away
  const card = $(`#albumGrid .card[data-key="${CSS.escape(a.key)}"]`); if (card && y0 != null) scroller.scrollTop += card.getBoundingClientRect().top - y0;   // a panel closing above must not move the card under the pointer
  if (gridKey) setTimeout(() => {           // after the double-click window: then bring as much of the panel into view as fits, its top first
    const p = $('#albumGrid .ginline'); if (!p) return; const r = p.getBoundingClientRect(), v = scroller.getBoundingClientRect();
    if (r.bottom > v.bottom) scroller.scrollBy({ top: Math.min(r.bottom - v.bottom + 12, r.top - v.top - 8), behavior: 'smooth' });
  }, 450);
}
function renderAlbums() {
  const mode = settings.albumView, q = $('#search').value.toLowerCase(), list = lib.albums().filter(a => !q || (a.album + ' ' + a.artist).toLowerCase().includes(q));
  $$('#albumMode button').forEach(b => b.classList.toggle('on', b.dataset.mode === mode)); $('#albumGrid').hidden = mode !== 'grid'; $('#albumList').hidden = mode !== 'list'; $('#albumFlow').hidden = mode !== 'flow'; $('#albumSplit').hidden = mode !== 'split'; $('#emptyAlbums').hidden = list.length > 0;
  if (openKey && !list.some(a => a.key === openKey)) openKey = null;
  if (mode === 'split') { $('#albumDetail').hidden = true; renderSplit(list); return; }
  if (mode === 'grid') { $('#albumDetail').hidden = true; if (list.length > gridLimit) { $('#albumGrid').dataset.more = '1'; } else delete $('#albumGrid').dataset.more; paintGrid(list.slice(0, gridLimit)); return; }
  if (mode === 'list') {
    if (!openKey) openKey = list[0]?.key; if (listShown !== list) { listShown = list; albumVL.setItems(list); } else albumVL.paint(true);
    const cur = list.find(x => x.key === openKey), det = $('#albumDetail'); det.hidden = !cur; if (cur) det.replaceChildren(albumHead(cur), albumTracks(cur));
    return;
  }
  // cover flow: a 3D carousel around the selected album. Cover elements persist between moves so the browser animates
  // transform/opacity on the GPU compositor (no layout, no repaint); only the few covers near the centre exist at all.
  const flow = $('#albumFlow'), det = $('#albumDetail'); flowIdx = Math.max(0, Math.min(list.length - 1, flowIdx));
  if (!list.length) { flow.replaceChildren(); det.hidden = true; return; }
  if (!flow._parts) {
    const stage = h('div', { class: 'flow', tabindex: 0, 'aria-label': 'Cover flow: arrow keys or scroll to browse' }), cap = h('div', { class: 'fcap' }), scrub = h('input', { type: 'range', class: 'fscrub', min: 0, value: 0, 'aria-label': 'Browse albums', oninput: e => { flowIdx = +e.target.value; renderAlbums(); } });
    stage.onwheel = e => { e.preventDefault(); const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY; if (Math.abs(d) < 4) return; const now = performance.now(); if (now - (stage._t || 0) < 90) return; stage._t = now; flowIdx += d > 0 ? 1 : -1; renderAlbums(); };
    stage._els = new Map(); flow._parts = { stage, cap, scrub }; flow.replaceChildren(stage, cap, scrub);
  }
  const { stage, cap, scrub } = flow._parts, W = 8, want = new Set();
  for (let i = Math.max(0, flowIdx - W); i <= Math.min(list.length - 1, flowIdx + W); i++) {
    const a = list[i], off = i - flowIdx, sgn = Math.sign(off); want.add(a.key); let el = stage._els.get(a.key);
    if (!el) { el = h('div', { class: 'fitem', title: a.album }, cover(a.coverUrl, 'fcover'), h('div', { class: 'frefl' })); stage._els.set(a.key, el); stage.append(el); if (a.coverUrl) el.querySelector('.frefl').style.backgroundImage = `url("${a.coverUrl}")`; el.style.transition = 'none'; }
    // a side cover comes to the centre; the centre one shows its tracks below (or plays, per Settings → Playing)
    el._i = i; el._a = a; Object.assign(el, albumGesture(a, () => { if (el._i !== flowIdx) { flowIdx = el._i; renderAlbums(); } else $('#albumDetail').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); })); el.classList.toggle('center', off === 0);
    el.style.transform = off === 0 ? 'translate3d(-50%, 0, 60px)' : `translate3d(calc(-50% + ${sgn * 150 + off * 64}px), 0, ${-Math.abs(off) * 40}px) rotateY(${-sgn * 58}deg)`; el.style.zIndex = String(100 - Math.abs(off)); el.style.opacity = String(Math.max(0.15, 1 - Math.abs(off) * 0.11));
    if (el.style.transition === 'none') requestAnimationFrame(() => requestAnimationFrame(() => { el.style.transition = ''; }));
  }
  for (const [k, el] of stage._els) if (!want.has(k)) { el.remove(); stage._els.delete(k); }
  const cur = list[flowIdx], info = albumInfo(cur); cap.replaceChildren(h('div', { class: 'big' }, cur.album), h('div', { class: 'muted' }, [cur.artist, info.year].filter(Boolean).join(' · ')));
  scrub.max = Math.max(0, list.length - 1); scrub.value = flowIdx;
  det.hidden = false; det.replaceChildren(albumHead(cur), albumTracks(cur));
}

// ---- split view: album list on the left; cover, merged details, album notes and tracks on the right
let splitKey = null, splitToken = 0;
const splitVL = new VirtualList({ scroller: $('#splitList'), container: $('#splitVc'), rowH: 54, render: a => h('div', { class: 'srow2' + (a.key === splitKey ? ' sel' : ''), ...albumGesture(a, () => { if (splitKey === a.key) return; splitKey = a.key; splitVL.paint(true); paintSplitPane(); }) }, cover(a.coverUrl, 'cover sm'), h('div', { class: 'stext' }, h('div', { class: 'tt' }, a.album), h('div', { class: 'muted small' }, [a.artist, albumInfo(a).year].filter(Boolean).join(' · ')))) });
let splitShown = null;
function renderSplit(list) {
  const pane = $('#splitPane'); if (!list.length) { splitVL.setItems([]); pane.replaceChildren(); return; }
  if (!list.some(a => a.key === splitKey)) splitKey = list[0].key;
  if (splitShown !== list) { splitShown = list; splitVL.setItems(list); } else splitVL.paint(true);
  paintSplitPane(list);
}
async function paintSplitPane(list = lib.albums().filter(a => { const q = $('#search').value.toLowerCase(); return !q || (a.album + ' ' + a.artist).toLowerCase().includes(q); })) {
  const a = list.find(x => x.key === splitKey); if (!a) return; const tok = ++splitToken;
  const el = await albumPane(a, { libs, lib, store: notes.store, player, h, fmt, toast, cover, acts, editTags, trackStore: t => notes.store.get(trackKey(t)), offline, meta: { providers: listProviders, chosen: metaChosen, lookup: q => lookupAll(q), open: openExternal, repaint: () => paintSplitPane() } });
  if (tok === splitToken) { const pane = $('#splitPane'), keep = pane.scrollTop; pane.replaceChildren(el); pane.scrollTop = keep; }
}
$('#view-albums').addEventListener('scroll', () => { const v = $('#view-albums'); if (settings.albumView === 'grid' && $('#albumGrid').dataset.more && v.scrollTop + v.clientHeight > v.scrollHeight - 700) { gridLimit += 300; renderAlbums(); } }, { passive: true });
$$('#albumMode button').forEach(b => { b.onclick = () => { settings.albumView = b.dataset.mode; applySettings(); renderAlbums(); }; });

function renderRenders() {
  const list = lib.search(lib.visibleRenders, $('#search').value);
  $('#renderList').replaceChildren(...list.map(r => h('div', { class: 'rcard', onclick: () => acts.activate([r]) }, cover(r.coverUrl), h('div', {}, h('div', { class: 'big' }, r.title),
    h('div', { class: 'muted small' }, [r.artist, r.bpm && Math.round(r.bpm) + ' BPM', r.key, r.duration && fmt(r.duration)].filter(Boolean).join(' · ')),
    h('div', { class: 'badges' }, h('span', { class: 'badge ok' }, `${r.stems.length} stems`), r.sections.length ? h('span', { class: 'badge' }, `${r.sections.length} sections`) : null, r.clipsSrc ? h('span', { class: 'badge' }, 'sample labels') : null)))));
  $('#emptyRenders').hidden = list.length > 0;
}
let albumCount = 0, videosUI = null;      // videosUI: music videos (videos-ui.js), set up with Now playing below
function renderAll() {
  const vt = lib.visibleTracks.length, vr = lib.visibleRenders.length, vi = lib.visibleItems.length; $('#nTracks').textContent = vi || ''; $('#nRenders').textContent = vr || ''; if (!(lib._q.length + lib._busy) || view === 'albums') albumCount = lib.albums().length; $('#nAlbums').textContent = albumCount || '';
  if (view === 'tracks') renderTracks(); else if (view === 'albums') renderAlbums(); else if (view === 'renders') renderRenders(); videosUI?.render($('#search').value);
  const left = lib._q.length + lib._busy; $('#status').textContent = left ? `Reading tags… ${left} left` : vt || vr ? `${plural(vt, 'track')} · ${plural(vr, 'stem set')}` : '';
}
// while tags stream in, redraw less often (each redraw of a big library is work a weaker machine can't spare)
let rTimer = 0; lib.addEventListener('change', () => { if (rTimer) return; rTimer = setTimeout(() => { rTimer = 0; renderAll(); }, lib._q.length + lib._busy ? 900 : 200); });
$('#search').oninput = () => { gridLimit = 300; renderAll(); };

// ------------------------------------------------------------------ adding music
const libs = new Libraries(store), secrets = new Secrets({ invoke: TAURI ? (c, a) => TAURI.core.invoke(c, a) : null, store }); lib.scope = libs.active; player.hooks.loadClips = r => lib.loadClips(r);
let metaChosen; try { metaChosen = new Chosen(SELF || !window.indexedDB ? new MapKV() : new IdbKV('bootleg-metadata', ['chosen'])); } catch { metaChosen = new Chosen(new MapKV()); }      // the release chosen for each album (metadata.js)
if (TAURI) lib.nativeReader = makeNativeTagReader(() => [...lib._covers.keys()]);
const DEFAULTS = { ...PLAY_DEFAULTS, ...SHARE_DEFAULTS, transition: 'gapless', matchTempo: false, djFade: 6, spectro: 'all', vizFloat: false, vizVideo: true, miniOnMinimize: true, tagWrite: false, tagWriteHours: 0, includeRenders: true, stemsLoad: 'visualizer', albumView: 'grid', cacheEnabled: true, scanOnStart: true, rescanMinutes: 0, tagConcurrency: 6, useNfo: true, nfoFill: true };
const settings = { ...DEFAULTS, ...store.get('settings', {}) };
let cache; try { cache = SELF ? new LibCache('bootleg-selftest-' + Date.now()) : settings.cacheEnabled ? new LibCache() : new NullCache(); } catch { cache = new NullCache(); }
function applySettings() { const inc = lib.includeRenders; lib.includeRenders = settings.includeRenders !== false; if (inc !== lib.includeRenders) lib._changed(); player.stemPolicy = settings.stemsLoad; applyTransition(); lib.concurrency = Math.max(1, Math.min(32, +settings.tagConcurrency || 6)); lib.setNfoOptions({ useNfo: settings.useNfo, nfoFill: settings.nfoFill }); store.set('settings', settings); armRescan(); }
function applyTransition() { const t = transitionOf(settings.transition, settings.matchTempo), c = player.transition; if (t.mode !== c.mode || t.seconds !== c.seconds || t.match !== c.match) player.setTransition(t); }
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
  const picked = await TAURI.dialog.open({ multiple: true, title: 'Add music files', filters: [{ name: 'Audio and songs', extensions: ['mp3', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wav', 'aif', 'aiff', 'caf', 'bstem', 'bsong', 'dawproject'] }] }); if (!picked) return;
  await addSources(await sourcesFromPathsTauri(Array.isArray(picked) ? picked : [picked]));
}
$('#addFolder').onclick = () => (TAURI ? addFolderDesktop().catch(e => toast(String(e), true)) : $('#folderIn').click());
$('#addFiles').onclick = () => (TAURI ? addFilesDesktop().catch(e => toast(String(e), true)) : $('#filesIn').click());
$('#folderIn').onchange = e => { addSources(sourcesFromFiles(e.target.files), 'Scanned'); e.target.value = ''; };
$('#filesIn').onchange = e => { addSources(sourcesFromFiles(e.target.files)); e.target.value = ''; };
const scopeRoots = () => { const ls = libs.active === 'all' ? libs.list : [libs.get(libs.active)].filter(Boolean); return ls.flatMap(L => [...L.roots, ...L.connections]).map(x => ({ root: x })); };
async function forgetLibrary(L) { for (const c of [...L.connections]) await removeConnection(L, c); for (const r of [...L.roots]) { libs.removeRoot(L.id, r); if (!libs.ofRoot(r)) await cache.delIndex(r).catch(() => {}); } lib.dropLibrary(L.id); }
const forgetActive = async () => { const targets = libs.active === 'all' ? libs.list : [libs.get(libs.active)]; for (const L of targets) await forgetLibrary(L); player.clear(); renderAll(); paintLibSel(); toast(libs.active === 'all' ? 'All libraries forgotten' : 'Library forgotten'); };
function paintLibSel() {
  const sel = $('#libSel'); sel.replaceChildren(...libs.list.map(l => h('option', { value: l.id, selected: l.id === libs.active }, `${l.name}${l.mode === 'studio' ? ' ✎' : ''}`)), libs.list.length > 1 ? h('option', { value: 'all', selected: libs.active === 'all' }, 'All libraries') : null); sel.hidden = false; sel.value = libs.active;
}
$('#libSel').onchange = e => { libs.setActive(e.target.value); lib.scope = libs.active; renderAll(); notes?.refresh?.(); };

// Desktop: show the whole library from the cache immediately, then look for changes in the background.
const sessionOf = r => { const c = libs.connection(r.conn), p = getSource(r.plugin); return c && p ? p.session(fullConfig(secrets, c)) : null; };
async function loadChunked(srcs, libId) {      // shows the cached library in slices so the window stays responsive
  scan.on = true; try { await lib.addChunked(srcs, libId, { onProgress: (n, total) => { scan.text = `Loading your library… ${n.toLocaleString()} of ${total.toLocaleString()}`; renderAll(); } }); } finally { scan.on = false; }
}
async function restoreFromCache(only = null) {      // only: a source plugin's id (it was just turned on): just its connections
  for (const ix of await cache.indexes()) {
    if (only && !ix.root.startsWith(only + ':')) continue;
    const owner = libs.ofRoot(ix.root); if (!owner) continue;
    try {
      if (ix.entries[0]?.remote) { await loadChunked(ix.entries.map(e => fromIndexEntry(e, getSource, sessionOf)).filter(Boolean), owner.id); continue; }     // a source plugin's library: no disk, no network needed
      if (!TAURI) continue; await TAURI.core.invoke('allow_path', { path: ix.root }); await loadChunked(ix.entries.map(e => tauriSource(e.path, e.size, e.mtime)), owner.id);
    } catch (e) { console.warn('cached root unavailable', ix.root, e); }
  } renderAll();
}
// A packaged plugin's source (api.sources.register, PLUGIN-SPEC §5): while the plugin runs, its connections are libraries
// like Subsonic's. Turned on after startup: its cached tracks come back at once. Turned off: they leave the library (the
// cache, the connections and their keychain entries stay, for when it is turned on again).
function registerPluginSource(p) {
  registerSource(p); if (libraryStarted) restoreFromCache(p.id).catch(e => console.warn('restore', p.id, e));
  if (view === 'settings') paintSettings();
  return () => {
    if (getSource(p.id) !== p) return; unregisterSource(p.id);
    for (const { conn, lib: L } of libs.allConnections()) if (conn.plugin === p.id) lib.removeMissing(rootKey(p, conn.id), new Set(), L.id);
    renderAll(); if (view === 'settings') paintSettings();
  };
}
// Startup: the cached library shows at once, then changes are looked for in the background (the window is usable throughout).
// (0.2.0–0.3.0 skipped this on the desktop: opening files from the OS took its place instead of running beside it.)
let libraryStarted = false;
async function startLibrary() { libraryStarted = true; await restoreFromCache(); if (settings.scanOnStart || (!lib.tracks.length && !lib.renders.length)) await syncAll(true); }
// A new connection: its secret fields (the source plugin's `secrets`) go to the keychain, the rest is saved with the library.
async function addConnection(L, p, vals, id = 'c' + Date.now().toString(36)) {
  const r = await p.connect(vals), { config, secret } = splitConfig(p, r.config), conn = { id, plugin: p.id, title: r.title, config };
  await secrets.setJSON(connKey(conn), secret); libs.addConnection(L.id, conn); return conn;
}
async function removeConnection(L, c) { libs.removeConnection(L.id, c.id); await secrets.delete(connKey(c)).catch(e => console.warn('secret', e)); await cache.delIndex(`${c.plugin}:${c.id}`).catch(() => {}); await remoteAnn.forget(c.plugin, c.id); }
async function syncConnection(conn, L) {
  const p = getSource(conn.plugin); if (!p) throw new Error(`The “${conn.plugin}” source plugin is not installed`);
  const key = rootKey(p, conn.id); scan.on = true; scan.text = 'Connecting…'; paintProgress();
  try {
    const ses = p.session(fullConfig(secrets, conn)), srcs = await scanConnection(p, ses, conn.id, { onProgress: t => { scan.text = t; } }); const before = lib.tracks.length; lib.add(srcs, L.id); const removed = lib.removeMissing(key, new Set(srcs.map(x => x.path)), L.id); await cache.putIndex(key, srcs.map(toIndexEntry));
    // ratings, stars and playlists the server keeps (a failure here never fails the scan itself)
    scan.text = 'Syncing ratings and playlists…'; const tracks = srcs.map(x => { const t = lib._byPath.get(x.path); return t?.kind === 'track' ? { key: trackKey(t), item: x.remote.item } : t?.kind === 'render' && x.remote.item.song ? { key: trackKey(t), item: x.remote.item.song } : null; }).filter(Boolean);      // a server's stem sets: their song carries the grade
    try { await remoteAnn.pull(p, conn.id, ses, tracks); } catch (e) { toast(`${conn.title}: could not sync ratings/playlists (${e.message || e})`, true); }
    await tagFiles?.prune().catch(() => {});      // edits the server now agrees with (it re-read files bootleg wrote) are no longer needed
    return { added: Math.max(0, lib.tracks.length - before), removed, total: srcs.length };
  }
  finally { scan.on = false; }
}
// One sync at a time. A request that comes while one runs (e.g. "check for changes" during the scan on start) waits
// for it and then runs once more, so changes made meanwhile are not missed; several such requests share that one run.
let syncing = null, syncAgain = null;
function syncAll(quiet = false) {
  if (!TAURI && !libs.allConnections().length) return Promise.resolve();
  if (syncing) return syncAgain ||= syncing.then(() => { syncAgain = null; return syncAll(quiet); });
  return syncing = syncOnce(quiet).finally(() => { syncing = null; });
}
async function syncOnce(quiet) {
  let added = 0, removed = 0;
  try { for (const { conn, lib: L } of libs.allConnections()) { try { const r = await syncConnection(conn, L); added += r.added; removed += r.removed; } catch (e) { toast(`${conn.title}: ${e.message || e}`, true); } } }
  catch { /* handled per connection */ }
  try { if (TAURI) for (const { root, lib: L } of libs.allRoots()) { try { const before = lib.tracks.length, srcs = await scanFolder(root, 'Checking for changes in'); lib.add(srcs, L.id); removed += lib.removeMissing(root, new Set(srcs.map(x => x.path)), L.id); added += Math.max(0, lib.tracks.length - before); await cache.putIndex(root, srcs.map(x => ({ path: x.path, size: x.size, mtime: x.mtime }))); } catch (e) { console.warn('could not rescan', root, e); } } }
  finally { /* syncing is cleared by syncAll */ }
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

// Files opened from the OS (Finder/Explorer “Open With”, bootleg as the default player, `bootleg song.flac`): the shell keeps
// them in an inbox until the page takes them. They join this session's library (so tags, cover and notes work, and a file
// already in the library is that same track) and play straight away, as ▶ does.
async function openFromOS() {
  const paths = await TAURI.core.invoke('take_opened'); if (!paths.length) return;
  lib.add(await sourcesFromPathsTauri(paths), libs.target().id);
  const items = paths.map(p => { const t = lib._byPath.get(p); return t && t.kind === 'track' ? t : lib.renders.find(r => r.mix?.path === p || r.pkgSrc?.path === p); }).filter(Boolean);
  for (let i = 0; i < 100 && items.some(r => r.pkgSrc && !r.pkg && !r.broken); i++) await new Promise(ok => setTimeout(ok, 50));      // a package's parts are read first
  if (items.length) { await acts.now(items); renderAll(); } else toast('bootleg could not open that file', true);
}
if (TAURI?.event && !SELF) TAURI.event.listen('bootleg://opened', () => openFromOS().catch(e => toast(String(e), true)));

// ------------------------------------------------------------------ player bar
const playBtn = $('#play'), seek = $('#seek');
function updateBar() {
  const it = player.item, playing = player.playing; playBtn.textContent = playing ? '⏸' : '▶'; playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  $('#npTitle').textContent = it ? it.title : 'Nothing playing'; $('#npSub').textContent = it ? [it.artist, it.album].filter(Boolean).join(' · ') + (player.loading ? ` — loading stems ${player.loading.n}/${player.loading.total}…` : '') : '';
  const c = $('#npCover'); if (it && it.coverUrl) { c.src = it.coverUrl; c.hidden = false; } else c.hidden = true;
  $('#shuffle').classList.toggle('on', player.shuffle); const rp = $('#repeat'); rp.classList.toggle('on', player.repeat !== 'off'); rp.textContent = player.repeat === 'one' ? '⟲1' : '⟲'; rp.title = 'Repeat: ' + player.repeat;
  $('#qCount').textContent = player.queue.length || ''; $$('.row').forEach(r => r.classList.toggle('playing', it && r.dataset.id === it.id)); $('#vizMsg').textContent = it ? '' : 'Play something to see it react. Until then the pack plays its idle demo.';
  $('#stageTitle').textContent = it ? `${it.title}${it.artist ? ' — ' + it.artist : ''}` : ''; renderQueue(); buildStems(); placeViz(); ensureForViz();
}
player.addEventListener('change', updateBar);
// ------------------------------------------------------------------ DJ mode
const dj = initDJ({ player, h, fmt, settings, onSettings: patch => { Object.assign(settings, patch); applySettings(); } });
$('footer.bar').before(dj.el);
function syncDJ() { const on = player.dj; if (dj.el.hidden === on) dj.show(on); $('#djBtn').classList.toggle('on', on); }
player.addEventListener('change', syncDJ);
$('#djBtn').onclick = () => player.setDJ(!player.dj);
player.addEventListener('playerror', e => toast(e.detail, true));      // never fail silently: say why nothing is playing
let drag = false; seek.oninput = () => { drag = true; }; seek.onchange = () => { const d = player.dur(); if (d) player.seek(seek.value / 1000 * d); drag = false; };
(function loop() { const d = player.dur(), p = player.pos(); if (!drag) seek.value = d ? Math.round(p / d * 1000) : 0; vizDock.update(); dj.paint(); $('#tcur').textContent = fmt(p); $('#tdur').textContent = fmt(d); paintMeters(); requestAnimationFrame(loop); })();
playBtn.onclick = () => { if (!player.item) { if (shown.length) player.playList(shown, 0); else if (lib.renders.length) player.playList(lib.renders, 0); return; } player.toggle(); };
$('#prev').onclick = () => player.prev(); $('#next').onclick = () => player.next();
$('#shuffle').onclick = () => player.setShuffle(!player.shuffle); $('#repeat').onclick = () => player.setRepeat({ off: 'all', all: 'one', one: 'off' }[player.repeat]);
const vol = $('#volume'); vol.value = player.volume; vol.oninput = () => player.setVolume(+vol.value);

// ------------------------------------------------------------------ queue
function renderQueue() {
  const q = player.queue, list = $('#queueList'); $('#queueEmpty').hidden = q.length > 0;
  list.replaceChildren(...q.map((t, i) => h('div', { class: 'qi' + (i === player.index ? ' cur' : ''), onclick: () => player.jump(i) }, h('div', { style: 'min-width:0' }, h('div', { class: 't' }, t.title), h('div', { class: 's' }, t.artist || (t.kind === 'render' ? 'stem render' : ''))), h('span', { class: 'qb' }, ...(player.dj ? [h('button', { class: 'mini', title: 'Load onto deck A', onclick: e => { e.stopPropagation(); player.djLoad(player.A, t); } }, 'A'), h('button', { class: 'mini', title: 'Load onto deck B', onclick: e => { e.stopPropagation(); player.djLoad(player.B, t); } }, 'B')] : []), h('button', { class: 'mini', title: 'Remove', onclick: e => { e.stopPropagation(); player.remove(i); } }, '✕')))));
}
$('#qToggle').onclick = () => { const q = $('#queue'); q.hidden = !q.hidden; $('#qToggle').classList.toggle('on', !q.hidden); }; $('#qClear').onclick = () => player.clear();

// ------------------------------------------------------------------ stems mixer
let stemEls = [];
function buildStems() {
  const it = player.item, deck = player.deck, panel = $('#stemsPanel'), st = player.stemsState, isRender = !!it && it.kind === 'render'; panel.hidden = !isRender; if (!isRender) { stemEls = []; return; }
  if (st !== 'ready' || !deck.stems.length) {       // playing the mix: stems are loaded on demand (they take memory)
    stemEls = []; $('#stemsHint').textContent = '';
    $('#stemRows').replaceChildren(h('div', { class: 'stemload' }, h('span', { class: 'muted' }, st === 'loading' ? `Loading stems… ${player.loading?.n || 0} of ${player.loading?.total || it.stems.length}` : `Playing the mix. Load the ${it.stems.length} stems to mute, solo and give stem-aware visualizers real per-stem data (uses memory while loaded).`), st === 'unloaded' ? h('button', { class: 'btn primary', id: 'loadStems', onclick: () => player.ensureStems() }, 'Load stems') : ''));
    return;
  }
  if (stemEls.length === deck.stems.length && stemEls[0].deckStem === deck.stems[0]) return;       // already built for this render
  $('#stemsHint').replaceChildren('M mute · S solo · the visualizer follows each stem · ', h('button', { class: 'link', id: 'unloadStems', title: 'Go back to playing the mix and free the memory', onclick: () => player.unloadStems() }, `unload (${deck.memoryMB} MB)`)); stemEls = [];
  $('#stemRows').replaceChildren(...deck.stems.map(s => {
    const meter = h('i'), lbl = h('div', { class: 'lbl' }), m = h('button', { class: 'btn ms m', title: 'Mute', onclick: () => { s.mute = !s.mute; deck.applyGains(); sync(); } }, 'M'), so = h('button', { class: 'btn ms s', title: 'Solo', onclick: () => { s.solo = !s.solo; deck.applyGains(); sync(); } }, 'S');
    const trim = h('input', { type: 'range', min: -24, max: 6, step: 0.5, value: 0, title: 'trim (dB)', oninput: () => { s.trimDb = +trim.value; deck.applyGains(); } });
    const row = h('div', { class: 'stem' }, h('div', {}, h('div', { class: 'nm' }, s.name), h('div', { class: 'role' }, s.role)), h('span'), h('div', {}, h('div', { class: 'meter' }, meter), lbl), trim, m, so);
    const sync = () => { m.classList.toggle('on', s.mute); so.classList.toggle('on', s.solo); $$('.stem').forEach((el, i) => el.classList.toggle('dim', !(!deck.stems[i].mute && (!deck.stems.some(x => x.solo) || deck.stems[i].solo)))); };
    row.deckStem = s; row._r = { meter, lbl }; stemEls.push(row); return row;
  }));
}
// A stem-aware visualizer (pack.json usesStems) is on screen: it deserves the real stems.
function ensureForViz() { const it = player.item; if (it && it.kind === 'render' && settings.stemsLoad === 'visualizer' && vizShown() && viz.pack?.usesStems) player.ensureStems(); }
viz.onPack = ensureForViz;
function paintMeters() {
  if (view !== 'now' || !stemEls.length || !viz.lastA || !viz.lastA.stems) return; const by = Object.fromEntries(viz.lastA.stems.map(s => [s.name, s]));
  for (const row of stemEls) { const st = by[row.deckStem.name]; if (!st) continue; row._r.meter.style.width = Math.round(st.level * 100) + '%'; row._r.lbl.textContent = st.label ? `${st.label}${st.kit ? ' — ' + st.kit : ''}` : ''; }
}
$('#fsBtn').onclick = () => (document.fullscreenElement ? document.exitFullscreen() : viz.fullscreen()); $('#lookReset').onclick = () => viz.resetLook();

// ------------------------------------------------------------------ keyboard
addEventListener('keydown', e => {
  const typing = /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) && document.activeElement.type !== 'range' && document.activeElement.type !== 'checkbox';
  if (e.key === '/' && !typing) { e.preventDefault(); $('#search').focus(); return; } if (typing) { if (e.key === 'Escape') document.activeElement.blur(); return; }
  if (e.key === 'Escape' && view === 'albums' && gridKey) { gridKey = null; renderAlbums(); return; }
  if (e.code === 'Space') { e.preventDefault(); playBtn.click(); }
  else if (view === 'albums' && settings.albumView === 'flow' && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) { flowIdx += e.key === 'ArrowRight' ? 1 : -1; renderAlbums(); }
  else if (e.key === 'ArrowRight') { e.shiftKey ? player.next() : player.seek(player.pos() + 5); } else if (e.key === 'ArrowLeft') { e.shiftKey ? player.prev() : player.seek(player.pos() - 5); }
  else if (e.key === 'ArrowUp') { vol.value = Math.min(1, +vol.value + 0.05); vol.oninput(); } else if (e.key === 'ArrowDown') { vol.value = Math.max(0, +vol.value - 0.05); vol.oninput(); }
  else if (e.key === 'd' && !e.metaKey && !e.ctrlKey) player.setDJ(!player.dj); else if (e.key === 'f' && vizShown()) $('#fsBtn').click(); else if (e.key === 'n') { e.preventDefault(); $('#markHere').click(); }
});

// ------------------------------------------------------------------ extensions (optional add-ons; none ship enabled)
// A view an extension adds: a button under "Extensions" in the left pane and a page in the main area. Removed with the extension.
const extViews = new Map();
function addExtView(extId, { id = extId, title, mount }) {
  const v = 'ext-' + id.replace(/[^\w-]/g, ''), btn = h('button', { class: 'nav', 'data-view': v }, title || id), sec = h('section', { id: 'view-' + v, class: 'view', hidden: true });
  navClick(btn); $('#extNav').append(btn); $('#extNav').hidden = false; $('#extViews').append(sec);
  let un = null; try { un = mount?.(sec) || null; } catch (e) { sec.append(h('div', { class: 'err' }, String(e.message || e))); }
  const rec = { extId, shown: () => {}, remove: () => { try { typeof un === 'function' ? un() : un?.stop?.(); } catch { /* going away */ } btn.remove(); sec.remove(); extViews.delete(v); $('#extNav').hidden = !extViews.size; if (view === v) show('now'); } };
  extViews.set(v, rec); return rec.remove;
}

// Plugins (spec 2, docs/PLUGIN-SPEC.md §6) also get the platform, their native commands, a folder picker and library
// import/annotate (provenance, tags, notes and defects on recordings, keyed like everything else the user writes).
const pluginRuntime = { os: TAURI ? '' : 'web', arch: '', native: [], spec: '2.0' };
async function libTrackByPath(path, ms = 15000) { const t0 = Date.now(); for (;;) { const t = lib._byPath.get(path); if (t && (t.tagged || t.kind !== 'track')) return t; if (Date.now() - t0 > ms) return t || null; await new Promise(r => setTimeout(r, 150)); } }
async function annotate(by, path, { tags, removeTags, notes: ns, provenance, defects } = {}) {
  const t = await libTrackByPath(path); if (!t) throw new Error(`not in the library: ${path}`); const key = trackKey(t), st = notes.store;
  if (tags?.length || removeTags?.length) { const r = await st.get(key), drop = new Set(removeTags || []), next = [...new Set([...r.tags.filter(x => !drop.has(x)), ...(tags || [])])]; if (next.join('\n') !== r.tags.join('\n')) await st.setTags(key, next); }
  if (provenance) await st.patchProvenance(key, provenance);
  if (ns) { const r = await st.get(key), mine = r.notes.filter(n => n.by === by), want = ns.map(n => (typeof n === 'string' ? n : n.text)); if (mine.map(n => n.text).join('\n') === want.join('\n')) ns = null; else for (const n of mine) await st.removeNote(key, n.id); }
  if (ns) { for (const n of ns) { const x = await st.addNote(key, typeof n === 'string' ? { text: n } : n); await st.editNote(key, x.id, { by }); } }
  if (defects) await st.setDefects(key, by, defects);
  return key;
}
const extApi = (id, meta = {}) => ({
  id, player, library: lib, toast,
  viz: { get pack() { return viz.pack; }, get packs() { return viz.packs; }, setPack: pid => viz.setPack(pid), onFrame: cb => viz.onFrame(cb) },
  settings: { get: (k, d) => store.get(`ext.${id}.${k}`, d), set: (k, v) => store.set(`ext.${id}.${k}`, v) },
  secrets: secrets.scoped(id),       // every extension and plugin: passwords, tokens, keys, in the OS keychain (docs/SECRETS.md)
  ui: { addView: v => addExtView(id, v), openExternal: url => openExternal(url) },      // openExternal: https links, in the user's browser
  audio: { get context() { return feed.ctx; }, insert: (node, out) => player.insert(node, out) },
  ...(meta.kind === 'plugin' ? {
    platform: { ...pluginRuntime, appVersion: pluginRuntime.appVersion || build?.version || '', status: extensions.availability(id).status },
    net: { fetch: netFetch },
    sources: { register: p => registerPluginSource(p) },      // returns the function that unregisters it (call it in stop())
    metadata: { register: p => registerProvider(p), lookup: (q, o) => lookupAll(q, o), get providers() { return listProviders().map(p => ({ id: p.id, name: p.name })); } },      // register returns the function that unregisters it (call it in stop())
    ...(TAURI && meta.native && pluginRuntime.native.includes(id) ? { native: nativeApi(TAURI, id) } : {}),
    ...(TAURI ? { dialog: { folder: async ({ title } = {}) => { const d = await TAURI.dialog.open({ directory: true, multiple: false, title }); if (d) await TAURI.core.invoke('allow_path', { path: d }); return d || null; } } } : {}),
    library: Object.assign(Object.create(lib), {
      roots: () => libs.allRoots().map(r => r.root),
      /// Add files the plugin wrote to the library now (their folder becomes a library folder if it isn't inside one), then annotate them.
      async import(paths, ann = {}) {
        if (!TAURI) throw new Error('importing files needs the desktop app');
        for (const p of paths) if (!libs.allRoots().some(r => p.startsWith(r.root.replace(/\/?$/, '/')))) { const dir = p.replace(/[\\/][^\\/]+$/, ''); libs.addRoot(libs.target().id, dir); await TAURI.core.invoke('allow_path', { path: dir }); }
        await addSources(await sourcesFromPathsTauri(paths), 'Imported');
        const per = typeof ann === 'function' ? ann : () => ann; const keys = [];
        for (const p of paths) keys.push(await annotate(id, p, per(p)));
        return keys;
      },
      annotate: (path, ann) => annotate(id, path, ann),
      defects: { clear: async path => { const t = await libTrackByPath(path, 0); if (t) await notes.store.setDefects(trackKey(t), id, []); } },
    }),
  } : {}),
});
const extensions = new Extensions({ store, api: extApi, runtime: pluginRuntime });
extensions.addEventListener('change', () => { for (const r of [...extViews.values()]) if (!extensions.running.has(r.extId)) r.remove(); if (view === 'settings') paintSettings(); });
const STATUS_LABEL = { supported: '', experimental: 'experimental here', unavailable: 'not available here', missing: 'not in this build' };
// A `secret` setting (a token, a password, a key): goes to the keychain (api.secrets, under the setting's key), never into
// settings, and is never shown again; the field only says whether one is saved. Clearing it deletes the secret.
function secretInput(id, f) {
  const sc = secrets.scoped(id), inp = h('input', { type: 'password', autocomplete: 'off', placeholder: '…', onchange: async ev => {
    try { await sc.set(f.key, ev.target.value.trim()); ev.target.value = ''; await paint(); if (extensions.running.has(id)) { await extensions.stop(id); await extensions.start(id); } } catch (err) { toast(`${f.label}: ${err.message || err}`, true); } } });
  const rm = h('button', { class: 'link', hidden: true, onclick: async ev => { ev.preventDefault(); await sc.delete(f.key); await paint(); if (extensions.running.has(id)) { await extensions.stop(id); await extensions.start(id); } } }, 'remove');
  const paint = async () => { const has = !!(await sc.get(f.key).catch(() => null)); inp.placeholder = has ? 'saved (type to replace)' : (f.placeholder || 'not set'); rm.hidden = !has; };
  paint(); return h('span', {}, inp, ' ', rm);
}
function extensionRows() {
  if (!extensions.list.length) return [h('div', { class: 'muted small' }, 'No plugins installed.')];
  return extensions.list.flatMap(e => {
    const on = extensions.enabled(e.id), st = extensions.status(e.id), av = extensions.availability(e.id), badge = STATUS_LABEL[av.status];
    const toggle = async ev => {
      const want = ev.target.checked, warn = want && extensions.needsConfirm(e.id);
      if (warn) { ev.target.checked = false; const box = ev.target.closest('.srow'); if (box.nextElementSibling?.classList.contains('pconfirm')) return;
        box.after(h('div', { class: 'srow sub pconfirm' }, h('span', {}, h('small', { class: 'err' }, warn)), h('span', {}, h('button', { class: 'btn', onclick: async () => { extensions.confirm(e.id); await extensions.setEnabled(e.id, true); } }, 'Turn on'), ' ', h('button', { class: 'btn', onclick: ev2 => ev2.target.closest('.pconfirm').remove() }, 'Cancel')))); return; }
      extensions.setEnabled(e.id, want);
    };
    const rows = [h('label', { class: 'srow' + (av.can ? '' : ' dim') }, h('span', {}, h('b', {}, e.name, badge ? h('span', { class: 'pbadge ' + av.status }, badge) : ''), h('small', {}, e.description || ''), av.why ? h('small', { class: 'muted' }, av.why) : '', on && av.can ? h('small', { class: extensions.error(e.id) ? 'err' : 'muted' }, extensions.error(e.id) || st || 'starting…') : ''), h('input', { type: 'checkbox', checked: on && av.can, disabled: !av.can, onchange: toggle }))];
    if (on && av.can) for (const f of e.settings || []) {
      const v = extensions.setting(e.id, f.key, f.default), set = val => extensions.setSetting(e.id, f.key, val);
      const input = f.type === 'select' ? h('select', { onchange: ev => set(ev.target.value) }, ...(f.options || []).map(o => h('option', { value: o, selected: o === v }, o)))
        : f.type === 'bool' ? h('input', { type: 'checkbox', checked: !!v, onchange: ev => set(ev.target.checked) })
        : f.type === 'secret' ? secretInput(e.id, f)
        : h('input', { type: f.type === 'number' ? 'number' : 'text', value: v, onchange: ev => set(f.type === 'number' ? +ev.target.value : ev.target.value) });
      rows.push(h('label', { class: 'srow sub' }, h('span', {}, h('b', {}, f.label), f.hint ? h('small', {}, f.hint) : ''), input));
    }
    return rows;
  });
}

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
    try { const conn = await addConnection(L, p, vals); formOpen.delete(L.id); const r = await syncConnection(conn, L); toast(`${conn.title}: ${r.total.toLocaleString()} tracks`); renderAll(); paintSettings(); paintLibSel(); }
    catch (e) { err.textContent = e.message || String(e); go.disabled = false; go.textContent = 'Connect'; } } }, 'Connect');
  wrap.append(h('div', { class: 'lib-head' }, sel), fields, err, h('div', { class: 'cbtns' }, go, h('button', { class: 'btn', onclick: () => { formOpen.delete(L.id); paintSettings(); } }, 'Cancel')));
  return wrap;
}
// Settings → Tag edits → files
function tagFileSettings(row, chk, num) {
  const out = [h('h3', {}, 'Tag edits → files'),
    row('Write tag edits to files', 'Off by default. Tag edits you make in bootleg are shown in bootleg only; turn this on to write them into the files — your own folders, and a server’s music through the folder it is shared from (an SMB share…). You review every edit before it is written.', h('input', { type: 'checkbox', id: 'set-tagWrite', checked: !!settings.tagWrite, onchange: async e => { settings.tagWrite = e.target.checked; applySettings(); if (settings.tagWrite) await tagFiles.allowFolders(); paintSettings(); } }))];
  if (!settings.tagWrite) return out;
  for (const { conn } of libs.allConnections()) {
    const f = tagFiles.folders()[conn.id], c = tagChecks[conn.id];
    const msg = !f ? 'Not set: this server’s edits stay in bootleg.' : !c ? f.root : !c.reachable ? `${f.root} — not reachable now (is the share mounted? on your home network or VPN?)` : !c.sample ? `${f.root} — the server reports no file paths, so files are matched by exact size. On Navidrome, turn on Report Real Path (see below).` : `${f.root}${c.prefix ? ' (server folder: ' + c.prefix + ')' : ''} — ${c.matched} of ${c.sample} sample tracks found`;
    out.push(row(`Music folder for ${conn.title}`, msg, h('span', { class: 'sbtns' },
      h('button', { class: 'btn', onclick: async () => { const dir = await TAURI.dialog.open({ directory: true, title: `Where is ${conn.title}’s music on this computer?` }); if (!dir) return; tagChecks[conn.id] = await tagFiles.setFolder(conn.id, dir); paintSettings(); } }, f ? 'Change…' : 'Choose…'),
      f ? h('button', { class: 'btn', onclick: async () => { tagChecks[conn.id] = await tagFiles.detect(conn.id); paintSettings(); } }, 'Check') : '')));
  }
  if (libs.allConnections().length) out.push(h('div', { class: 'muted small' }, 'Navidrome: turn on “Report Real Path” for the bootleg player (Navidrome → Settings → Players → bootleg) so bootleg knows where each file is; without it files are matched by exact size, and ambiguous ones are left alone. Other servers: see the README.'));
  const last = tagFiles.lastRun();
  out.push(row('Write approved edits automatically', 'Every N hours, when the folders are reachable. 0 = only when you press Write. Only edits you approved in the review are written.', num('tagWriteHours', 0, 168)),
    row('Review and write', last ? `Last run ${new Date(last.at).toLocaleString()}: ${last.ok} written, ${last.failed} not written${last.lines.length ? ' — ' + last.lines.slice(0, 3).join('; ') : ''}` : 'Not run yet.', h('button', { class: 'btn primary', id: 'tagReview', onclick: () => openTagReview(tagFiles, { h, toast, onDone: () => { if (view === 'settings') paintSettings(); } }) }, `Review edits… (${lib.tracks.filter(t => t.edited).length})`)));
  return out;
}
let build = null; fetch('/build.json').then(r => r.json()).then(j => { build = j; pluginRuntime.appVersion = j.version || ''; }).catch(() => {});
async function paintSettings() {
  const box = $('#settingsBody'), st = await cache.stats(), row = (label, hint, input) => h('label', { class: 'srow' }, h('span', {}, h('b', {}, label), hint ? h('small', {}, hint) : ''), input);
  const chk = k => h('input', { type: 'checkbox', checked: !!settings[k], onchange: e => { settings[k] = e.target.checked; applySettings(); } });
  const num = (k, min, max) => h('input', { type: 'number', min, max, value: settings[k], onchange: e => { settings[k] = Math.max(min, Math.min(max, +e.target.value || 0)); applySettings(); } });
  const pick = (k, opts, then = () => {}) => h('select', { id: 'set-' + k, onchange: e => { settings[k] = e.target.value; applySettings(); then(); } }, ...Object.entries(opts).map(([v, l]) => h('option', { value: v, selected: settings[k] === v }, l)));
  const libCards = libs.list.map(L => h('div', { class: 'lib-card' },
    h('div', { class: 'lib-head' }, h('input', { value: L.name, 'aria-label': 'Library name', onchange: e => { libs.update(L.id, { name: e.target.value }); paintLibSel(); } }),
      h('select', { 'aria-label': 'Mode', onchange: e => { libs.update(L.id, { mode: e.target.value }); paintLibSel(); notes.refresh(); } }, ...Object.entries(MODES).map(([k, m]) => h('option', { value: k, selected: k === L.mode }, m.label))),
      h('button', { class: 'btn', onclick: async () => { libs.setActive(L.id); lib.scope = L.id; paintLibSel(); TAURI ? await addFolderDesktop().catch(e => toast(String(e), true)) : $('#folderIn').click(); paintSettings(); } }, 'Add folder here'),
      h('button', { class: 'btn', disabled: libs.list.length < 2, title: libs.list.length < 2 ? 'Keep at least one library' : 'Remove this library (your files are untouched; notes are kept)', onclick: async () => { await forgetLibrary(L); libs.remove(L.id); lib.scope = libs.active; renderAll(); paintLibSel(); paintSettings(); } }, 'Delete')),
    h('div', { class: 'muted small' }, MODES[L.mode].label === 'Studio' ? 'Studio: status, ideas, to-dos, mix notes and versions; how-it-was-made provenance.' : 'Listening: ratings, memories, stories; where-the-recording-came-from provenance.'),
    L.connections.length ? h('div', { class: 'lib-roots' }, ...L.connections.map(c => h('span', {}, '☁ ', h('b', {}, c.title), ' ', h('span', { class: 'muted' }, getSource(c.plugin)?.name || c.plugin), ' ', h('button', { class: 'link', onclick: () => syncAll().then(paintSettings) }, 'sync'), ' ', h('button', { class: 'link', onclick: async () => { await removeConnection(L, c); lib.removeMissing(`${c.plugin}:${c.id}`, new Set(), L.id); renderAll(); paintSettings(); } }, 'disconnect')))) : '',
    connectForm(L),
    L.roots.length ? h('div', { class: 'lib-roots' }, ...L.roots.map(r => h('span', {}, h('code', {}, r), ' ', h('button', { class: 'link', onclick: async () => { libs.removeRoot(L.id, r); if (!libs.ofRoot(r)) await cache.delIndex(r).catch(() => {}); lib.removeMissing(r, new Set(), L.id); renderAll(); paintSettings(); } }, 'remove')))) : h('div', { class: 'muted small' }, TAURI ? 'No folders yet.' : 'In the browser, files you add stay for this session (the desktop app remembers folders).')));
  const newName = h('input', { placeholder: 'New library name…', id: 'newLibName' }), newMode = h('select', { id: 'newLibMode' }, ...Object.entries(MODES).map(([k, m]) => h('option', { value: k }, m.label)));
  box.replaceChildren(
    h('h3', {}, 'Libraries'), ...libCards,
    h('div', { class: 'lib-head' }, newName, newMode, h('button', { class: 'btn primary', id: 'newLibBtn', onclick: () => { const l = libs.add(newName.value, newMode.value); libs.setActive(l.id); lib.scope = l.id; paintLibSel(); renderAll(); paintSettings(); } }, 'Create library')),
    h('div', { class: 'muted small' }, 'Notes, ratings and tags belong to the recording, so they follow it across libraries. A library’s mode only chooses which fields and tools are offered.'),
    h('h3', {}, 'Playing'),
    row('Clicking an album', 'In every album view. A double-click always plays the album and shows its tracks.', pick('albumClick', ALBUM_CLICKS, () => { gridKey = null; })),
    row('Between tracks', 'Gapless: the next track starts on the exact sample the last one ends (live albums, DJ mixes). A crossfade overlaps them instead. Both decode the current and the next track in the background (tracks over 20 minutes stream as before and change over without decoding). Off: each track loads when the last one ends, using the least memory.', pick('transition', TRANSITIONS)),
    row('Match tempo when crossfading', 'With a crossfade, the next track comes in at this one’s tempo, on a bar line, then eases back to its own tempo (the pitch moves a little, like a record). Needs a BPM tag on both.', chk('matchTempo')),
    row('Play and double-click', 'Replace: the album, playlist or list you play becomes the queue. Build a queue: the queue is only ever added to — double-click adds to the end (playing at once if nothing is), ▶ plays straight away and keeps the rest. The “next” and “+ queue” buttons work the same in both.', pick('playModel', PLAY_MODELS)),
    h('h3', {}, 'Now playing'),
    row('Spectrogram on the timeline', 'The whole song’s spectrogram is drawn once per recording and remembered. For server tracks this downloads the file once more.', pick('spectro', { all: 'Local files and server tracks', local: 'Local files only', off: 'Off' }, () => nowView.refresh())),
    TAURI ? row('Mini player when bootleg is minimized', 'A small window with the controls and what is playing (like the Car Thing app). It goes away again when the main window comes back. The ◱ button in the player bar opens it any time.', h('input', { type: 'checkbox', id: 'set-miniOnMinimize', checked: !!settings.miniOnMinimize, onchange: e => { settings.miniOnMinimize = e.target.checked; applySettings(); } })) : '',
    row('Music videos on visualizer screens', 'When what is playing has a music video (it is playing, or linked to the track), screens opened with “Show on another screen” show the video instead, silently and in step with the player. When the track plays rather than its video, the video loops as the picture.', h('input', { type: 'checkbox', id: 'set-vizVideo', checked: settings.vizVideo !== false, onchange: e => { settings.vizVideo = e.target.checked; applySettings(); } })),
    row('Mini visualizer while browsing', 'Keeps the visualizer in the corner on the other pages (the ▭ button on the visualizer does the same).', h('input', { type: 'checkbox', id: 'set-vizFloat', checked: !!settings.vizFloat, onchange: e => { settings.vizFloat = e.target.checked; applySettings(); placeViz(); } })),
    TAURI ? h('div', { class: 'muted small' }, 'Audio files opened from Finder or Explorer (“Open With → bootleg”, or bootleg set as the default player) play straight away, as ▶ does.') : '',
    ...(tagFiles ? tagFileSettings(row, chk, num) : []),
    ...(offline ? offline.settingsSection() : []),
    h('h3', {}, 'Notes and data'),
    row('Export notes', 'Everything you wrote and rated — notes, ratings, tags, provenance, tag edits and playlists — as one JSON file.', h('button', { class: 'btn', id: 'notesExport', onclick: () => notes.exportNotes() }, 'Export notes…')),
    row('Import notes', 'Merges a bootleg notes file into yours; nothing you have is overwritten with older data.', h('button', { class: 'btn', id: 'notesImport', onclick: () => notes.importNotes() }, 'Import notes…')),
    scopeRoots().length ? row('Forget this library’s folders', 'Removes the folders and servers of ' + (libs.active === 'all' ? 'every library' : 'this library') + ' from bootleg (and its cache). Your files are untouched and your notes are kept.', h('button', { class: 'btn', id: 'forget', onclick: async () => { await forgetActive(); paintSettings(); } }, 'Forget…')) : '',
    h('h3', {}, 'Posting notes'),
    row('Add #nowplaying #bootleg', 'Ends each post with these tags.', chk('shareTags')),
    row('Add a link to bootleg', 'Ends each post with a link to bootleg’s page.', chk('shareLink')),
    row('Your Mastodon server', 'Where “Mastodon” opens the post, e.g. mastodon.social.', h('input', { type: 'text', value: settings.mastodon || '', placeholder: 'mastodon.social', onchange: e => { settings.mastodon = e.target.value.trim() || SHARE_DEFAULTS.mastodon; applySettings(); } })),
    h('h3', {}, 'Library scanning'),
    row('Remember the library (cache)', 'Tags, covers and the file list are kept on this device, so the library appears instantly next time. Takes effect after a restart.', chk('cacheEnabled')),
    row('Check for changes on startup', TAURI ? 'Looks for added, changed and removed files in the background.' : 'Desktop app only — a browser cannot see the disk without being given files.', chk('scanOnStart')),
    row('Re-check every N minutes', '0 = only on startup or when you ask.', num('rescanMinutes', 0, 1440)),
    row('Tag-reading parallelism', 'Higher is faster on fast disks; lower is gentler on network drives.', num('tagConcurrency', 1, 32)),
    h('h3', {}, 'Stem sets'),
    row('Show stem sets in the track list', 'A folder of stems (with its mix) appears as one item; its parts and mix never show as separate tracks.', chk('includeRenders')),
    h('label', { class: 'srow' }, h('span', {}, h('b', {}, 'Load stems'), h('small', {}, 'A stem set always starts playing from its mix. Decoded stems use a lot of memory, so choose when they load.')),
      h('select', { onchange: e => { settings.stemsLoad = e.target.value; applySettings(); } }, ...[['visualizer', 'When a stem-aware visualizer is shown (default)'], ['manual', 'Only when I press “Load stems”'], ['auto', 'Always (uses the most memory)']].map(([v, l]) => h('option', { value: v, selected: settings.stemsLoad === v }, l)))),
    h('h3', {}, '.nfo files'),
    row('Read .nfo files', 'album.nfo / artist.nfo (Kodi style) and plain-text .nfo in your folders: shown with the track and searchable.', chk('useNfo')),
    row('Fill missing tags from .nfo', 'Tags in the files always win; an .nfo only supplies what is missing (album, artist, year, genre).', chk('nfoFill')),
    h('h3', {}, 'Plugins'), ...extensionRows(),
    h('div', { class: 'srow' }, h('span', {}, h('b', {}, 'Secrets'), h('small', {}, `Passwords, tokens and keys (servers’ and plugins’) are kept ${secrets.where}.`)), secrets.secure ? h('span', { class: 'pbadge ok' }, 'secure') : h('span', { class: 'pbadge warn' }, 'not encrypted')),
    h('h3', {}, 'About'),
    h('div', { class: 'srow' }, h('span', {}, h('b', {}, 'bootleg'), h('small', {}, build ? `version ${build.version} · build ${build.commit || 'local'} · ${build.date}` : 'local build')), h('span', { class: 'muted small' }, 'MIT licensed')),
    h('h3', {}, 'Maintenance'),
    h('div', { class: 'srow' }, h('span', {}, h('b', {}, 'Cache'), h('small', {}, `${st.files.toLocaleString()} files remembered · ${st.covers.toLocaleString()} covers · ${st.indexed.toLocaleString()} files indexed in ${st.roots} folders`)),
      h('span', { class: 'sbtns' }, h('button', { class: 'btn', disabled: !TAURI && !libs.allConnections().length, onclick: () => syncAll() }, 'Check for changes now'), h('button', { class: 'btn', onclick: async () => { await cache.clear(); lib.fileCache.clear(); toast('Cache cleared — tags will be re-read on the next scan'); paintSettings(); } }, 'Clear cache'))));
}

// ------------------------------------------------------------------ visualizer on another screen
async function paintScreens() {
  const sel = $('#screenSel'); if (!TAURI) { sel.hidden = true; return; }
  try { const mons = await TAURI.core.invoke('screens_list'); sel.replaceChildren(...mons.map(m => h('option', { value: m.index, selected: !m.primary && mons.length > 1 }, `${m.name || 'Display ' + (m.index + 1)}${m.primary ? ' (main)' : ''} — ${m.w}×${m.h}`))); if (mons.length > 1) sel.value = String(mons.find(m => !m.primary).index); sel.hidden = mons.length < 2; } catch { sel.hidden = true; }
}
$('#screenBtn').onclick = async () => {
  try { if (TAURI) await TAURI.core.invoke('screen_open', { index: +($('#screenSel').value || 0) }); else if (!window.open('/screen.html', 'bootleg-screen', 'popup,width=960,height=540')) toast('Allow pop-ups to open the visualizer screen', true); }
  catch (e) { toast(String(e), true); }
};
$('#screenBtn').addEventListener('mouseenter', paintScreens); paintScreens();

// ------------------------------------------------------------------ the mini player (mini.html): a small remote in its own window
const mini = new MiniHost({ player, onShowMain: () => (TAURI ? TAURI.core.invoke('main_show') : window.focus()) });
async function openMini() {
  try { if (TAURI) await TAURI.core.invoke('mini_open'); else if (!window.open('/mini.html', 'bootleg-mini', 'popup,width=480,height=288')) toast('Allow pop-ups to open the mini player', true); }
  catch (e) { toast(String(e), true); }
}
$('#miniBtn').onclick = openMini;
// minimizing the main window brings the mini player up (Settings → Now playing); restoring it puts away one we opened
let autoMini = false;
TAURI?.event.listen('bootleg://minimized', ({ payload: min }) => {
  if (min && settings.miniOnMinimize && player.item && !mini.alive) { autoMini = true; openMini(); }
  else if (!min && autoMini) { autoMini = false; TAURI.core.invoke('mini_close'); }
});

// ------------------------------------------------------------------ outputs (cast targets)
const SUFFIX_MIME = { flac: 'audio/flac', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/mp4', ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav' };
const artCache = new Map();    // cover URL → URL the device can fetch
async function artFor(item) {
  const u = item.coverUrl; if (!u) return null; if (artCache.has(u)) return artCache.get(u);
  let out = null; try {
    if (/^https?:/.test(u)) out = u;                                    // a server's own cover URL is already reachable
    else if (u.startsWith('blob:') && TAURI) { const b = await (await fetch(u)).blob(), buf = new Uint8Array(await b.arrayBuffer()); let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000)); out = await TAURI.core.invoke('lan_share_bytes', { dataB64: btoa(bin), mime: b.type || 'image/jpeg' }); }
  } catch { out = null; } artCache.set(u, out); return out;
}
const outputs = new Outputs(player, { resolveUrl: async item => {
  const src = item.kind === 'render' ? item.mix : item.src; if (!src) return null; const art = await artFor(item);
  if (src.kind === 'tauri') return { url: await TAURI.core.invoke('lan_share', { path: src.path }), mime: await TAURI.core.invoke('lan_mime', { path: src.path }), art };
  if (src.kind === 'remote') return { url: src.url(), mime: SUFFIX_MIME[(src.name.split('.').pop() || '').toLowerCase()] || 'audio/mpeg', art };
  return null;      // browser files live only in this tab: the device cannot reach them
} });
function paintOutMenu() {
  const m = $('#outMenu'), act = outputs.active; $('#outName').textContent = act ? act.name : 'This computer'; $('#outBtn').classList.toggle('on', !!act);
  if (m.hidden) return; const manual = store.get('outputs', []), addIn = h('input', { placeholder: 'Device address, e.g. 192.168.1.20:49152/desc.xml', 'aria-label': 'Device address' });
  m.replaceChildren(h('div', { class: 'omh' }, h('b', {}, 'Play on'), h('button', { class: 'link', onclick: () => scanOutputs() }, outputs.scanning ? 'scanning…' : 'rescan')),
    h('button', { class: 'orow' + (act ? '' : ' sel'), onclick: () => pickOutput(null) }, '🖥 This computer'),
    ...outputs.devices.map(d => h('button', { class: 'orow' + (act && act.id === d.id ? ' sel' : ''), onclick: () => pickOutput(d), title: d.model || '' }, '📡 ', d.name, h('span', { class: 'muted small' }, ' · ' + (getOutputName(d.plugin))))),
    !outputs.devices.length ? h('div', { class: 'muted small opad' }, TAURI ? (outputs.scanning ? 'Looking for devices on your network…' : 'No devices found. Make sure they are on the same network, or add one by address below.') : 'Casting needs the desktop app (browsers cannot reach devices on your network).') : '',
    outputs.error ? h('div', { class: 'err opad' }, outputs.error) : '',
    /Mac/.test(navigator.platform) && TAURI ? h('div', { class: 'muted small opad' }, 'AirPlay: pick AirPlay speakers in the macOS sound menu (Control Center) — everything bootleg plays, stems included, follows it.') : '',
    TAURI ? h('div', { class: 'oadd' }, addIn, h('button', { class: 'btn', onclick: async () => { const v = addIn.value.trim(); if (!v) return; try { await outputs.addByAddress('dlna', v); const list = store.get('outputs', []); if (!list.some(x => x.input === v)) { list.push({ plugin: 'dlna', input: v }); store.set('outputs', list); } } catch (e) { outputs.error = String(e.message || e); paintOutMenu(); } } }, 'Add')) : '');
}
const getOutputName = id => ({ dlna: 'DLNA' }[id] || id);
async function scanOutputs() { if (!TAURI) { paintOutMenu(); return; } await outputs.scan(store.get('outputs', [])); }
async function pickOutput(d) { await outputs.select(d); paintOutMenu(); if (d && !outputs.error) toast(`Playing on ${d.name}`); }
outputs.addEventListener('change', paintOutMenu);
$('#outBtn').onclick = e => { e.stopPropagation(); const m = $('#outMenu'); m.hidden = !m.hidden; if (!m.hidden) { paintOutMenu(); if (!outputs.devices.length && !outputs.scanning) scanOutputs(); } };
document.addEventListener('click', e => { const m = $('#outMenu'); if (!m.hidden && !m.contains(e.target) && e.target.id !== 'outBtn') m.hidden = true; });

// ------------------------------------------------------------------ notes, ratings, playlists
async function saveText(name, text, mime, fullPath) {
  if (TAURI?.dialog && TAURI?.fs?.writeTextFile) { const p = await TAURI.dialog.save({ defaultPath: fullPath || name }); if (!p) return; await TAURI.fs.writeTextFile(p, text); toast('Saved ' + p.split('/').pop()); return; }
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: mime })), download: name }); document.body.append(a); a.click(); a.remove(); toast('Saved ' + name);
}
const notes = initNotes({ backend: SELF ? new MemoryBackend() : null, player, lib, libs, h, fmt, toast, show, saveText, $, playNow: (ts, i = 0) => acts.now(ts, i), shareOpts: () => settings, offline: () => offline });
offline = initOffline({ h, lib, notes: notes.store, keyOf: trackKey, toast, store, plural, getPlugin: getSource, sessionOf, player });     // Settings → Offline (desktop)
devices = initDevices({ root: $('#view-devices'), h, lib, notes: notes.store, keyOf: trackKey, toast, store, plural, offline });     // players and SD cards (desktop)
let nowKV; try { nowKV = SELF || !window.indexedDB ? new MapKV() : new IdbKV(); } catch { nowKV = new MapKV(); }
const nowView = initNowView({ player, notes: notes.store, keyOf: trackKey, h, fmt, $, editTags, heat: new ListenHeat(nowKV), spectros: new SpectroCache(nowKV), isShown: () => view === 'now',
  connTitle: id => libs.allConnections().find(c => c.conn.id === id)?.conn.title || '', spectroMode: () => settings.spectro,
  composer: it => {      // a stem server song: ask Composer to open it (Composer watches the server for these requests)
    const rm = it?.kind === 'render' && (it.mix || it.stems?.[0]?.src)?.remote, p = rm && getSource(rm.plugin); if (!p?.openInComposer) return null; const ses = sessionOf({ plugin: rm.plugin, conn: rm.conn }), id = it.dir.split('/').pop();
    return () => p.openInComposer(ses, id).then(() => toast('Sent to Composer — it opens there'), e => toast(String(e.message || e), true));
  },
  search: q => { $('#search').value = q; show('tracks'); $('#search').oninput(); }, openQueue: () => { if ($('#queue').hidden) $('#qToggle').click(); } });
// music videos: linked to tracks across every source; they play (with their own sound) on Now playing
let videoKV; try { videoKV = SELF || !window.indexedDB ? new MapKV() : new IdbKV('bootleg-videos', ['links']); } catch { videoKV = new MapKV(); }
const videoLinks = new VideoLinks(videoKV);
videosUI = initVideos({ h, $, lib, player, keyOf: trackKey, links: videoLinks, fmt, toast, playList: (l, i) => acts.now(l, i), sourceName: r => libs.allConnections().find(c => c.conn.id === r.conn)?.conn.title || '' });
videoLinks.ready.then(() => renderAll());
// …and on visualizer screens (screen.js): the video playing, or the one linked to the track, sent with each frame
{ let memo = { k: '', v: null };
  viz.videoInfo = () => {
    const it = player.item; if (settings.vizVideo === false || !it) return null;
    const k = `${it.id}|${lib.ver}|${player.video?.id}`; if (memo.k !== k) memo = { k, v: player.video || videosUI.of(it)[0]?.video || null };
    const v = memo.v; if (!v) return null; let url; try { url = v.src.url(); } catch { return null; }
    return { url, key: v.src.path, t: player.pos(), playing: player.playing, own: player.video === v };
  }; } videoLinks.addEventListener('change', () => renderAll());
// a server's ratings, stars and playlists ↔ bootleg (Subsonic/Navidrome); pushes go out as you rate
// tag edits → the library (on start, on every change, and after a notes import)
notes.store.allEdits().then(m => lib.setEdits(m)).catch(() => {});
notes.store.addEventListener('change', e => loadDamaged(e.detail).catch(() => {}));
notes.store.addEventListener('change', async e => { const k = e.detail; if (k === '*') lib.setEdits(await notes.store.allEdits()); else if (typeof k === 'string' && k.startsWith('file:')) lib.setEdit(k, (await notes.store.get(k)).edits); });
// tag edits → the files themselves (desktop, off by default: Settings → Tag edits → files)
const makeTagFiles = () => new TagFiles({ lib, store: notes.store, kv: store, keyOf: trackKey, getPlugin: getSource, sessionOf, makeSource: tauriSource,
  fs: { stat: p => TAURI.fs.stat(p), readDir: p => TAURI.fs.readDir(p), scan: root => scanFolderTauri(root), allow: path => TAURI.core.invoke('allow_path', { path }), write: (path, fields) => TAURI.core.invoke('write_tags', { path, fields }) },
  patchIndex: async (path, size, mtime) => { for (const ix of await cache.indexes()) if (path.startsWith(ix.root + '/')) { const e = ix.entries.find(x => x.path === path); if (e) { Object.assign(e, { size, mtime }); await cache.putIndex(ix.root, ix.entries); } } } });
const tagFiles = TAURI && !SELF ? makeTagFiles() : null;
const tagChecks = {};      // connection → the last folder check, shown in Settings
// The schedule writes only approved edits, only when it is due, and only what can be reached (a share off the home network is skipped, not failed).
setInterval(async () => {
  if (!tagFiles || !settings.tagWrite || !(settings.tagWriteHours > 0) || tagFiles.running || Date.now() - (tagFiles.lastRun()?.at || 0) < settings.tagWriteHours * 3600000) return;
  const due = (await tagFiles.pending()).filter(e => e.approved && !e.written); if (!due.length) return;
  const res = await tagFiles.apply(due).catch(() => []), ok = res.filter(r => r.ok && !r.skipped).length; if (ok) toast(`Wrote tag edits into ${plural(ok, 'file')}`); if (view === 'settings') paintSettings();
}, 10 * 60000);
const remoteAnn = new RemoteAnnotations({ notes: notes.store, kv: store, getPlugin: getSource, sessionOf, onError: m => toast('Server: ' + m, true) });

// ------------------------------------------------------------------ desktop self-test (BOOTLEG_SELFTEST=<music dir> BOOTLEG_SELFTEST_OUT=<file>): proves the packaged app can scan, tag, stream and analyse real files
// The CD plugin against its simulator (plugin spec §7.3): rip the scratched sample disc with the real native plugin, import
// it, and check the library shows the damage. Runs only when the sim backend is selected (BOOTLEG_CD_BACKEND=sim).
// The library checker against the real library of the self-test (the fixtures and the CD rip above): every file decoded and
// measured natively, the ripped album put together as a disc (AccurateRip offline here), and a missing file reported.
async function selfTestChecker() {
  if (!pluginRuntime.native.includes('checker')) return { skipped: 'not in this build' };
  const n = nativeApi(TAURI, 'checker'), local = lib.tracks.filter(t => t.src?.kind === 'tauri'), { albums } = await import('/plugins/checker/checker-logic.js');
  const request = { files: [...local.map(t => t.src.path), '/nonexistent/x.flac'], albums: albums(local), recheck: true, accuraterip: true }, evs = [];
  const sum = await n.job('check', { request }, e => { if (e.type === 'event') evs.push(e.data); }).done;
  const files = evs.filter(e => e.kind === 'file'), alb = evs.filter(e => e.kind === 'album'), self = files.find(f => f.check?.format === 'flac');
  const again = await n.job('check', { request: { ...request, recheck: false } }, () => {}).done;
  return { files: files.length, read: sum.read, cachedAgain: again.cached, albums: alb.map(a => a.check.state).join(','), md5: self?.check?.md5, missing: files.find(f => f.path === '/nonexistent/x.flac')?.error || '',
    ok: files.length === request.files.length && files.filter(f => f.check).length === local.length && alb.length >= 1 && alb.every(a => a.check.state === 'offline') && self?.check?.md5 === 'ok' && !!files.find(f => f.path === '/nonexistent/x.flac')?.error && again.cached === local.length };
}
// The Record plugin against its simulated input: record a side (a WAV played as if from a turntable), find its two
// tracks, save them as FLAC next to the self-test library, import them with their provenance, delete the raw recording.
// Music videos on the desktop: a local MP4 (asset protocol) linked to the self-test track, played with
// its own sound through the audio graph.
const peakNow = async () => { let pk = 0; for (let i = 0; i < 20; i++) { pk = Math.max(pk, ...feed.update(0.05).spectrum); await new Promise(r => setTimeout(r, 50)); } return pk; };
const waitFor = async (f, ms = 20000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + f); await new Promise(r => setTimeout(r, 100)); } };
async function selfTestVideo() {
  const t = lib.tracks.find(x => /\/A\/st\.flac$/.test(x.src.path)), v = lib.videos.find(x => x.src.kind === 'tauri');      // (the track was retitled by the tag-writing check above, so it is linked by hand)
  if (!t || !v) return { error: 'no track or no local video', videos: lib.videos.length };
  await videoLinks.link(trackKey(t), v.src.path); const m = videosUI.of(t).find(x => x.video === v && x.how === 'linked'); if (!m) return { error: 'the link did not take' };
  await player.playList([t], 0); await player.watch(m.video); await waitFor(() => player.video && player.playing && player.pos() > 0.7 && player.videoEl.videoWidth > 0, 15000);
  const out = { ok: false, size: `${player.videoEl.videoWidth}x${player.videoEl.videoHeight}`, peak: await peakNow() }; out.ok = out.peak > 0.1; player.pause(); return out;
}
// Plex: a packaged source plugin whose server allows no other origins, so the player streams through the loopback
// media proxy (src-tauri/src/proxy.rs). Silence here would mean the audio graph could not read the stream.
async function selfTestPlex() {
  const url = await TAURI.core.invoke('selftest_plex'); if (!url) return { skipped: 'no mock server' };
  const { plex } = await import('/plugins/plex/plex-logic.js'), src = plex(netFetch, { open: () => { throw new Error('no sign-in expected'); } });
  if (!getSource('plex')) registerSource(src);
  const L = libs.target(), conn = await addConnection(L, getSource('plex'), { url }, 'plexst'), r = await syncConnection(conn, L), out = { ok: false, total: r.total };
  const t = lib.tracks.find(x => x.src.remote?.plugin === 'plex' && x.title === 'Plex One'); if (!t) return { ...out, error: 'no Plex tracks' };
  await player.playList([t], 0); await waitFor(() => player.playing && player.pos() > 0.7, 15000);
  out.proxied = /^http:\/\/127\.0\.0\.1:\d+\/p\/[0-9a-f]{32}$/.test(player.audio.src); out.trackPeak = await peakNow();
  const v = videosUI.of(t).find(x => x.video.src.remote?.plugin === 'plex')?.video; if (!v) return { ...out, error: 'the Plex music video was not matched' };
  await player.watch(v); await waitFor(() => player.video && player.playing && player.pos() > 0.7 && player.videoEl.videoWidth > 0, 15000); out.videoPeak = await peakNow();
  out.ok = out.proxied && out.trackPeak > 0.1 && out.videoPeak > 0.1; player.pause(); return out;
}
async function selfTestCapture() {
  if (!pluginRuntime.native.includes('capture')) return { skipped: 'not in this build' };
  const n = nativeApi(TAURI, 'capture'), bi = await n.invoke('backend_info'); if (bi.backend !== 'sim') return { skipped: 'backend ' + bi.backend };
  const { tracksFrom, importInfo } = await import('/plugins/capture/capture-logic.js'), devs = await n.invoke('devices'); let lv = 0;
  const rec = await n.job('record', { device: devs[0].id, rate: 0, name: 'selftest' }, e => { if (e.type === 'event') lv++; }).done;
  const a = await n.invoke('analyze', { path: rec.path, points: 400 }), tracks = tracksFrom(a, 1).map((t, i) => ({ ...t, title: ['Low', 'High'][i] || 'x' }));
  const dest = libs.allRoots()[0].root.replace(/[\\/][^\\/]+$/, '') + '/Captured', saved = await n.job('save', { request: { recording: rec.path, dest, album: 'Self Test LP', albumArtist: 'Tester', tracks, bits: 24, declick: true, source: 'vinyl' } }, () => {}).done;
  const api = extApi('capture', { kind: 'plugin', native: {} }); await api.library.import(saved.map(s => s.path), importInfo(saved, { source: 'vinyl', deck: 'Sim deck', input: devs[0].name, meta: { album: 'Self Test LP' } }));
  const lt = lib._byPath.get(saved[1].path), r = lt && await notes.store.get(trackKey(lt)); const kept = await n.invoke('recordings'); await n.invoke('discard', { path: rec.path }); const after = await n.invoke('recordings');
  return { seconds: Math.round(rec.seconds), levels: lv, splits: a.splits.map(x => +x.toFixed(1)).join(','), saved: saved.length, title: lt?.title, prov: r?.provenance?.kind, kept: kept.length, discarded: after.length === kept.length - 1,
    ok: Math.abs(rec.seconds - 53.5) < 0.5 && lv > 10 && a.splits.length === 1 && Math.abs(a.splits[0] - 24.5) < 0.6 && saved.length === 2 && lt?.title === 'High' && r?.provenance?.kind === 'vinyl-rip' && after.length === kept.length - 1 };
}
async function selfTestCd(dir) {
  if (!pluginRuntime.native.includes('cd')) return { skipped: 'not in this build' };
  const cdn = nativeApi(TAURI, 'cd'), bi = await cdn.invoke('backend_info'); if (bi.backend !== 'sim') return { skipped: 'backend ' + bi.backend };
  const { annotations } = await import('/plugins/cd/cd-logic.js'), drives = await cdn.invoke('drives'), drive = drives.find(d => d.id === 'sim:Damaged'); if (!drive) return { error: 'no sim:Damaged disc' };
  const disc = await cdn.invoke('disc', { drive: drive.id }), dest = dir + '/CD', events = [];
  const meta = { album: 'Sim Album', albumArtist: 'Sim Artist', tracks: [{ number: 2, title: 'Scratched' }] };
  const job = cdn.job('rip', { drive: drive.id, request: { dest, meta, secure: { offset: 6, cache_defeat: 80, max_rounds: 12 } } }, ev => events.push(ev.type));
  const r = await job.done, api = extApi('cd', { kind: 'plugin', native: {} });
  await api.library.import(r.tracks.map(t => t.path), annotations(r, drive));
  const t2 = r.tracks.find(t => t.number === 2), lt = lib._byPath.get(t2.path), rec = lt && await notes.store.get(trackKey(lt));
  return { tracks: r.tracks.length, mb: disc.musicbrainzId, statuses: r.tracks.map(t => t.status).join(','), progress: events.includes('progress'), libTitle: lt?.title, defects: rec?.defects?.length || 0, tags: rec?.tags?.join(',') || '', prov: rec?.provenance?.kind || '', badge: damaged.has(trackKey(lt)),
    ok: r.tracks.length === 3 && t2.status === 'damaged' && r.tracks.filter(t => t.status === 'secure').length === 2 && lt?.title === 'Scratched' && rec?.defects?.length === 1 && rec.tags.includes('rip:damaged') && rec.provenance?.kind === 'cd-rip' };
}
async function selfTest(dir) {
  const out = { ok: false }, wait = async (f, ms = 20000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + f); await new Promise(r => setTimeout(r, 100)); } };
  try {
    const ts = performance.now(), first = await scanFolderTauri(dir); out.scanMs = Math.round(performance.now() - ts); out.scanFiles = first.length;
    const tt = performance.now(); await addSources(first, 'self-test'); await wait(() => (lib.tracks.length || lib.renders.length) && lib.tracks.every(t => t.tagged), 180000); out.tagMs = Math.round(performance.now() - tt);
    { const src = lib.tracks[0]?.src; if (src && lib.nativeReader) { const n = await lib.nativeReader(src.path), j = await readTags(src.reader()); out.nativeTagsMatch = !!n && ['title', 'artist', 'album', 'year', 'track'].every(k => (n[k] ?? '') == (j[k] ?? '')) && !!(n.cover || n.coverKey) === !!j.cover; if (!out.nativeTagsMatch) out.nativeVsJs = JSON.stringify([{ ...n, cover: !!n?.cover }, { ...j, cover: !!j.cover }]).slice(0, 300); } }
    out.tracks = lib.tracks.length; out.renders = lib.renders.length; out.firstTitle = lib.tracks[0]?.title; out.cover = lib.tracks.some(t => !!t.coverUrl);
    if (lib.tracks.length) { await player.playList(lib.tracks.slice(), 0); try { await wait(() => player.playing && player.pos() > 0.7, 9000); } catch { out.autoplayBlocked = true; } }
    if (lib.tracks.length && !out.autoplayBlocked) { let peak = 0; for (let i = 0; i < 20; i++) { const A = feed.update(0.05); peak = Math.max(peak, ...A.spectrum); await new Promise(r => setTimeout(r, 50)); } out.pos = player.pos(); out.peak = peak; out.mode = player.mode; }
    if (lib.renders.length && !out.autoplayBlocked) { await player.playList([lib.renders[0]], 0); await wait(() => player.playing && player.pos() > 0.5); out.mixFirst = lib.renders[0].mix ? player.mode === 'element' : true; await player.ensureStems(); if (lib.renders[0].mix) await wait(() => player.mode === 'deck' && player.deck.stems.length > 0 && player.playing); out.stems = player.deck.stems.length; out.stemsContinued = player.pos() > 0.5; }
    { await lib.flush(); const read = lib.stats.read, srcs = await scanFolder(dir); lib.clear(); lib.add(srcs); await wait(() => lib.tracks.every(t => t.tagged)); out.cachedRescan = lib.stats.read === read && lib.stats.cached >= out.tracks; out.cacheFiles = (await cache.stats()).files; await cache.putIndex(dir, srcs.map(x => ({ path: x.path, size: x.size, mtime: x.mtime }))); libs.addRoot(libs.target().id, dir); lib.clear(); const r0 = lib.stats.read, tr = performance.now(); await restoreFromCache(); await wait(() => lib.tracks.every(t => t.tagged)); out.restoreMs = Math.round(performance.now() - tr); out.restored = lib.tracks.length === out.tracks && lib.renders.length === out.renders && lib.stats.read === r0; libs.removeRoot(libs.target().id, dir); await cache.delIndex(dir); }
    const sub = await TAURI.core.invoke('selftest_subsonic');
    if (sub && !out.autoplayBlocked) {      // a source plugin end to end: connect, scan, stream (WebKit can't read it cross-origin, so this exercises the HTTP plugin + blob fallback)
      const L = libs.target(), conn = await addConnection(L, getSource('subsonic'), { url: sub, username: 'alice', password: 'secret' }, 'st'); { const tok = (await secrets.getJSON(connKey(conn)))?.token; out.secretKept = !('token' in conn.config) && !!tok && !JSON.stringify(store.get('libraries')).includes(tok) && fullConfig(secrets, conn).token === tok;      // the token is in the (self-test, in-memory) keychain, not in saved settings
        const old = { id: 'mig', plugin: 'subsonic', title: 'old', config: { url: sub, username: 'alice', salt: 'ab', token: 'legacy' } }; libs.addConnection(L.id, old); const moved = await migrateConnections(secrets, libs, getSource);      // a connection saved before secrets existed
        out.secretMigrated = moved === 1 && !('token' in libs.connection('mig').config) && (await secrets.getJSON('source/subsonic/mig'))?.token === 'legacy'; await removeConnection(L, libs.connection('mig')); out.secretMigrated &&= (await secrets.get('source/subsonic/mig')) === null;
        { const ps = extApi('selftest-ext').secrets; await ps.set('cert', 'x'); secrets.cache.delete('plugin/selftest-ext/cert'); out.extSecret = (await ps.get('cert')) === 'x' && (await TAURI.core.invoke('secret_get', { key: 'plugin/selftest-ext/cert' })) === 'x'; await ps.delete('cert'); } }
      const r = await syncConnection(conn, L); out.remoteTracks = r.total; const rt = lib.tracks.find(t => t.remote); await player.playList([rt], 0); await wait(() => player.playing && player.pos() > 0.7); let pk = 0; for (let i = 0; i < 20; i++) { pk = Math.max(pk, ...feed.update(0.05).spectrum); await new Promise(r => setTimeout(r, 50)); } out.remotePeak = pk; out.remoteBlob = player.audio.src.startsWith('blob:');
      if (offline) {      // the offline store end to end: keep a server track (Rust download), play from the copy, sync it to a card from there
        try {
          const got = await offline.localFor([rt.src], { quality: 'original', card: 'self-test' }), kp = got.map.get(rt.src.path);
          const { files: ff, remote: rr } = filesFor([rt], { keyOf: trackKey, localOf: x => offline.keptPath(x, 'original') });
          const u = rt.src.url(), copy = await rt.src.fetch().then(r => r.arrayBuffer()).catch(e => { throw new Error(`read the kept copy (${u.slice(0, 60)}): ${e.message}`); });
          const sp = getSource('subsonic'), ses = sessionOf(rt.src.remote), orig = await sp.fetch(ses, sp.streamUrl(ses, rt.src.remote.item)).then(r => r.arrayBuffer()).catch(() => null);
          out.offline = !!kp && !got.failed.length && offline.keptPath(rt.src, 'original') === kp && !/^https?:/.test(u) && copy.byteLength > 1000 && (!orig || orig.byteLength === copy.byteLength) && rr.length === 0 && ff[0]?.path === kp;
          if (!out.offline) out.offlineDiag = JSON.stringify({ kp, failed: got.failed, u: u.slice(0, 40), copy: copy.byteLength, orig: orig?.byteLength, rr: rr.length, ff });
        } catch (e) { out.offlineDiag = String(e?.message || e); }
      }
    }
    const dlRaw = await TAURI.core.invoke('selftest_dlna'), [dl, dlFlags = ''] = (dlRaw || '').split(';');
    if (dl && !out.autoplayBlocked) {       // casting end to end against a mock DLNA renderer: control (SOAP), the LAN media server, transport mirroring
      const dev = await getOutput('dlna').add(dl); out.dlnaName = dev.name; out.dlnaSsdp = (await getOutput('dlna').discover({ timeoutMs: 2500 }).catch(() => [])).some(d => d.id === dev.id);
      const local = lib.tracks.find(t => t.src.kind === 'tauri'); await player.playList([local], 0); await wait(() => player.playing && player.pos() > 0.5);
      await outputs.select(dev); if (outputs.error) throw new Error('cast: ' + outputs.error); await new Promise(r => setTimeout(r, 1800));
      player.pause(); await new Promise(r => setTimeout(r, 400)); player.seek(3); await new Promise(r => setTimeout(r, 400)); if (!dlFlags.includes('novol')) player.setVolume(0.5); await new Promise(r => setTimeout(r, 400));
      out.dlnaStatus = (await getOutput('dlna').status(dev)).state; await outputs.select(null); out.dlnaLocalRestored = player.localOut !== false;
    }
    { const mons = await TAURI.core.invoke('screens_list'); out.screens = mons.length; await TAURI.core.invoke('screen_open', { index: 0 }); await wait(() => viz.screenAlive, 12000); out.screenOpened = true; await TAURI.core.invoke('screen_close'); }   // a second window on a display, talking to the player
    { // writing a tag edit into a real file (a temp fixture): store → library → native writer → re-read; last, so earlier checks see the original title
      const lt = lib.tracks.find(x => x.src.kind === 'tauri'), tf = makeTagFiles(), k0 = trackKey(lt); await notes.store.setEdits(k0, { title: 'Self Test Edited', year: 1999 }); await wait(() => lt.title === 'Self Test Edited');
      const res = await tf.apply(await tf.pending()); await wait(() => lt.tagged && !lt.edited && lt.title === 'Self Test Edited', 15000).catch(() => {});
      const back = await lib.nativeReader(lt.src.path); out.tagWrite = res.length === 1 && res[0].ok && back?.title === 'Self Test Edited' && String(back?.year) === '1999' && trackKey(lt) !== k0; if (!out.tagWrite) out.tagWriteDiag = JSON.stringify({ res: res.map(r => r.error || r.path), back: back && { title: back.title, year: back.year } });
    }
    // minimizing the main window brings up the mini player, which connects back to the player; restoring puts it away
    // (a display with no window manager — CI's virtual one — cannot minimize: then the window is opened directly)
    try {
      await TAURI.core.invoke('selftest_minimize', { on: true }); try { await wait(() => mini.alive, 8000); out.miniOnMinimize = true; } catch { await TAURI.core.invoke('mini_open'); await wait(() => mini.alive, 12000); }
      out.miniWindow = true; mini.cmd({ cmd: 'volume', to: 0.5 }); await TAURI.core.invoke('selftest_minimize', { on: false }); if (!out.miniOnMinimize) await TAURI.core.invoke('mini_close'); await wait(() => !mini.alive, 12000); out.miniClosed = true;
    } catch (e) { out.miniDiag = String(e?.message || e); }
    // a .bstem: its parts are read by range from the file (the asset protocol), its mix plays, its stems load
    try {
      const pdir = dir.replace(/\/[^/]+$/, '/P'); lib.add(await scanFolder(pdir)); const r = lib.renders.find(x => x.pkgSrc); await wait(() => r && (r.pkg || r.broken), 10000);
      if (r.broken) throw new Error(r.broken); await player.playList([r], 0); await wait(() => player.playing && player.pos() > 0.3, 15000);
      await player.ensureStems(); await wait(() => player.mode === 'deck' && player.deck.stems.length === r.stems.length, 20000); out.package = r.title === 'Packaged Self Test' && r.stems.length >= 2; player.pause();
    } catch (e) { out.packageDiag = String(e?.message || e); }
    out.cd = await selfTestCd(dir).catch(e => ({ error: String(e?.message || e) }));
    out.checker = await selfTestChecker().catch(e => ({ error: String(e?.message || e) }));
    if (pluginRuntime.native.includes('acoustid')) {      // the AcoustID fingerprinter on a real file of the self-test library (no lookup: that needs a key and the network)
      const f = lib.tracks.find(t => t.src?.kind === 'tauri' && t.duration > 4), got = [];
      await nativeApi(TAURI, 'acoustid').job('fingerprint', { paths: [f.src.path] }, e => { if (e.type === 'event') got.push(e.data); }).done.catch(e => got.push({ error: String(e) }));
      out.acoustid = { ok: !!got[0]?.fingerprint && got[0].fingerprint.startsWith('AQ') && got[0].duration > 0, duration: got[0]?.duration, error: got[0]?.error };
    } else out.acoustid = { skipped: 'not in this build' };
    out.capture = await selfTestCapture().catch(e => ({ error: String(e?.message || e) }));
    out.video = await selfTestVideo().catch(e => ({ error: String(e?.message || e) }));
    out.plex = await selfTestPlex().catch(e => ({ error: String(e?.message || e) }));
    // syncing to a player: pair a card folder that already holds a file of the user's, mirror one track and a playlist onto it,
    // then mirror nothing — bootleg's copy goes, the user's file stays (the shell checks the files on disk afterwards)
    try {
      const card = dir.replace(/\/[^/]+$/, '/card'), inv = TAURI.core.invoke, lt = lib.tracks.find(x => x.src.kind === 'tauri');
      await inv('device_pair', { volume: card, name: 'Self-test card', mode: 'mirror', root: 'Music/bootleg', kind: null });
      const { files } = filesFor([lt], { keyOf: trackKey }), p1 = await inv('device_plan', { volume: card, items: files, playlists: [{ name: 'Road', tracks: [trackKey(lt)] }] });
      const r1 = await inv('device_apply', { planId: p1.id, onProgress: new TAURI.core.Channel() });
      const again = await inv('device_plan', { volume: card, items: files, playlists: [{ name: 'Road', tracks: [trackKey(lt)] }] });
      out.deviceCopied = r1.copied === 1 && r1.playlists === 1 && again.copy === 0 && again.unchanged === 1;
      const p2 = await inv('device_plan', { volume: card, items: [], playlists: [] }), r2 = await inv('device_apply', { planId: p2.id, onProgress: new TAURI.core.Channel() });
      out.deviceSync = out.deviceCopied && r2.deleted === 2 && !r2.failed.length; if (!out.deviceSync) out.deviceDiag = JSON.stringify({ r1, again: again.copy, r2 });
    } catch (e) { out.deviceDiag = String(e?.message || e); }
    // the startup path itself (cache, then the background check) runs to the end on the desktop
    out.startup = await Promise.race([startLibrary().then(() => true, e => 'error: ' + (e?.message || e)), new Promise(r => setTimeout(() => r('timeout'), 30000))]);
    await notes.store.setRating('selftest', 4); out.notesDb = (await notes.store.get('selftest')).rating === 4; await notes.store.setRating('selftest', 0);
    out.ok = true;
  } catch (e) { out.error = String(e && e.message || e); const a = player.audio; out.diag = { err: a.error && (a.error.code + ' ' + a.error.message), ready: a.readyState, net: a.networkState, paused: a.paused, ctx: feed.ctx && feed.ctx.state, src: (a.currentSrc || '').slice(0, 60), canFlac: a.canPlayType('audio/flac'), canMp3: a.canPlayType('audio/mpeg'), canM4a: a.canPlayType('audio/mp4') }; }
  await TAURI.core.invoke('selftest_done', { result: JSON.stringify(out) });
}

notes.store.addEventListener('change', () => { if (view === 'albums' && settings.albumView === 'split') paintSplitPane(); });

// ------------------------------------------------------------------ start
(async function init() {
  $('#sys').replaceChildren(TAURI ? h('span', {}, 'desktop') : h('span', {}, 'web'));
  applySettings(); paintLibSel(); updateBar(); renderAll();      // the window is interactive immediately; the library follows
  loadDamaged('*').catch(() => {});
  if (TAURI) try { Object.assign(pluginRuntime, await TAURI.core.invoke('plugin_runtime')); } catch (e) { console.warn('plugin runtime', e); }
  await secrets.init(); await migrateConnections(secrets, libs, getSource).catch(e => console.warn('secret migration', e)); await secrets.preload(libs.allConnections().map(x => connKey(x.conn)));      // before any connection's session is built
  await Promise.all([viz.init(), lib.attachCache(cache).catch(() => {}), window.__BOOTLEG_SELFTEST ? null : extensions.init()]);
  await migrateRemoteKeys(notes.store).catch(e => console.warn('key migration', e));
  if (tagFiles && settings.tagWrite) await tagFiles.allowFolders();      // the share folders chosen for writing are opened again      // before any server sync reads ratings
  const selfDir = TAURI ? await TAURI.core.invoke('selftest_config') : null; if (selfDir) selfTest(selfDir);
  else {
    if (TAURI) openFromOS().catch(e => toast(String(e), true));        // launched by opening a file: it plays before the library finishes loading
    startLibrary().catch(e => toast(String(e), true));      // and, in every case, the library: from the cache at once, then a look for changes
  }
  window.__bootleg = { videosUI, videoLinks, metaChosen, listProviders, secrets, mini, remoteAnn, tagFiles, extensions, paintScreens, outputs, sessionOf, libs, settings, cache, syncAll, notes, lib, player, viz, feed, addSources, show };       // for tests and the desktop self-test
})();
