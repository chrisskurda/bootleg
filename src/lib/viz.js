// The visualizer view: a pack in a frame, fed with what the player is playing (spectrum, stems, song info), with the pack's own controls and Look/FX.
import { control, defaultsOf, LOOKS, h } from './controls.js';

const PACKS = '/vendor/bootleg-vizualizer/packs/';
export class VizHost {
  constructor({ stage, packSelect, paramsEl, lookEl, feed, player }) {
    Object.assign(this, { stage, packSelect, paramsEl, lookEl, feed, player }); this.frame = stage.querySelector('iframe'); this.packs = []; this.pack = null; this.params = {}; this.look = { ...window.LOOK_DEFAULTS }; this.running = false; this._last = performance.now(); this._css = '';
    this.zero = { s: new Float32Array(64), w: new Float32Array(128) };
  }
  async init() {
    this.packs = (await (await fetch('/packs.json')).json()).filter(p => !p.id.startsWith('_'));
    this.packSelect.replaceChildren(...this.packs.map(p => h('option', { value: p.id }, p.name))); this.packSelect.onchange = () => this.setPack(this.packSelect.value);
    this.lookEl.replaceChildren(...LOOKS.map(([k, mn, mx, st, lb]) => control(this.look, k, { type: 'number', min: mn, max: mx, step: st, label: lb })));
    let want = null; try { want = localStorage.getItem('bootleg.pack'); } catch { /* ignore */ } this.setPack(this.packs.find(p => p.id === want)?.id || this.packs.find(p => p.id === 'spec-radial')?.id || this.packs[0].id);
  }
  setPack(id) {
    this.pack = this.packs.find(p => p.id === id); if (!this.pack) return; this.packSelect.value = id; this.params = defaultsOf(this.pack); try { localStorage.setItem('bootleg.pack', id); } catch { /* ignore */ }
    this.frame.src = PACKS + id + '/' + (this.pack.page || 'index.html'); const defs = Object.entries(this.pack.params || {});
    this.paramsEl.replaceChildren(...(defs.length ? defs.map(([k, d]) => control(this.params, k, d)) : [h('div', { class: 'none' }, 'This pack has no settings.')]));
  }
  resetLook() { Object.assign(this.look, window.LOOK_DEFAULTS); this.lookEl.replaceChildren(...LOOKS.map(([k, mn, mx, st, lb]) => control(this.look, k, { type: 'number', min: mn, max: mx, step: st, label: lb }))); }
  start() { if (this.running) return; this.running = true; this._last = performance.now(); requestAnimationFrame(t => this._tick(t)); }
  stop() { this.running = false; }
  fullscreen() { (this.stage.requestFullscreen || this.stage.webkitRequestFullscreen).call(this.stage); }
  _tick(now) {
    if (!this.running) return; const dt = Math.max(0, Math.min(0.1, (now - this._last) / 1000)); this._last = now;
    const p = this.player, item = p.item, A = this.feed.update(dt), w = this.frame.contentWindow;
    if (!A.spectrum) { A.spectrum = this.zero.s; A.wave = this.zero.w; A.past = () => this.zero.s; }
    A.live = !!item; A.t = item ? p.pos() : now / 1000; A.duration = item ? p.dur() : 0;
    const meta = item ? { title: item.title, artist: item.artist, album: item.album, bpm: item.bpm, key: item.key, duration: item.duration, sections: item.sections || [], cover: item.coverUrl || undefined } : {};
    A.meta = meta; Object.assign(A, window.metaAt(meta, A.t));
    if (p.mode === 'deck' && A.stems) window.VisStems.applyClips(A.stems, p.deck.clips, A.t); else window.VisStems.attach(A, []);
    try { w.__META = meta; w.__AUDIO = A; w.__PARAMS = this.params; w.__FX = window.lookFx(this.look); } catch { /* the frame is still loading */ }
    const css = window.lookToCss(this.look, A, now / 1000); if (css !== this._css) { this.frame.style.filter = css; this._css = css; }
    this.lastA = A; requestAnimationFrame(t => this._tick(t));
  }
}
