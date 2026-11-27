// A visualizer screen: shows whatever pack the player has selected, driven by the player's audio frames.
import { CHANNEL, FrameRebuilder } from '/lib/screen-link.js';
const frame = document.getElementById('pack'), mv = document.getElementById('mv'), msg = document.getElementById('msg'), bc = new BroadcastChannel(CHANNEL), rb = new FrameRebuilder();
let packUrl = '', last = 0;
bc.onmessage = e => {
  const m = e.data; if (!m) return;
  if (m.type === 'pack' && m.url !== packUrl) { packUrl = m.url; frame.src = m.url; }
  else if (m.type === 'frame') {
    last = performance.now(); msg.hidden = true; const A = rb.rebuild(m.A), w = frame.contentWindow;
    try { w.__META = m.meta; w.__AUDIO = A; w.__PARAMS = m.params; w.__FX = window.lookFx(m.look); } catch { /* pack still loading */ }
    const css = window.lookToCss(m.look, A, performance.now() / 1000); if (css !== frame.style.filter) frame.style.filter = css;
    showVideo(m.video);
  }
};
// A music video instead of the visualizer (the player's setting): silent, following the player's position. When the track
// plays rather than its video, the video is just the picture and loops.
let mvKey = '';
function showVideo(v) {
  if (!v) { if (!mv.hidden) { mv.hidden = true; mv.pause(); mv.removeAttribute('src'); mv.load(); mvKey = ''; frame.classList.remove('off'); } return; }
  if (v.key !== mvKey) { mvKey = v.key; mv.src = v.url; mv.hidden = false; frame.classList.add('off'); }
  const d = mv.duration, want = isFinite(d) && d > 0 ? (v.own ? Math.min(v.t, d) : v.t % d) : v.t;
  if (mv.readyState >= 1 && Math.abs(mv.currentTime - want) > 0.35) mv.currentTime = want;
  if (v.playing && mv.paused) mv.play().catch(() => {}); else if (!v.playing && !mv.paused) mv.pause();
}
const hello = () => bc.postMessage({ type: 'hello' });
hello(); setInterval(() => { bc.postMessage({ type: 'ping' }); if (performance.now() - last > 4000) { msg.hidden = false; hello(); } }, 2000);
addEventListener('dblclick', () => { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.().catch(() => {}); });
addEventListener('keydown', e => { if (e.key === 'Escape') { const T = window.__TAURI__; if (T) T.core.invoke('screen_close').catch(() => window.close()); else window.close(); } });
