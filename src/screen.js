// A visualizer screen: shows whatever pack the player has selected, driven by the player's audio frames.
import { CHANNEL, FrameRebuilder } from '/lib/screen-link.js';
const frame = document.getElementById('pack'), msg = document.getElementById('msg'), bc = new BroadcastChannel(CHANNEL), rb = new FrameRebuilder();
let packUrl = '', last = 0;
bc.onmessage = e => {
  const m = e.data; if (!m) return;
  if (m.type === 'pack' && m.url !== packUrl) { packUrl = m.url; frame.src = m.url; }
  else if (m.type === 'frame') {
    last = performance.now(); msg.hidden = true; const A = rb.rebuild(m.A), w = frame.contentWindow;
    try { w.__META = m.meta; w.__AUDIO = A; w.__PARAMS = m.params; w.__FX = window.lookFx(m.look); } catch { /* pack still loading */ }
    const css = window.lookToCss(m.look, A, performance.now() / 1000); if (css !== frame.style.filter) frame.style.filter = css;
  }
};
const hello = () => bc.postMessage({ type: 'hello' });
hello(); setInterval(() => { bc.postMessage({ type: 'ping' }); if (performance.now() - last > 4000) { msg.hidden = false; hello(); } }, 2000);
addEventListener('dblclick', () => { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.().catch(() => {}); });
addEventListener('keydown', e => { if (e.key === 'Escape') { const T = window.__TAURI__; if (T) T.core.invoke('screen_close').catch(() => window.close()); else window.close(); } });
