// The Now playing page: what is playing (cover, every fact bootleg has about it), its timeline (the song's spectrogram,
// note callouts, the listening heatmap, a playhead you can click to seek), and what plays next. The notes editor and the
// stem mixer sit below it (notes-ui.js, app.js); the visualizer is a tile here (viz-dock.js) and its own page.
import { paintSpectro, analyseFile } from './spectro.js';
import { BINS } from './listen-heat.js';

const ext = n => (String(n || '').split('.').pop() || '').toUpperCase();
const mb = b => b >= 1e9 ? (b / 1e9).toFixed(2) + ' GB' : (b / 1e6).toFixed(1) + ' MB';
const LANES = 3, LANE_H = 20;

// Lays labels out left to right in up to `lanes` rows so they do not overlap; one that fits nowhere keeps only its pin.
export function layoutCallouts(items, width, lanes = LANES) {
  const ends = new Array(lanes).fill(-Infinity), out = [];
  for (const it of [...items].sort((a, b) => a.x - b.x)) {
    const w = Math.min(220, 14 + it.label.length * 6.4), lane = ends.findIndex(e => it.x >= e + 6);
    if (lane < 0) { out.push({ ...it, lane: -1, w: 0 }); continue; } const left = Math.max(0, Math.min(width - w, it.x)); ends[lane] = left + w; out.push({ ...it, lane, w, left });
  }
  return out;
}
// The tracks that play after the current one, in play order (shuffle included), wrapping when repeat-all is on.
export function upNext(player, n = 5) {
  const p = player.order.indexOf(player.index); if (p < 0) return []; const out = [];
  for (let k = 1; out.length < n && k < player.order.length; k++) { const q = p + k; if (q >= player.order.length && player.repeat !== 'all') break; out.push(player.order[q % player.order.length]); }
  return out.map(i => ({ i, t: player.queue[i] }));
}

