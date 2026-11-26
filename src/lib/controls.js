// Controls generated from a pack's manifest (number / select / color / bool / multi), and the Look/FX sliders.
export const h = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v); } for (const c of kids.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(c)); return e; };

export function control(obj, key, def, onChange) {
  const lab = def.label || key, v = obj[key], wrap = h('label', { class: 'ctl' });
  if (def.type === 'number') { const n = h('span', { class: 'n' }, String(v)); wrap.append(h('span', {}, lab), n, h('input', { type: 'range', min: def.min, max: def.max, step: def.step, value: v, oninput: e => { obj[key] = +e.target.value; n.textContent = obj[key]; onChange?.(); } })); }
  else if (def.type === 'color') wrap.append(h('span', {}, lab), h('input', { type: 'color', value: v, oninput: e => { obj[key] = e.target.value; onChange?.(); } }));
  else if (def.type === 'select') wrap.append(h('span', {}, lab), h('select', { onchange: e => { obj[key] = e.target.value; onChange?.(); } }, def.options.map(o => h('option', { value: o, selected: o === v }, o))));
  else if (def.type === 'bool') wrap.append(h('span', {}, lab), h('input', { type: 'checkbox', checked: !!v, onchange: e => { obj[key] = e.target.checked; onChange?.(); } }));
  else if (def.type === 'multi') {   // chips: with everything selected a click solos that option; then clicks add / remove; none left = all again
    wrap.className = 'ctl multi'; const chips = h('div', { class: 'chips' }), all = h('a', { href: '#', class: 'all' }, 'all'), paint = () => chips.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', obj[key].includes(c.dataset.o)));
    for (const o of def.options) chips.append(h('button', { type: 'button', class: 'chip', 'data-o': o, onclick: () => { const every = obj[key].length === def.options.length; let set = every ? new Set([o]) : new Set(obj[key]); if (!every) set.has(o) ? set.delete(o) : set.add(o); if (!set.size) set = new Set(def.options); obj[key] = def.options.filter(x => set.has(x)); paint(); onChange?.(); } }, o));
    all.onclick = e => { e.preventDefault(); obj[key] = def.options.slice(); paint(); onChange?.(); }; wrap.append(h('span', {}, lab, ' ', all), chips); paint();
  }
  return wrap;
}
export const LOOKS = [['roto', 0, 2, 1, 'Roto (flat tones, ink)'], ['glitch', 0, 1, 0.01, 'Glitch bursts'], ['screen', 0, 3, 1, 'Screen: scan / CRT / curved'], ['hue', -180, 180, 1, 'Hue shift'], ['sat', 0, 2, 0.01, 'Saturation'], ['bright', 0.3, 1.8, 0.01, 'Brightness'],
  ['contrast', 0.5, 1.6, 0.01, 'Contrast'], ['blur', 0, 12, 0.5, 'Blur px'], ['invert', 0, 1, 0.01, 'Invert'], ['sepia', 0, 1, 0.01, 'Sepia'], ['gray', 0, 1, 0.01, 'Grayscale'], ['hueDrift', -60, 60, 1, 'Hue drift °/s'], ['hueBeat', 0, 120, 1, 'Hue kick on beat °'],
  ['brightBass', 0, 1, 0.01, 'Brightness on bass'], ['satMid', 0, 1, 0.01, 'Saturation on mids']];
export const defaultsOf = p => Object.fromEntries(Object.entries(p.params || {}).map(([k, d]) => [k, Array.isArray(d.default) ? d.default.slice() : d.default]));

// 1 track, 2 tracks
export const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
