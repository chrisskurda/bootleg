// The mini player window: a small remote for the player in the main window (same origin, over a BroadcastChannel —
// see lib/mini-host.js). It looks like the Car Thing app's Now page; it is drawn at 800×480 and scaled to the window.
import { MINI_CHANNEL } from '/lib/mini-host.js';
const $ = s => document.querySelector(s), T = window.__TAURI__;
const ICONS = { play: 'M8 5v14l11-7z', pause: 'M6 5h4v14H6zM14 5h4v14h-4z', next: 'M6 5v14l9-7zM17 5h2v14h-2z', prev: 'M18 5v14l-9-7zM5 5h2v14H5z',
  shuffle: 'M16 3h5v5l-1.8-1.8L4 21.4 2.6 20 17.8 4.8zM3 4.4 4.4 3l5 5-1.4 1.4zM15 15l1.4-1.4 3.8 3.8L21 16v5h-5l1.8-1.8z', repeat: 'M7 7h10v3l4-4-4-4v3H5v6h2zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2z',
  one: 'M11 9h2v6h-1.5v-4.4L10 11V9.6z', minus: 'M5 11h14v2H5z', plus: 'M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z', open: 'M5 5h6v2H7v10h10v-4h2v6H5zm8 0h6v6h-2V8.4l-6.3 6.3-1.4-1.4L15.6 7H13z', pin: 'M14 4l6 6-2 1-3 3 1 4-2 2-4-4-5 5-1-1 5-5-4-4 2-2 4 1 3-3z' };
const icon = (n, size = 28) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${ICONS[n]}"/></svg>`;
const mmss = s => `${Math.floor((s || 0) / 60)}:${String(Math.floor((s || 0) % 60)).padStart(2, '0')}`;
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// ---- scale the 800×480 page to the window
const fit = () => { const k = Math.min(innerWidth / 800, innerHeight / 480), st = $('#stage'); st.style.transform = `translate(${(innerWidth - 800 * k) / 2}px, ${(innerHeight - 480 * k) / 2}px) scale(${k})`; };
addEventListener('resize', fit); fit();

// ---- link to the player
const bc = new BroadcastChannel(MINI_CHANNEL), send = c => bc.postMessage(c);
let st = null, at = 0, last = 0, cover = { id: null, data: null };
bc.onmessage = e => { const m = e.data; if (!m?.type) return; last = performance.now(); if (m.type === 'state') { st = m; at = performance.now(); paint(); } else if (m.type === 'cover') { cover = m; paintArt(); } };
const hello = () => send({ hello: true }); hello(); setInterval(() => { hello(); if (st && performance.now() - last > 6000) { st = null; paint(); } }, 2000);

// ---- sliders: the whole 56px row is the target; seek commits on release, volume follows the drag
function slider(el, { live = false, commit }) {
  let drag = null, sent = 0; const fill = el.querySelector('.fill'), knob = el.querySelector('.knob'), at = e => { const r = el.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); };
  const show = v => { fill.style.width = v * 100 + '%'; knob.style.left = v * 100 + '%'; };
  el.onpointerdown = e => { el.setPointerCapture(e.pointerId); drag = at(e); show(drag); };
  el.onpointermove = e => { if (drag == null) return; drag = at(e); show(drag); if (live && performance.now() - sent > 80) { sent = performance.now(); commit(drag); } };
  el.onpointerup = e => { if (drag == null) return; commit(at(e)); drag = null; };
  el.onpointercancel = () => { drag = null; };
  return { set: v => { if (drag == null) show(v); } };
}
const seek = slider($('#seek'), { commit: v => send({ cmd: 'seek', to: v }) }), vol = slider($('#vol'), { live: true, commit: v => send({ cmd: 'volume', to: v }) });

