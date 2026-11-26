// DJ mode: two decks (the player's BufDecks A and B) with tempo, sync, EQ and kills, and a crossfader between them.
// Tracks go onto a deck from the queue's A / B buttons, or by playing anything while DJ mode is on (it loads the idle deck).
import { keyName, keyRelation } from './mixer.js';

const FADES = [2, 4, 6, 8, 12, 16, 24];

export function initDJ({ player, h, fmt, settings, onSettings = () => {} }) {
  const root = h('section', { id: 'djPanel', class: 'djp', hidden: true, 'aria-label': 'DJ mode' });
  let els = null;

  function deckUi(deck) {
    const E = { deck };
    const slider = (min, max, step, val, fn, label, extra) => { const i = h('input', { type: 'range', min, max, step, value: val, 'aria-label': `deck ${deck.name} ${label}`, oninput: () => fn(+i.value) }); return [i, h('div', { class: 'sl' }, h('span', {}, label), i, extra || h('span'))]; };
    E.title = h('div', { class: 'dt' }); E.cv = h('canvas', { height: 64 });
    E.cv.addEventListener('pointerdown', ev => { if (!deck.buf) return; const r = E.cv.getBoundingClientRect(); deck.seek((ev.clientX - r.left) / r.width * deck.dur()); });
    E.info = h('div', { class: 'info' }); E.key = h('div', { class: 'info' });
    E.play = h('button', { class: 'btn', title: 'play / pause this deck', onclick: () => player.djToggle(deck) }, '▶');
    const nudge = s => () => deck.buf && deck.seek(deck.pos() + s), bar = n => () => deck.bpm() && deck.seek(deck.pos() + n * 240 / deck.bpm());
    const [tempoI, tempoRow] = slider(0.8, 1.25, 0.001, 1, v => deck.setRate(v), 'tempo', h('button', { class: 'btn', title: 'back to the original tempo', onclick: () => { deck.setRate(1); tempoI.value = 1; } }, '1.0'));
    E.tempo = tempoI;
    E.btns = h('div', { class: 'btns' },
      h('button', { class: 'btn', title: 'back to the start', onclick: () => deck.seek(0) }, '⏮'), E.play,
      h('button', { class: 'btn', title: 'match tempo and bar phase to the other deck (needs both tempos)', onclick: () => { if (!player.sync(deck)) E.note('sync needs a BPM on both decks'); tempoI.value = deck.rate; } }, 'sync'),
      h('button', { class: 'btn', title: 'nudge earlier (20 ms)', onclick: nudge(-0.02) }, '◂'), h('button', { class: 'btn', title: 'nudge later (20 ms)', onclick: nudge(0.02) }, '▸'),
      h('button', { class: 'btn', title: 'one bar back', onclick: bar(-1) }, '−bar'), h('button', { class: 'btn', title: 'one bar forward', onclick: bar(1) }, '+bar'));
    const eqRow = (b, label) => {
      const kb = h('button', { class: 'btn', title: `kill the ${label}s`, onclick: () => { deck.kill[b] = !deck.kill[b]; kb.classList.toggle('on', !!deck.kill[b]); deck.setEq(b); } }, 'kill');
      const [i, row] = slider(-24, 6, 0.5, deck.eq[b], v => deck.setEq(b, v), label, kb); E['eq_' + b] = i; E['kill_' + b] = kb; return row;
    };
    const [volI, volRow] = slider(0, 1.3, 0.01, 1, v => { deck.trim.gain.setTargetAtTime(v, deck.ctx.currentTime, 0.01); }, 'volume'); E.vol = volI;
    E.msg = h('div', { class: 'muted small dmsg' }); E.note = t => { E.msg.textContent = t; clearTimeout(E._nt); E._nt = setTimeout(() => { E.msg.textContent = ''; }, 3000); };
    E.root = h('div', { class: 'deck ' + deck.name }, h('div', { class: 'dh' }, h('b', {}, deck.name), E.title), E.cv, E.info, E.key, E.btns, tempoRow, eqRow('hi', 'high'), eqRow('mid', 'mid'), eqRow('lo', 'low'), volRow, E.msg);
    return E;
  }

  function build() {
    const a = deckUi(player.A), b = deckUi(player.B);
    const X = h('input', { type: 'range', min: 0, max: 1000, value: player.x * 1000, 'aria-label': 'crossfader', title: 'crossfader: A on the left, B on the right', oninput: () => { player.auto = null; player.setX(X.value / 1000); } });
    const fade = h('select', { title: 'auto-mix length', onchange: () => onSettings({ djFade: +fade.value }) }, ...FADES.map(v => h('option', { value: v, selected: (settings.djFade || 6) === v }, `auto-mix ${v} s`)));
    const match = h('button', { class: 'btn', title: 'auto-mix and crossfades: bring the next track in at this one’s tempo (shifts the pitch a little, like a record)', onclick: () => onSettings({ matchTempo: !settings.matchTempo }) }, 'match tempo');
    const badge = h('div', { class: 'badges' });
    const mid = h('div', { class: 'mixc' },
      h('div', { class: 'xl' }, h('span', {}, 'A'), h('span', {}, 'crossfader'), h('span', {}, 'B')), X,
      h('div', {}, h('button', { class: 'btn primary', title: 'bring in the other deck on the next bar line and crossfade', onclick: () => player.autoMix(+fade.value, !!settings.matchTempo) }, 'Auto-mix ⇄')),
      h('div', { class: 'row' }, fade, match),
      h('div', {}, h('button', { class: 'btn', title: 'load the queue’s next track onto the idle deck', onclick: () => player.djLoadNext() }, 'load next')), badge,
      h('div', { class: 'muted small' }, 'Tempo shifts the pitch like a record. Sync matches tempo and snaps the bars together (4/4 from the start of each track assumed). Playing a track loads it onto the idle deck.'),
      h('button', { class: 'link', onclick: () => player.setDJ(false) }, 'leave DJ mode'));
    root.replaceChildren(h('div', { class: 'decks' }, a.root, mid, b.root));
    els = { a, b, X, badge, fade, match };
  }

  function paintDeck(E) {
    const deck = E.deck, cv = E.cv, w = Math.round((cv.clientWidth || 300) * devicePixelRatio), H = Math.round(64 * devicePixelRatio);
    if (cv.width !== w || cv.height !== H) { cv.width = w; cv.height = H; }
    const c = cv.getContext('2d'), W = cv.width, css = n => getComputedStyle(root).getPropertyValue(n); c.clearRect(0, 0, W, H);
    const peaks = deck.wavePeaks(), dur = deck.dur();
    if (peaks) {
      const px = deck.pos() / dur * W, bar = deck.bpm() ? 240 / deck.bpm() / dur * W : 0, played = css('--accent'), wave = css('--faint');
      for (let x = 0; x < W; x++) { const v = peaks[Math.floor(x / W * peaks.length)]; c.fillStyle = x < px ? played : wave; c.fillRect(x, H / 2 - v * H * 0.45, 1, Math.max(1, v * H * 0.9)); }
      if (bar * 4 > 6) { c.fillStyle = css('--line'); for (let x = 0; x < W; x += bar * 4) c.fillRect(Math.round(x), 0, 1, H); }   // a line every 4 bars
      c.fillStyle = css('--ink'); c.fillRect(px, 0, Math.max(1, devicePixelRatio), H);
    } else { c.fillStyle = css('--muted'); c.font = `${12 * devicePixelRatio}px sans-serif`; c.fillText(deck.loading ? 'loading…' : 'empty: use A / B in the queue, or play a track', 8, H / 2 + 4); }
    const it = deck.item; E.title.textContent = it ? `${it.title}${it.artist ? ' — ' + it.artist : ''}` : '';
    E.play.textContent = deck.playing ? '❚❚' : '▶';
    const bars = it && deck.bpm() ? deck.pos() * deck.bpm() / 240 : 0;
    E.info.replaceChildren(h('span', {}, it ? `${fmt(deck.pos())} / ${fmt(dur)}` : ''), h('span', {}, it && deck.bpm() ? `bar ${Math.floor(bars) + 1}.${Math.floor((bars % 1) * 4) + 1}` : ''));
    const semi = Math.round(12 * Math.log2(deck.rate));
    E.key.replaceChildren(h('span', {}, it ? `${deck.bpm() ? deck.eff().toFixed(1) + ' BPM' : 'BPM ?'} (${deck.rate >= 1 ? '+' : ''}${((deck.rate - 1) * 100).toFixed(1)} %)` : ''),
      h('span', {}, it && it.key ? (semi ? `${keyName(it.key)} → ${keyName(it.key, semi)}` : keyName(it.key) || it.key) : ''));
    if (document.activeElement !== E.tempo) E.tempo.value = deck.rate;
    for (const b of ['lo', 'mid', 'hi']) { if (document.activeElement !== E['eq_' + b]) E['eq_' + b].value = deck.eq[b]; E['kill_' + b].classList.toggle('on', !!deck.kill[b]); }
    E.root.classList.toggle('live', deck === player.djMain());
  }

  function paint() {
    if (root.hidden || !els) return; const { a, b, X, badge, match } = els; paintDeck(a); paintDeck(b);
    if (player.auto) { const k = Math.max(0, Math.min(1, (player.ctx.currentTime - player.auto.t0) / player.auto.len)); X.value = (player.auto.to === player.B ? k : 1 - k) * 1000; }
    else if (document.activeElement !== X) X.value = player.x * 1000;
    match.classList.toggle('on', !!settings.matchTempo);
    const A = player.A, B = player.B; let parts = [];
    if (A.item && B.item) {
      const bd = A.eff() && B.eff() ? Math.abs(A.eff() - B.eff()) : null, rel = keyRelation(A.item.key, B.item.key, Math.round(12 * Math.log2(B.rate)) - Math.round(12 * Math.log2(A.rate)));
      parts = [bd != null ? h('span', { class: 'badge ' + (bd < 0.3 ? 'ok' : 'warn') }, bd < 0.3 ? 'tempos locked' : `Δ ${bd.toFixed(1)} BPM`) : '',
        rel ? h('span', { class: 'badge ' + (rel === 'clash' ? 'warn' : 'ok') }, rel === 'clash' ? 'keys may clash' : `keys: ${rel}`) : ''];
    }
    const sig = parts.map(p => p && p.textContent).join('|'); if (badge.dataset.sig !== sig) { badge.dataset.sig = sig; badge.replaceChildren(...parts); }
  }

  function show(on) { root.hidden = !on; if (on) { build(); paint(); } else els = null; }
  return { el: root, show, paint };
}