export function initNowView({ player, notes, keyOf, h, fmt, $, editTags, connTitle = () => '', search = () => {}, openQueue = () => {}, spectroMode = () => 'all', heat, spectros, isShown = () => true }) {
  const hero = $('#nowHero'), info = $('#nowInfo'), tl = $('#timeline'), plot = $('#tlPlot'), spec = $('#tlSpec'), heatC = $('#tlHeat'), calls = $('#tlCallouts'), ranges = $('#tlRanges'), head = $('#tlHead'), hover = $('#tlHover'), tstat = $('#tlStatus'), scale = $('#tlScale'), next = $('#upNext');
  let item = null, key = null, rec = null, tok = 0;

  // ---- the track
  function paintInfo() {
    const it = player.item; hero.hidden = !it; $('#nowEmpty').hidden = !!it; if (!it) return;
    const src = it.kind === 'render' ? it.mix : it.src, r = src?.remote, size = src?.size || r?.item?.size || 0, dur = it.duration || player.dur();
    const kbps = r?.item?.bitrate || (size && dur ? Math.round(size * 8 / dur / 1000) : 0), fmtName = (r?.item?.suffix || ext(src?.name)).toUpperCase();
    const link = (txt, q) => txt ? h('button', { class: 'link', title: 'Find in the library', onclick: () => search(q) }, txt) : '';
    const facts = [
      it.track ? ['Track', `${it.track}${it.trackTotal ? ' of ' + it.trackTotal : ''}${it.disc ? ` · disc ${it.disc}` : ''}`] : null, it.year ? ['Year', it.year] : null, it.genre ? ['Genre', it.genre] : null,
      it.albumArtist && it.albumArtist !== it.artist ? ['Album artist', it.albumArtist] : null, it.composer ? ['Composer', it.composer] : null, it.bpm ? ['BPM', String(Math.round(it.bpm))] : null, it.key ? ['Key', it.key] : null,
      dur ? ['Length', fmt(dur)] : null, fmtName || size ? ['File', [fmtName, kbps ? `${r?.item?.bitrate ? '' : '≈'}${kbps} kbps` : '', size ? mb(size) : ''].filter(Boolean).join(' · ')] : null,
      it.kind === 'render' ? ['Stem set', `${it.stems.length} stems${it.mix ? ' + mix' : ''}`] : null,
      ['Source', src?.kind === 'remote' ? `${connTitle(r.conn) || 'Server'}${r.item.path ? ' — ' + r.item.path : ''}` : src?.kind === 'web' ? 'Added in this browser tab' : (src?.path || it.dir || '')],
    ].filter(Boolean);
    const tags = rec?.tags || [], nNotes = rec?.notes?.length || 0;
    info.replaceChildren(
      h('div', { class: 'kicker' }, player.playing ? 'Now playing' : 'Paused', player.queue.length > 1 ? ` · ${player.index + 1} of ${player.queue.length} in the queue` : ''),
      h('h1', { class: 'nowtitle' }, it.title, it.edited ? h('span', { class: 'chip', title: 'Tags edited in bootleg' }, '✎') : ''),
      h('div', { class: 'nowsub' }, link(it.artist, it.artist), it.artist && it.album ? h('span', { class: 'muted' }, ' · ') : '', link(it.album, it.album), it.year ? h('span', { class: 'muted' }, ` (${it.year})`) : ''),
      tags.length || nNotes ? h('div', { class: 'nowtags' }, ...tags.map(t => h('span', { class: 'chip' }, t)), nNotes ? h('span', { class: 'chip' }, `${nNotes} note${nNotes === 1 ? '' : 's'}`) : '') : '',
      h('dl', { class: 'facts' }, ...facts.flatMap(([k, v]) => [h('dt', {}, k), h('dd', { title: v }, v)])),
      h('div', { class: 'cbtns' }, it.kind === 'track' ? h('button', { class: 'btn', onclick: () => editTags([it]) }, '✎ Edit tags') : '', it.lyrics ? h('details', { class: 'lyrics' }, h('summary', { class: 'link' }, 'Lyrics'), h('div', {}, it.lyrics)) : ''));
    const c = $('#nowCover'); c.replaceChildren(it.coverUrl ? h('img', { src: it.coverUrl, alt: '' }) : h('div', { class: 'cover ph' }, '♪'));
  }

  // ---- what plays next
  function paintNext() {
    const list = upNext(player); next.replaceChildren(h('div', { class: 'qhead' }, h('b', {}, 'Up next'), h('button', { class: 'link', onclick: openQueue }, `queue (${player.queue.length})`)),
      ...(list.length ? list.map(({ i, t }) => h('div', { class: 'qi', title: 'Play now', onclick: () => player.jump(i) }, t.coverUrl ? h('img', { src: t.coverUrl, alt: '', loading: 'lazy' }) : h('div', { class: 'cover ph' }, '♪'),
        h('div', { style: 'min-width:0' }, h('div', { class: 't' }, t.title), h('div', { class: 's' }, t.artist || (t.kind === 'render' ? 'stem set' : ''))), h('span', { class: 'muted small mono' }, t.duration ? fmt(t.duration) : '')))
        : [h('div', { class: 'muted small' }, player.item ? 'Nothing after this one. Add tracks with “next” or “+ queue”.' : 'Nothing queued.')]));
  }

  // ---- timeline: callouts for the notes, ranges as bands, the heatmap strip
  function paintNotes() {
    const d = player.dur() || item?.duration || 0, w = calls.clientWidth || tl.clientWidth; calls.replaceChildren(); ranges.replaceChildren(); calls.style.height = '10px'; if (!rec || !d) return;
    const timed = rec.notes.filter(n => n.at != null);
    for (const n of timed.filter(n => n.to != null)) { const b = h('button', { class: 'tlrange', title: `${fmt(n.at)}–${fmt(n.to)}  ${n.text}`, onclick: () => player.seek(n.at) }); b.style.left = n.at / d * 100 + '%'; b.style.width = Math.max(0.3, (n.to - n.at) / d * 100) + '%'; ranges.append(b); }
    const laid = layoutCallouts(timed.map(n => ({ n, x: n.at / d * w, label: n.text.split('\n')[0] })), w), used = Math.max(0, ...laid.map(c => c.lane + 1)); calls.style.height = (used ? used * LANE_H + 8 : 10) + 'px';
    for (const c of laid) {
      const pin = h('button', { class: 'tlpin', title: `${fmt(c.n.at)}  ${c.n.text}`, onclick: () => player.seek(c.n.at) }); pin.style.left = c.x + 'px'; pin.style.height = (c.lane < 0 ? 8 : (used - c.lane) * LANE_H - 10) + 'px'; calls.append(pin);
      if (c.lane >= 0) { const lab = h('button', { class: 'tlcall', title: `${fmt(c.n.at)}  ${c.n.text}`, onclick: () => player.seek(c.n.at) }, c.label); lab.style.left = c.left + 'px'; lab.style.top = c.lane * LANE_H + 'px'; lab.style.maxWidth = c.w + 'px'; calls.append(lab); }
    }
  }
  function paintHeat() {
    const lv = heat.levels(player.dur() || item?.duration || 0); heatC.width = BINS; heatC.height = 1; const g = heatC.getContext('2d'), img = g.createImageData(BINS, 1);
    lv.forEach((v, i) => { const e = Math.sqrt(v); img.data.set([255, 95 + Math.round(120 * e), 210 - Math.round(60 * e), v ? Math.round(60 + 195 * e) : 0], i * 4); });      // √: one listen already shows g.putImageData(img, 0, 0);
    const best = lv.indexOf(Math.max(...lv)), d = player.dur() || 0; heatC.title = lv.some(v => v > 0) && d ? `Listening heatmap — hottest part around ${fmt((best + 0.5) / BINS * d)}` : 'Listening heatmap — fills in as you listen';
  }
  function paintScale() { const d = player.dur() || item?.duration || 0; scale.replaceChildren(...[0, 0.25, 0.5, 0.75, 1].map(f => h('span', {}, d ? fmt(f * d) : ''))); }

  // ---- the spectrogram (decoded in the background, cached)
  async function loadSpectro(it) {
    const my = ++tok, ctx = spec.getContext('2d'); ctx.clearRect(0, 0, spec.width, spec.height); spec.classList.remove('on'); tstat.textContent = '';
    const src = it.kind === 'render' ? it.mix : it.src, mode = spectroMode(); if (!src || mode === 'off') return;
    if (mode === 'local' && src.kind === 'remote') { tstat.textContent = 'Spectrogram off for server tracks (Settings → Now playing)'; return; }
    if ((src.size || 0) > 400e6) { tstat.textContent = 'File too large for a spectrogram'; return; }
    let s = await spectros.get(key); if (my !== tok) return;
    if (!s) {
      tstat.textContent = 'Drawing the spectrogram…';
      try {
        const buf = await (player._blob && player.item === it ? fetch(player._blob) : src.fetch ? src.fetch() : fetch(src.url())).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); });
        if (my !== tok) return; s = await analyseFile(buf, { duration: it.duration || player.dur() }); if (my !== tok) return; await spectros.put(key, s);
      } catch (e) { if (my === tok) tstat.textContent = `No spectrogram: ${e?.message || e}`; return; }
    }
    paintSpectro(spec, s); spec.classList.add('on'); tstat.textContent = '';
  }

  // ---- playhead, hover, click to seek
  plot.addEventListener('mousemove', e => { const r = plot.getBoundingClientRect(), f = (e.clientX - r.left) / r.width, d = player.dur(); hover.hidden = !d; hover.style.left = f * 100 + '%'; hover.dataset.t = fmt(f * d); });
  plot.addEventListener('mouseleave', () => { hover.hidden = true; });
  plot.addEventListener('click', e => { const r = plot.getBoundingClientRect(), d = player.dur(); if (d) player.seek((e.clientX - r.left) / r.width * d); });
  let heatPaint = 0;
  (function loop(now) {
    const d = player.dur(), p = player.pos(); heat.tick(p, d, player.playing);
    if (isShown()) { head.style.left = (d ? p / d * 100 : 0) + '%'; if (now - heatPaint > 2000) { heatPaint = now; paintHeat(); } }
    requestAnimationFrame(loop);
  })(0);
  setInterval(() => heat.flush(), 10000); addEventListener('pagehide', () => heat.flush());
  new ResizeObserver(() => paintNotes()).observe(tl);

  async function refresh() {
    const it = player.item, k = keyOf(it), changed = it !== item; item = it; if (k !== key) { key = k; rec = null; await heat.load(k); }
    rec = k ? await notes.get(k) : null; if (player.item !== it) return; paintInfo(); paintNext(); paintNotes(); paintHeat(); paintScale(); tl.hidden = !it;
    if (changed && it) loadSpectro(it); else if (!it) { tok++; }
  }
  let lastDur = 0;
  player.addEventListener('change', () => { if (player.item !== item || player.dur() !== lastDur) { lastDur = player.dur(); refresh(); } else { paintNext(); const k = info.querySelector('.kicker'); if (k) k.firstChild.textContent = player.playing ? 'Now playing' : 'Paused'; } });
  notes.addEventListener('change', () => refresh());
  return { refresh };
}
