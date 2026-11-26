// Equalizer: ten peaking filters (low and high shelves at the ends) inserted between the player and the speakers, and a
// page in the left pane to set them. An example of an extension that adds a view (api.ui.addView) and processes audio
// (api.audio.insert). Settings are kept per extension, so the curve survives restarts.
export const BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
export const PRESETS = {
  Flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  'Bass boost': [6, 5, 4, 2, 0, 0, 0, 0, 0, 0],
  'Treble boost': [0, 0, 0, 0, 0, 1, 2, 4, 5, 6],
  Vocal: [-2, -2, -1, 1, 3, 4, 3, 1, 0, -1],
  Loudness: [5, 4, 1, 0, -1, 0, 0, 1, 3, 4],
  Night: [-4, -3, -1, 0, 0, 1, 1, 0, -2, -4],
};
const label = hz => (hz >= 1000 ? hz / 1000 + 'k' : String(hz));

export function activate(api) {
  const ctx = api.audio.context, gains = api.settings.get('gains', PRESETS.Flat.slice()); let on = api.settings.get('on', true), preamp = api.settings.get('preamp', 0);
  const pre = ctx.createGain(), filters = BANDS.map((f, i) => { const b = ctx.createBiquadFilter(); b.type = i === 0 ? 'lowshelf' : i === BANDS.length - 1 ? 'highshelf' : 'peaking'; b.frequency.value = f; b.Q.value = 1.1; return b; });
  filters.reduce((a, b) => (a.connect(b), b), pre);
  const apply = () => { pre.gain.value = on ? 10 ** (preamp / 20) : 1; filters.forEach((b, i) => { b.gain.value = on ? gains[i] : 0; }); paintCurve(); };
  const save = () => { api.settings.set('gains', gains); api.settings.set('on', on); api.settings.set('preamp', preamp); };
  const remove = api.audio.insert(pre, filters[filters.length - 1]);

  let curve = null, sliders = [], vals = [];
  function paintCurve() {
    if (!curve) return; const w = curve.width = curve.clientWidth * devicePixelRatio || 600, hgt = curve.height = 120 * devicePixelRatio, g = curve.getContext('2d'), n = 200;
    const fr = new Float32Array(n).map((_, i) => 20 * Math.pow(1000, i / (n - 1))), mag = new Float32Array(n).fill(1), m = new Float32Array(n), ph = new Float32Array(n);
    for (const b of filters) { b.getFrequencyResponse(fr, m, ph); for (let i = 0; i < n; i++) mag[i] *= m[i]; }
    g.clearRect(0, 0, w, hgt); g.strokeStyle = '#272d42'; g.beginPath(); g.moveTo(0, hgt / 2); g.lineTo(w, hgt / 2); g.stroke();
    g.strokeStyle = on ? '#ff5fd2' : '#5d6585'; g.lineWidth = 2 * devicePixelRatio; g.beginPath();
    for (let i = 0; i < n; i++) { const db = 20 * Math.log10(mag[i]) + preamp, y = hgt / 2 - db / 15 * (hgt / 2); i ? g.lineTo(i / (n - 1) * w, y) : g.moveTo(0, y); } g.stroke();
  }
  const el = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (k === 'style') e.style.cssText = v; else e.setAttribute(k, v); } e.append(...kids); return e; };
  const fmtDb = v => (v > 0 ? '+' : '') + v + ' dB';
  const removeView = api.ui.addView({ title: 'Equalizer', mount(root) {
    const onBox = el('input', { type: 'checkbox', onchange: e => { on = e.target.checked; apply(); save(); } }); onBox.checked = on;
    const presetSel = el('select', { onchange: e => { const p = PRESETS[e.target.value]; if (!p) return; p.forEach((v, i) => { gains[i] = v; sliders[i].value = v; vals[i].textContent = fmtDb(v); }); apply(); save(); } }, el('option', { value: '' }, 'Preset…'), ...Object.keys(PRESETS).map(k => el('option', { value: k }, k)));
    const preIn = el('input', { type: 'range', min: -12, max: 6, step: 0.5, value: preamp, oninput: e => { preamp = +e.target.value; preOut.textContent = fmtDb(preamp); apply(); }, onchange: save }), preOut = el('span', { class: 'mono small' }, fmtDb(preamp));
    vals = BANDS.map((_, i) => el('span', { class: 'mono small' }, fmtDb(gains[i])));
    sliders = BANDS.map((f, i) => { const s = el('input', { type: 'range', min: -12, max: 12, step: 0.5, value: gains[i], 'aria-label': label(f) + ' Hz', oninput: e => { gains[i] = +e.target.value; vals[i].textContent = fmtDb(gains[i]); presetSel.value = ''; apply(); }, onchange: save }); return s; });
    curve = el('canvas', { style: 'width:100%;height:120px;display:block;background:#0f1320;border-radius:8px;margin:12px 0' });
    root.append(el('div', { style: 'max-width:760px;padding-top:14px' },
      el('div', { class: 'toolbar', style: 'display:flex;gap:12px;align-items:center;flex-wrap:wrap' }, el('h3', { style: 'margin:0' }, 'Equalizer'), el('label', { class: 'muted' }, onBox, ' on'), presetSel, el('label', { class: 'muted', style: 'display:flex;gap:6px;align-items:center' }, 'Preamp ', preIn, preOut)),
      curve,
      el('div', { style: 'display:grid;grid-template-columns:repeat(10,1fr);gap:6px;text-align:center' }, ...sliders.map((s, i) => el('div', { style: 'display:flex;flex-direction:column;align-items:center;gap:4px' },
        el('div', { style: 'height:170px;display:grid;place-items:center' }, Object.assign(s, { style: 'writing-mode:vertical-lr;direction:rtl;height:160px;width:24px' })), vals[i], el('b', { class: 'small' }, label(BANDS[i]))))),
      el('p', { class: 'muted small' }, 'The equalizer shapes what you hear. The visualizer and meters still see the music as it is.')));
    requestAnimationFrame(paintCurve); const ro = new ResizeObserver(paintCurve); ro.observe(curve); return () => ro.disconnect();
  } });
  apply();
  return { stop() { removeView(); remove(); try { pre.disconnect(); filters.forEach(f => f.disconnect()); } catch { /* gone */ } }, status: () => (on ? `on — ${gains.some(Boolean) || preamp ? 'custom curve' : 'flat'}` : 'bypassed') };
}