// ---- buttons
$('#shuffle').innerHTML = icon('shuffle') + '<span>Shuffle</span>'; $('#open').innerHTML = icon('open') + '<span>bootleg</span>'; $('#pin').innerHTML = icon('pin') + '<span>On top</span>';
$('#prev').innerHTML = icon('prev'); $('#next').innerHTML = icon('next'); $('#vdown').innerHTML = icon('minus'); $('#vup').innerHTML = icon('plus');
$('#shuffle').onclick = () => send({ cmd: 'shuffle' }); $('#repeat').onclick = () => send({ cmd: 'repeat' }); $('#prev').onclick = () => send({ cmd: 'prev' }); $('#next').onclick = () => send({ cmd: 'next' }); $('#play').onclick = () => send({ cmd: 'toggle' });
$('#vdown').onclick = () => st && send({ cmd: 'volume', to: Math.max(0, st.volume - 0.05) }); $('#vup').onclick = () => st && send({ cmd: 'volume', to: Math.min(1, st.volume + 0.05) });
const openMain = () => (T ? T.core.invoke('main_show') : send({ cmd: 'showMain' })); $('#open').onclick = openMain; $('#art').onclick = openMain;
let onTop = false; try { onTop = localStorage.getItem('bootleg.mini.onTop') === '1'; } catch { /* private mode */ }
const applyTop = () => { $('#pin').classList.toggle('on', onTop); if (T) T.core.invoke('mini_on_top', { on: onTop }).catch(() => {}); };
$('#pin').onclick = () => { onTop = !onTop; try { localStorage.setItem('bootleg.mini.onTop', onTop ? '1' : '0'); } catch { /* private mode */ } applyTop(); };
if (!T) $('#pin').classList.add('off'); else applyTop();
addEventListener('wheel', e => { if (st) send({ cmd: 'volume', to: Math.max(0, Math.min(1, st.volume - Math.sign(e.deltaY) * 0.03)) }); }, { passive: true });
addEventListener('keydown', e => { if (e.code === 'Space') { e.preventDefault(); send({ cmd: 'toggle' }); } else if (e.key === 'ArrowRight') send({ cmd: e.shiftKey ? 'next' : 'seekBy', by: 5 }); else if (e.key === 'ArrowLeft') send({ cmd: e.shiftKey ? 'prev' : 'seekBy', by: -5 }); });

// ---- paint
function paintArt() { const t = st?.track, a = $('#art'); a.innerHTML = t && cover.id === t.id && cover.data ? `<img src="${cover.data}" alt="">` : '♪'; }
let artFor = undefined;
function paint() {
  $('#wait').hidden = !!st; if (!st) return; const t = st.track;
  $('#meta').innerHTML = t ? `<div class="title">${esc(t.title)}</div><div class="artist">${esc(t.artist || 'Unknown artist')}</div><div class="album">${esc(t.album)}</div>` : '<div class="idle">Nothing playing</div>';
  if (t?.id !== artFor) { artFor = t?.id; paintArt(); }
  $('#shuffle').classList.toggle('on', st.shuffle); const r = $('#repeat'); r.classList.toggle('on', st.repeat !== 'off'); r.innerHTML = icon(st.repeat === 'one' ? 'one' : 'repeat') + '<span>Repeat</span>';
  $('#play').innerHTML = icon(st.playing ? 'pause' : 'play', 48); $('#play').setAttribute('aria-label', st.playing ? 'Pause' : 'Play');
  $('#tags').innerHTML = [t?.bpm ? `${Math.round(t.bpm)} bpm` : '', t?.key || '', st.count > 1 ? `${st.index + 1}/${st.count}` : ''].filter(Boolean).map(x => `<span class="pill">${esc(x)}</span>`).join('');
  $('#stemsPill').hidden = !st.stems; $('#stemsPill').textContent = st.stems ? `${st.stems} stems` : '';
  $('#dur').textContent = mmss(st.dur); vol.set(st.volume); $('#vn').textContent = Math.round(st.volume * 100); document.title = t ? `${t.title} — bootleg` : 'bootleg mini';
}
// the playhead moves on its own between updates
(function loop() { if (st) { const p = Math.min(st.dur, st.pos + (st.playing ? (performance.now() - at) / 1000 : 0)); $('#cur').textContent = mmss(p); seek.set(st.dur ? p / st.dur : 0); } requestAnimationFrame(loop); })();
paint();
