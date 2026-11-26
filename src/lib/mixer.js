// Decks for gapless playback, crossfades and DJ mode (the audition page's mixer, brought into bootleg).
// A BufDeck plays a whole decoded track on the audio clock, so the next one can start on the exact sample the last one ends
// (gapless) or overlap it with an equal-power fade. Chain: source → low/mid/high EQ → trim → fade → the player's mix bus.
// The pure helpers (keys, tempo, timing) are exported for the tests.

export const MAX_DECODE_SECONDS = 20 * 60;     // longer tracks stay on the streaming player (a decoded hour is over a gigabyte)
export const MAX_DECODE_BYTES = 300 * 1048576;

const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export function keyInfo(k) {                   // "E m", "F# m", "c#m", "C", "Abmaj" → { pc 0-11, minor }
  const m = /^([a-gA-G])\s*([#b♯♭]?)\s*(m|min|minor|maj|major)?\s*$/.exec(String(k || '').trim()); if (!m) return null;
  const pc = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[m[1].toLowerCase()] + (/[#♯]/.test(m[2]) ? 1 : /[b♭]/.test(m[2]) ? -1 : 0);
  return { pc: (pc + 12) % 12, minor: /^m(in|inor)?$/.test(m[3] || '') };
}
export function keyName(k, semis = 0) { const x = keyInfo(k); return x ? NOTE[(x.pc + semis + 120) % 12] + (x.minor ? 'm' : '') : ''; }
// how two keys sit together, b shifted by `semis` (a tempo change moves the pitch): 'same' | 'relative' | 'adjacent' | 'clash' | null
export function keyRelation(a, b, semis = 0) {
  const x = keyInfo(a), y = keyInfo(b); if (!x || !y) return null;
  const yp = (y.pc + semis + 120) % 12, up = (yp - x.pc + 12) % 12;
  if (x.minor === y.minor) return up === 0 ? 'same' : up === 7 || up === 5 ? 'adjacent' : 'clash';
  const rel = x.minor ? (yp - x.pc + 12) % 12 === 3 : (x.pc - yp + 12) % 12 === 3;      // A minor ↔ C major
  return rel ? 'relative' : 'clash';
}
// the playback rate that puts `bpm` on `target`, also trying double and half time; 1 when it would take more than −20 / +25 %
export function matchRate(target, bpm) {
  if (!(target > 0) || !(bpm > 0)) return 1;
  const c = [target, target * 2, target / 2].map(t => t / bpm).filter(r => r >= 0.8 && r <= 1.25);
  return c.length ? c.sort((a, b) => Math.abs(Math.log(a)) - Math.abs(Math.log(b)))[0] : 1;
}
// Where in the outgoing track (its own seconds) the next one starts. Gapless: the very end. A crossfade: `xf` real seconds
// before the end, moved back to a bar line when the tempo is known and matching is on (4/4 from the start assumed).
export function transitionStart({ dur, pos, rate = 1, xf = 0, bpm = 0, onBar = false }) {
  let start = dur;
  if (xf > 0) {
    start = dur - xf * rate;
    if (onBar && bpm > 0) { const bar = 240 / bpm, q = Math.floor(start / bar) * bar; if (q > pos + 1) start = q; }
  }
  return Math.max(0, Math.max(start, Math.min(dur, pos + 0.25)));
}
const curves = (() => { const n = 128, up = new Float32Array(n), down = new Float32Array(n); for (let i = 0; i < n; i++) { const x = i / (n - 1); up[i] = Math.sin(x * Math.PI / 2); down[i] = Math.cos(x * Math.PI / 2); } return { up, down }; })();
// fade a gain in or out over [t, t + len] (equal power), from its level at t
export function fadeGain(g, t, len, dir, from = dir === 'in' ? 0 : 1) {
  const t0 = Math.max(0, t - 0.001); g.cancelScheduledValues(t0); g.setValueAtTime(from, t0);      // the anchor just before: a curve may not share its start with another event
  if (len <= 0.002) { g.setValueAtTime(dir === 'in' ? 1 : 0, t); return; }
  const c = dir === 'in' ? curves.up : curves.down, k = dir === 'in' ? 1 : from;
  g.setValueCurveAtTime(k === 1 ? c : c.map(v => v * k), t, len); g.setValueAtTime(dir === 'in' ? 1 : 0, t + len + 0.001);
}
export function peaksOf(buf, W = 900) {
  const ch = buf.getChannelData(0), step = ch.length / W, out = new Float32Array(W); let mx = 1e-6;
  for (let i = 0; i < W; i++) { let m = 0; for (let j = Math.floor(i * step), e = Math.floor((i + 1) * step); j < e; j += 24) { const v = Math.abs(ch[j]); if (v > m) m = v; } out[i] = m; mx = Math.max(mx, m); }
  return out.map(v => v / mx);
}
// Can this item be decoded whole without hurting? (known length or size under the limits; a stem set needs a mix or stems)
export function decodable(item, knownSeconds) {
  if (!item) return false;
  const secs = knownSeconds || item.duration || (item.manifest && item.manifest.seconds) || 0;
  if (secs > MAX_DECODE_SECONDS) return false;
  if (item.kind === 'render') return !!item.mix || item.stems.length > 0;
  const size = item.src && item.src.size; if (size > MAX_DECODE_BYTES) return false;
  return !!item.src;
}
const bytesOf = async src => { const r = await (src.fetch ? src.fetch() : fetch(src.url())); if (!r.ok) throw new Error(`${src.name || 'audio'}: HTTP ${r.status}`); return r.arrayBuffer(); };
// The whole track as one buffer: the file, a stem set's mix, or — a stem set without one — its stems summed at their levels.
export async function decodeItem(ctx, item) {
  if (item.kind !== 'render') return ctx.decodeAudioData(await bytesOf(item.src));
  if (item.mix) return ctx.decodeAudioData(await bytesOf(item.mix));
  const gains = (item.manifest && item.manifest.stems_gain_db) || {}, bufs = [];
  for (const s of item.stems) bufs.push({ g: 10 ** ((gains[s.name] ?? 0) / 20), b: await ctx.decodeAudioData(await bytesOf(s.src)) });
  const rate = bufs[0].b.sampleRate, len = Math.max(...bufs.map(x => Math.ceil(x.b.duration * rate))), out = ctx.createBuffer(2, len, rate);
  for (let c = 0; c < 2; c++) {
    const o = out.getChannelData(c);
    for (const { g, b } of bufs) { if (b.sampleRate !== rate) continue; const d = b.getChannelData(Math.min(c, b.numberOfChannels - 1)); for (let i = 0; i < d.length; i++) o[i] += d[i] * g; }
  }
  return out;
}

export class BufDeck {
  constructor(ctx, name, out) {
    Object.assign(this, { ctx, name, item: null, buf: null, peaks: null, rate: 1, offset: 0, t0: 0, playing: false, src: null, loading: null, eq: { lo: 0, mid: 0, hi: 0 }, kill: {}, onend: null, _id: 0 });
    this.lo = ctx.createBiquadFilter(); this.lo.type = 'lowshelf'; this.lo.frequency.value = 200;
    this.mid = ctx.createBiquadFilter(); this.mid.type = 'peaking'; this.mid.frequency.value = 1000; this.mid.Q.value = 0.6;
    this.hi = ctx.createBiquadFilter(); this.hi.type = 'highshelf'; this.hi.frequency.value = 3500;
    this.trim = ctx.createGain(); this.fade = ctx.createGain(); this.fade.gain.value = 0;
    this.lo.connect(this.mid); this.mid.connect(this.hi); this.hi.connect(this.trim); this.trim.connect(this.fade); this.fade.connect(out);
  }
  bpm() { return (this.item && +this.item.bpm) || 0; }
  eff() { return this.bpm() * this.rate; }
  dur() { return this.buf ? this.buf.duration : 0; }
  pos() { return this.playing ? Math.min(this.dur(), this.offset + Math.max(0, this.ctx.currentTime - this.t0) * this.rate) : this.offset; }
  // seconds of real time until it runs out
  left() { return this.buf ? Math.max(0, (this.dur() - this.pos()) / this.rate) : 0; }
  // load (decode) a track; the same item again is free. A newer load wins over an older one still decoding.
  async load(item) {
    if (this.item === item && this.buf) return true;
    const id = ++this._id; this.pause(); this.stopSrc(); this.loading = item; this.item = item; this.buf = null; this.peaks = null; this.offset = 0; this.rate = 1;
    try { const buf = await decodeItem(this.ctx, item); if (id !== this._id) return false; this.buf = buf; this.peaks = null; return true; }
    catch (e) { if (id === this._id) { this.item = null; } throw e; }
    finally { if (id === this._id) this.loading = null; }
  }
  wavePeaks() { if (!this.peaks && this.buf) this.peaks = peaksOf(this.buf); return this.peaks; }
  unload() { this._id++; this.pause(); this.stopSrc(); this.item = null; this.buf = null; this.peaks = null; this.loading = null; this.offset = 0; this.rate = 1; }
  setEq(b, db) { if (db != null) this.eq[b] = db; this[b].gain.setTargetAtTime(this.kill[b] ? -40 : this.eq[b], this.ctx.currentTime, 0.01); }
  flat() { this.kill = {}; for (const b of ['lo', 'mid', 'hi']) this.setEq(b, 0); this.trim.gain.setTargetAtTime(1, this.ctx.currentTime, 0.02); }
  setRate(r) {
    r = Math.max(0.5, Math.min(2, r));
    if (this.playing && this.ctx.currentTime >= this.t0) { this.offset = this.pos(); this.t0 = this.ctx.currentTime; }   // keep the position continuous
    this.rate = r; if (this.src) this.src.playbackRate.value = r;
  }
  play(at, from) {
    if (!this.buf) return; const c = this.ctx; at = at ?? c.currentTime + 0.03; from = from ?? this.offset; if (from >= this.dur() - 0.05) from = 0;
    this.stopSrc(); const s = c.createBufferSource(); s.buffer = this.buf; s.playbackRate.value = this.rate; s.connect(this.lo); s.start(at, Math.max(0, from));
    s.onended = () => { if (this.src !== s) return; this.src = null; if (this.playing && this.pos() >= this.dur() - 0.05) { this.playing = false; this.offset = this.dur(); this.onend?.(this); } };
    this.src = s; this.offset = Math.max(0, from); this.t0 = at; this.playing = true;
  }
  pause() { if (!this.playing) return; this.offset = this.pos(); this.stopSrc(); this.playing = false; }
  stopSrc() { const s = this.src; this.src = null; if (s) { s.onended = null; try { s.stop(); } catch { /* not started */ } s.disconnect(); } }
  seek(t) { t = Math.max(0, Math.min(this.dur() - 0.05, t)); if (this.playing) this.play(undefined, t); else this.offset = t; }
  setFade(v) { const g = this.fade.gain, n = this.ctx.currentTime; g.cancelScheduledValues(0); g.setValueAtTime(v, n); }
}
