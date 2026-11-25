// Queue + transport over two engines: an <audio> element for ordinary tracks, the StemDeck for stem renders.
// One AudioContext (the visualizer feed's) carries both, so the visualizer analyses whatever is playing.
import { StemDeck } from './stems.js';

export class Player extends EventTarget {
  constructor(feed) {
    super(); this.feed = feed; feed._init();
    this.audio = new Audio(); this.audio.crossOrigin = 'anonymous'; this.audio.preload = 'auto'; this.deck = new StemDeck(feed);
    this.mode = 'element'; this.queue = []; this.index = -1; this.order = []; this.shuffle = false; this.repeat = 'off'; this.loading = null;
    this.volume = Number(localStorage.getItem('bootleg.volume') ?? 0.9); this.setVolume(this.volume);
    feed.fromElement(this.audio);
    for (const ev of ['play', 'pause', 'loadedmetadata', 'durationchange']) this.audio.addEventListener(ev, () => this._emit());
    this.audio.addEventListener('ended', () => this._ended());
    setInterval(() => { if (this.mode === 'deck' && this.deck.playing && this.deck.pos() >= this.deck.dur - 0.02) { this.deck.pause(); this.deck.offset = this.deck.dur; this._ended(); } }, 200);
    if ('mediaSession' in navigator) { const m = navigator.mediaSession; m.setActionHandler('play', () => this.play()); m.setActionHandler('pause', () => this.pause()); m.setActionHandler('previoustrack', () => this.prev()); m.setActionHandler('nexttrack', () => this.next()); m.setActionHandler('seekto', e => this.seek(e.seekTime)); }
  }
  _emit() { this.dispatchEvent(new Event('change')); }
  get item() { return this.queue[this.index] || null; }
  get playing() { return this.mode === 'deck' ? this.deck.playing : !this.audio.paused; }
  pos() { return this.mode === 'deck' ? this.deck.pos() : this.audio.currentTime || 0; }
  dur() { return this.mode === 'deck' ? this.deck.dur : (isFinite(this.audio.duration) ? this.audio.duration : (this.item && this.item.duration) || 0); }

  // ---- queue
  _rebuild() { const idx = this.queue.map((_, i) => i); if (this.shuffle) { for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; } const k = idx.indexOf(this.index); if (k > 0) { idx.splice(k, 1); idx.unshift(this.index); } } this.order = idx; }
  async playList(items, start = 0) { this.queue = items.slice(); this.index = Math.max(0, Math.min(start, items.length - 1)); this._rebuild(); await this._playCurrent(); }
  enqueue(items, next = false) { const at = next ? this.index + 1 : this.queue.length; this.queue.splice(at, 0, ...items); if (this.index < 0) { this.index = 0; this._rebuild(); this._playCurrent(); return; } this._rebuild(); this._emit(); }
  remove(i) { if (i === this.index) { this.queue.splice(i, 1); this.index = Math.min(i, this.queue.length - 1); this._rebuild(); if (this.index >= 0) this._playCurrent(); else this.stop(); return; } this.queue.splice(i, 1); if (i < this.index) this.index--; this._rebuild(); this._emit(); }
  clear() { this.stop(); this.queue = []; this.index = -1; this.order = []; this._emit(); }
  setShuffle(v) { this.shuffle = v; this._rebuild(); this._emit(); }
  setRepeat(v) { this.repeat = v; this._emit(); }
  async jump(i) { this.index = i; this._rebuild(); await this._playCurrent(); }

  // ---- transport
  async _playCurrent() { const item = this.item; if (!item) return; await this._load(item); if (this.item === item) this.play(); }
  async _load(item) {
    this.deck.pause(); this.audio.pause();
    if (item.kind === 'render') {
      this.mode = 'deck'; this.audio.removeAttribute('src'); this.audio.load(); this.feed.fromNode(this.deck.master); this.loading = { n: 0, total: item.stems.length }; this._emit();
      const ok = await this.deck.load(item, (n, total) => { this.loading = { n, total }; this._emit(); }); this.loading = null;
      if (!ok) return;
    } else { this.mode = 'element'; this.deck.dispose(); this.feed.fromElement(this.audio); await this._setSrc(item); }
    this._media(item); this._emit();
  }
  // Some webviews (WebKitGTK/GStreamer) cannot stream media from the custom asset:// scheme. If the element rejects the URL,
  // fetch the file once (the asset protocol does allow that) and play it from a blob: URL instead.
  async _setSrc(item) {
    const a = this.audio; if (this._blob) { URL.revokeObjectURL(this._blob); this._blob = null; }
    a.src = item.src.url(); if (item.src.kind !== 'tauri') return;
    await new Promise(ok => { const done = () => { a.removeEventListener('error', fail); a.removeEventListener('loadedmetadata', done); ok(); }, fail = async () => { a.removeEventListener('loadedmetadata', done); a.removeEventListener('error', fail); try { this._blob = URL.createObjectURL(await (await fetch(item.src.url())).blob()); if (this.item === item) a.src = this._blob; } catch { /* leave the error visible */ } ok(); }; a.addEventListener('error', fail, { once: true }); a.addEventListener('loadedmetadata', done, { once: true }); });
  }
  play() { this.feed.ctx.resume(); if (this.mode === 'deck') this.deck.play(); else this.audio.play().catch(() => {}); this._emit(); }
  pause() { if (this.mode === 'deck') this.deck.pause(); else this.audio.pause(); this._emit(); }
  toggle() { this.playing ? this.pause() : this.play(); }
  stop() { this.deck.pause(); this.audio.pause(); this._emit(); }
  seek(t) { if (this.mode === 'deck') this.deck.seek(t); else this.audio.currentTime = Math.max(0, t); this._emit(); }
  setVolume(v) { this.volume = v; this.audio.volume = v; this.deck.setVolume(v); try { localStorage.setItem('bootleg.volume', String(v)); } catch { /* private mode */ } this._emit(); }
  next() { this._step(1, false); }
  prev() { if (this.pos() > 3) this.seek(0); else this._step(-1, false); }
  _step(dir, natural) {
    if (!this.queue.length) return; let p = this.order.indexOf(this.index) + dir;
    if (p >= this.order.length) { if (this.repeat === 'all' || !natural) p = 0; else { this.stop(); return; } } if (p < 0) p = this.order.length - 1;
    this.index = this.order[p]; this._playCurrent();
  }
  _ended() { if (this.repeat === 'one') { this.seek(0); this.play(); } else this._step(1, true); }
  _media(item) { if (!('mediaSession' in navigator)) return; navigator.mediaSession.metadata = new MediaMetadata({ title: item.title || '', artist: item.artist || '', album: item.album || '', artwork: item.coverUrl ? [{ src: item.coverUrl }] : [] }); }
}
