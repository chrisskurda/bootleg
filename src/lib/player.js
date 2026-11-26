// Queue + transport over two engines: an <audio> element for ordinary tracks, the StemDeck for stem renders.
// One AudioContext (the visualizer feed's) carries both, so the visualizer analyses whatever is playing.
import { StemDeck } from './stems.js';

// A blob: URL needs a media type or WebKit may refuse to play it (a fetched Response often has none).
const MIME = { flac: 'audio/flac', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', mp4: 'audio/mp4', ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', aif: 'audio/aiff', aiff: 'audio/aiff', caf: 'audio/x-caf' };
const mimeOf = (r, name) => { const h = (r.headers && r.headers.get && r.headers.get('content-type')) || ''; return /^audio\//.test(h) ? h.split(';')[0] : MIME[(name.split('.').pop() || '').toLowerCase()] || ''; };

export class Player extends EventTarget {
  constructor(feed) {
    super(); this.feed = feed; feed._init();
    this.audio = new Audio(); this.audio.crossOrigin = 'anonymous'; this.audio.preload = 'auto'; this.deck = new StemDeck(feed);
    this.mode = 'element'; this._tok = 0; this._wantPlay = false; this.lastError = ''; this.stemsState = 'none'; this.stemPolicy = 'visualizer'; this.hooks = {}; this.queue = []; this.index = -1; this.order = []; this.shuffle = false; this.repeat = 'off'; this.loading = null;
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
  // Adds to the queue. Starts playing (and returns true) when there was nothing to continue: an empty queue, or one that ran out.
  enqueue(items, next = false) {
    if (!items.length) return false; const at = next ? this.index + 1 : this.queue.length; this.queue.splice(at, 0, ...items);
    if (this.index < 0 || this.ended) { this.index = this.index < 0 ? 0 : at; this._rebuild(); this._playCurrent(); return true; }
    this._rebuild(); this._emit(); return false;
  }
  // Plays these at once without throwing the queue away: they go in after the current track, the first of them starts.
  async playNow(items, start = 0) {
    if (!items.length) return; if (this.index < 0 || !this.queue.length) return this.playList(items, start);
    const at = this.index + 1; this.queue.splice(at, 0, ...items); this.index = at + Math.max(0, Math.min(start, items.length - 1)); this._rebuild(); await this._playCurrent();
  }
  remove(i) { if (i === this.index) { this.queue.splice(i, 1); this.index = Math.min(i, this.queue.length - 1); this._rebuild(); if (this.index >= 0) this._playCurrent(); else this.stop(); return; } this.queue.splice(i, 1); if (i < this.index) this.index--; this._rebuild(); this._emit(); }
  clear() { this.stop(); this.queue = []; this.index = -1; this.order = []; this._emit(); }
  setShuffle(v) { this.shuffle = v; this._rebuild(); this._emit(); }
  setRepeat(v) { this.repeat = v; this._emit(); }
  async jump(i) { this.index = i; this._rebuild(); await this._playCurrent(); }

  // ---- transport
  async _playCurrent() { const item = this.item; if (!item) return; this.ended = false; await this._load(item); if (this.item === item) this.play(); }
  // A stem set plays from its mix straight away (one file, instant start). Its stems are decoded only when wanted — the stem
  // mixer, a stem-aware visualizer, or the "always" setting — and then take over seamlessly at the current position.
  async _load(item) {
    this.deck.pause(); this.audio.pause(); this.loading = null; this._stemsFor = null;
    if (item.kind === 'render' && !item.mix) {                                  // no mix file: the stems are all there is
      this.mode = 'deck'; this.stemsState = 'loading'; this.audio.removeAttribute('src'); this.audio.load(); this.feed.fromNode(this.deck.master); this.loading = { n: 0, total: item.stems.length }; this._emit();
      await this.hooks.loadClips?.(item); const ok = await this.deck.load(item, (n, total) => { this.loading = { n, total }; this._emit(); }); this.loading = null; if (!ok) return; this.stemsState = 'ready';
    } else {
      this.mode = 'element'; this.deck.dispose(); this.feed.fromElement(this.audio); this.stemsState = item.kind === 'render' ? 'unloaded' : 'none'; await this._setSrc(item.kind === 'render' ? item.mix : item.src);
    }
    this._applyOut(); this._media(item); this._emit();
    if (item.kind === 'render' && this.stemPolicy === 'auto') this.ensureStems();
  }
  async ensureStems() {
    const item = this.item; if (!item || item.kind !== 'render' || this.stemsState !== 'unloaded' || this.mode !== 'element') return;
    this.stemsState = 'loading'; this._stemsFor = item; this.loading = { n: 0, total: item.stems.length }; this._emit();
    try {
      await this.hooks.loadClips?.(item); const ok = await this.deck.load(item, (n, total) => { this.loading = { n, total }; this._emit(); });
      if (!ok || this.item !== item || this._stemsFor !== item) { this.loading = null; return; }
      const pos = this.audio.currentTime || 0, was = !this.audio.paused;
      this.deck.offset = pos; this.feed.fromNode(this.deck.master); this.mode = 'deck'; this.audio.pause(); this._applyOut(); this.stemsState = 'ready'; this.loading = null; if (was) this.deck.play(pos);
    } catch (e) { this.loading = null; this.stemsState = 'unloaded'; this.stemsError = String(e && e.message || e); }
    this._emit();
  }
  // Give the memory back: go back to playing the mix from where the stems were.
  unloadStems() {
    if (this.mode !== 'deck' || !this.item?.mix) return; const pos = this.deck.pos(), was = this.deck.playing;
    this.deck.dispose(); this.mode = 'element'; this.feed.fromElement(this.audio); this.audio.currentTime = pos; this.stemsState = 'unloaded'; this._applyOut(); if (was) this.audio.play().catch(() => {}); this._emit();
  }
  // While casting, local playback keeps running (the visualizer and timeline need it) but is silent: the output node is
  // disconnected from the speakers, the analysers stay connected.
  setLocalOutput(on) { this.localOut = on !== false; this._applyOut(); }
  _applyOut() {
    const ctx = this.feed.ctx; if (!ctx) return; const node = this.mode === 'deck' ? this.deck.master : this.audio._mes; if (!node) return; const bus = this._bus();
    for (const n of [this.deck.master, this.audio._mes]) if (n) { try { n.disconnect(ctx.destination); } catch { /* not connected */ } try { n.disconnect(bus); } catch { /* not connected */ } }
    if (this.localOut !== false) node.connect(bus);
  }
  // What reaches the speakers goes through one bus, where extensions can insert processing (an equalizer, …). The analysers
  // (visualizer, meters) listen before it. insert(input, output = input) → a function that takes it out again.
  _bus() {
    const ctx = this.feed.ctx; if (!this.bus) { this.bus = ctx.createGain(); this.inserts = []; this._wire(); } return this.bus;
  }
  _wire() {
    const ctx = this.feed.ctx; let prev = this.bus; try { prev.disconnect(); } catch { /* fresh */ }
    for (const x of this.inserts) { try { x.out.disconnect(); } catch { /* fresh */ } prev.connect(x.in); prev = x.out; } prev.connect(ctx.destination);
  }
  insert(input, output = input) { this._bus(); const x = { in: input, out: output }; this.inserts.push(x); this._wire(); return () => { const i = this.inserts.indexOf(x); if (i < 0) return; this.inserts.splice(i, 1); try { x.out.disconnect(); } catch { /* gone */ } this._wire(); }; }
  // Some webviews cannot play a stream the element is pointed at (WebKitGTK/GStreamer and asset://, cross-origin servers without
  // CORS, ...). When the element errors — or goes silent for too long — fetch the file ourselves (the asset protocol / the desktop
  // HTTP plugin can) and play it from a blob: URL. This never blocks playback from starting: the element is tried first, at once.
  async _setSrc(src) {
    const a = this.audio, tok = ++this._tok, cur = this.item; if (this._blob) { URL.revokeObjectURL(this._blob); this._blob = null; }
    clearTimeout(this._dog); a.src = src.url(); if (src.kind !== 'tauri' && src.kind !== 'remote') return;
    const fallback = async why => {
      if (tok !== this._tok || this._blob || this.item !== cur) return;
      try { const r = await (src.fetch ? src.fetch() : fetch(src.url())); if (!r.ok) throw new Error('HTTP ' + r.status); this._blob = URL.createObjectURL(new Blob([await r.arrayBuffer()], { type: mimeOf(r, src.name) })); if (tok === this._tok) { a.src = this._blob; if (this._wantPlay) a.play().catch(() => {}); } }
      catch (e) { this._fail(`Could not play “${cur?.title || src.name}”: ${why}${e && e.message ? ' (' + e.message + ')' : ''}`); }
    };
    a.addEventListener('error', () => fallback(a.error ? `the player rejected it (code ${a.error.code})` : 'load error'), { once: true });
    this._dog = setTimeout(() => { if (tok === this._tok && this._wantPlay && a.readyState < 2 && !this._blob) fallback('it did not start loading'); }, 7000);     // silent stall (no error event)
  }
  _fail(msg) { this.lastError = msg; this.dispatchEvent(new CustomEvent('playerror', { detail: msg })); }
  play() { this._wantPlay = true; this.feed.ctx.resume(); if (this.mode === 'deck') this.deck.play(); else this.audio.play().catch(e => { if (e && e.name !== 'AbortError' && !this._blob && e.name !== 'NotSupportedError') this._fail(`Playback was blocked: ${e.message || e.name}`); }); this._emit(); }
  pause() { this._wantPlay = false; if (this.mode === 'deck') this.deck.pause(); else this.audio.pause(); this._emit(); }
  toggle() { this.playing ? this.pause() : this.play(); }
  stop() { this.deck.pause(); this.audio.pause(); this._emit(); }
  seek(t) { if (this.mode === 'deck') this.deck.seek(t); else this.audio.currentTime = Math.max(0, t); this.dispatchEvent(new CustomEvent('seek', { detail: Math.max(0, t) })); this._emit(); }
  setVolume(v) { this.dispatchEvent(new CustomEvent('volume', { detail: v })); this.volume = v; this.audio.volume = v; this.deck.setVolume(v); try { localStorage.setItem('bootleg.volume', String(v)); } catch { /* private mode */ } this._emit(); }
  next() { this._step(1, false); }
  prev() { if (this.pos() > 3) this.seek(0); else this._step(-1, false); }
  _step(dir, natural) {
    if (!this.queue.length) return; let p = this.order.indexOf(this.index) + dir;
    if (p >= this.order.length) { if (this.repeat === 'all' || !natural) p = 0; else { this.ended = true; this.stop(); return; } } if (p < 0) p = this.order.length - 1;
    this.index = this.order[p]; this._playCurrent();
  }
  _ended() { if (this.repeat === 'one') { this.seek(0); this.play(); } else this._step(1, true); }
  _media(item) { if (!('mediaSession' in navigator)) return; navigator.mediaSession.metadata = new MediaMetadata({ title: item.title || '', artist: item.artist || '', album: item.album || '', artwork: item.coverUrl ? [{ src: item.coverUrl }] : [] }); }
}
