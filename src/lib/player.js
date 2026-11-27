// Queue + transport over three engines, all summed into one mix bus (this.out) that the visualizer listens to:
//   element  an <audio> element: starts at once, streams, no size limit
//   deck     the StemDeck, for a stem set whose stems are loaded
//   buf      a decoded BufDeck (A or B, mixer.js): plays on the audio clock, so the next track can start on the exact sample
//            the last one ends (gapless) or crossfade with it. A track starts on the element and moves onto a deck, in place,
//            a couple of seconds in; the next track is decoded onto the other deck ahead of time.
// DJ mode hands the two decks to you: tempo, sync, EQ, crossfader (the audition page's DJ mode).
import { StemDeck } from './stems.js';
import { BufDeck, decodable, fadeGain, matchRate, transitionStart } from './mixer.js';

// A blob: URL needs a media type or WebKit may refuse to play it (a fetched Response often has none).
const MIME = { flac: 'audio/flac', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', mp4: 'audio/mp4', ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', aif: 'audio/aiff', aiff: 'audio/aiff', caf: 'audio/x-caf' };
const mimeOf = (r, name) => { const h = (r.headers && r.headers.get && r.headers.get('content-type')) || ''; return /^audio\//.test(h) ? h.split(';')[0] : MIME[(name.split('.').pop() || '').toLowerCase()] || ''; };
export const TRANSITIONS = { off: 'Off: each track loads when the last one ends', gapless: 'Gapless (default)', 2: 'Crossfade 2 s', 4: 'Crossfade 4 s', 6: 'Crossfade 6 s', 8: 'Crossfade 8 s', 12: 'Crossfade 12 s', 16: 'Crossfade 16 s', 24: 'Crossfade 24 s' };
export const transitionOf = (v, match) => v === 'off' ? { mode: 'off', seconds: 0, match: false } : +v > 0 ? { mode: 'crossfade', seconds: +v, match: !!match } : { mode: 'gapless', seconds: 0, match: false };
const PREPARE = 45;          // seconds before a transition that the next track starts decoding
const PROMOTE_AFTER = 2;     // seconds into a track before it moves from the element onto a deck (skipping through costs nothing)

export class Player extends EventTarget {
  constructor(feed) {
    super(); this.feed = feed; feed._init(); const ctx = this.ctx = feed.ctx;
    this.audio = new Audio(); this.audio.crossOrigin = 'anonymous'; this.audio.preload = 'auto'; this.deck = new StemDeck(feed);
    this.mode = 'element'; this._tok = 0; this._ptok = 0; this._wantPlay = false; this.lastError = ''; this.stemsState = 'none'; this.stemPolicy = 'visualizer'; this.hooks = {}; this.queue = []; this.index = -1; this.order = []; this.shuffle = false; this.repeat = 'off'; this.loading = null;
    this.transition = transitionOf('gapless'); this.plan = null; this.dj = false; this.x = 0; this.auto = null; this._fadingUntil = 0;
    // the graph: every source → its own fade gain → out (analysed) → volume → [limiter] → bus (extension inserts) → speakers
    this.out = ctx.createGain(); this.vol = ctx.createGain(); this.out.connect(this.vol);
    this.lim = ctx.createDynamicsCompressor(); this.lim.threshold.value = -1.5; this.lim.knee.value = 0; this.lim.ratio.value = 20; this.lim.attack.value = 0.002; this.lim.release.value = 0.12;   // two decks summed must not clip
    this.audio._mes = ctx.createMediaElementSource(this.audio); this.elFade = ctx.createGain(); this.audio._mes.connect(this.elFade); this.elFade.connect(this.out);
    // music videos (videos.js) play in a <video> element through the same fade → out → volume path, so the visualizer,
    // inserts and volume work on their sound too. `this.audio` is whichever element is in use; the page shows `videoEl`.
    this.audioEl = this.audio; this.videoEl = document.createElement('video'); Object.assign(this.videoEl, { crossOrigin: 'anonymous', preload: 'auto', playsInline: true, className: 'bvideo' });
    this.videoEl._mes = ctx.createMediaElementSource(this.videoEl); this.videoEl._mes.connect(this.elFade);
    this.video = null; this.videoMode = (() => { try { return localStorage.getItem('bootleg.videoMode') === '1'; } catch { return false; } })(); this._pick = null;
    try { this.deck.master.disconnect(); } catch { /* fresh */ } this.stemFade = ctx.createGain(); this.stemFade.gain.value = 0; this.deck.master.connect(this.stemFade); this.stemFade.connect(this.out);
    this.A = new BufDeck(ctx, 'A', this.out); this.B = new BufDeck(ctx, 'B', this.out); this.main = null;
    for (const d of [this.A, this.B]) d.onend = deck => this._deckEnded(deck);
    feed.fromNode(this.out);
    this.volume = Number(localStorage.getItem('bootleg.volume') ?? 0.9); this.setVolume(this.volume);
    for (const el of [this.audioEl, this.videoEl]) {
      for (const ev of ['play', 'pause', 'loadedmetadata', 'durationchange']) el.addEventListener(ev, () => { if (el === this.audio) this._emit(); });
      el.addEventListener('ended', () => { if (el !== this.audio || this.mode !== 'element') return; if (this.plan && this.plan.T - this.ctx.currentTime < 0.5) return; this._ended(); });   // a scheduled next track is about to start: let it
    }
    setInterval(() => { if (this.mode === 'deck' && !this.plan && this.deck.playing && this.deck.pos() >= this.deck.dur - 0.02) { this.deck.pause(); this.deck.offset = this.deck.dur; this._ended(); } }, 200);
    setInterval(() => this._tick(), 250); document.addEventListener('visibilitychange', () => this._tick());
    if ('mediaSession' in navigator) { const m = navigator.mediaSession; m.setActionHandler('play', () => this.play()); m.setActionHandler('pause', () => this.pause()); m.setActionHandler('previoustrack', () => this.prev()); m.setActionHandler('nexttrack', () => this.next()); m.setActionHandler('seekto', e => this.seek(e.seekTime)); }
    this._applyOut();
  }
  _emit() { this.dispatchEvent(new Event('change')); }
  get item() { if (this.dj) { const d = this.djMain(); return (d && d.item) || null; } return this.queue[this.index] || null; }
  get playing() { if (this.dj) return this.A.playing || this.B.playing; return this.mode === 'buf' ? !!this.main?.playing : this.mode === 'deck' ? this.deck.playing : !this.audio.paused; }
  pos() { if (this.dj) return this.djMain()?.pos() || 0; return this.mode === 'buf' ? this.main.pos() : this.mode === 'deck' ? this.deck.pos() : this.audio.currentTime || 0; }
  dur() { if (this.dj) return this.djMain()?.dur() || 0; return this.mode === 'buf' ? this.main.dur() : this.mode === 'deck' ? this.deck.dur : (isFinite(this.audio.duration) ? this.audio.duration : (this.item && this.item.duration) || 0); }

  // ---- queue
  _rebuild() { const idx = this.queue.map((_, i) => i); if (this.shuffle) { for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; } const k = idx.indexOf(this.index); if (k > 0) { idx.splice(k, 1); idx.unshift(this.index); } } this.order = idx; }
  async playList(items, start = 0) { if (this.dj) return this.djLoadIdle(items[start]); this.queue = items.slice(); this.index = Math.max(0, Math.min(start, items.length - 1)); this._rebuild(); await this._playCurrent(); }
  // Adds to the queue. Starts playing (and returns true) when there was nothing to continue: an empty queue, or one that ran out.
  enqueue(items, next = false) {
    if (!items.length) return false; const at = next ? this.index + 1 : this.queue.length; this.queue.splice(at, 0, ...items);
    if (!this.dj && (this.index < 0 || this.ended)) { this.index = this.index < 0 ? 0 : at; this._rebuild(); this._playCurrent(); return true; }
    if (this.index < 0) this.index = 0;
    this._invalidate(); this._rebuild(); this._emit(); return false;
  }
  // Plays these at once without throwing the queue away: they go in after the current track, the first of them starts.
  async playNow(items, start = 0) {
    if (!items.length) return; if (this.dj) return this.djLoadIdle(items[Math.max(0, Math.min(start, items.length - 1))]);
    if (this.index < 0 || !this.queue.length) return this.playList(items, start);
    const at = this.index + 1; this.queue.splice(at, 0, ...items); this.index = at + Math.max(0, Math.min(start, items.length - 1)); this._rebuild(); await this._playCurrent();
  }
  remove(i) {
    if (i === this.index && !this.dj) { this.queue.splice(i, 1); this.index = Math.min(i, this.queue.length - 1); this._rebuild(); if (this.index >= 0) this._playCurrent(); else this.stop(); return; }
    this.queue.splice(i, 1); if (i < this.index) this.index--; this._invalidate(); this._rebuild(); this._emit();
  }
  clear() { if (this.dj) { this.queue = []; this.index = -1; this.order = []; this._emit(); return; } this.stop(); this.queue = []; this.index = -1; this.order = []; this._emit(); }
  setShuffle(v) { this.shuffle = v; this._invalidate(); this._rebuild(); this._emit(); }
  setRepeat(v) { this.repeat = v; this._invalidate(); this._emit(); }
  async jump(i) { if (this.dj) return this.djLoadIdle(this.queue[i]); this.index = i; this._rebuild(); await this._playCurrent(); }
  // the queue position that plays after the current one (or null), following shuffle and repeat
  peekNext() {
    if (!this.queue.length || this.index < 0) return null; if (this.repeat === 'one') return this.index;
    let p = this.order.indexOf(this.index) + 1; if (p >= this.order.length) { if (this.repeat !== 'all') return null; p = 0; } return this.order[p] ?? null;
  }
  // Settings → Playing: { mode: 'off' | 'gapless' | 'crossfade', seconds, match }
  setTransition(t) { this.transition = { ...transitionOf('gapless'), ...t }; this._invalidate(); this._failed = null; this._applyOut(); this._emit(); }

  // ---- transport
  async _playCurrent() { const item = this.item; if (!item) return; this.ended = false; await this._load(item); if (this.item === item) this.play(); }
  // A stem set plays from its mix straight away (one file, instant start). Its stems are decoded only when wanted — the stem
  // mixer, a stem-aware visualizer, or the "always" setting — and then take over seamlessly at the current position.
  async _load(item) {
    this._invalidate(); this.deck.pause(); this.audioEl.pause(); this.videoEl.pause(); this.A.pause(); this.B.pause(); this.loading = null; this._stemsFor = null; this._failed = null;
    const vid = this.videoOf(item); this.video = vid; this._useEl(vid ? this.videoEl : this.audioEl);
    const ready = !vid && this.transition.mode !== 'off' && [this.A, this.B].find(d => d.item === item && d.buf);   // already decoded (the next track, or one played just now)
    if (vid) {
      this.mode = 'element'; this.deck.dispose(); this._solo(); this.stemsState = 'none'; this._elItem = item; await this._setSrc(vid.src);
    } else if (ready) {
      this.deck.dispose(); this.main = ready; this.mode = 'buf'; ready.offset = 0; ready.setRate(1); this._solo(); this.stemsState = item.kind === 'render' ? 'unloaded' : 'none';
    } else if (item.kind === 'render' && !item.mix) {                                 // no mix file: the stems are all there is
      this.mode = 'deck'; this._solo(); this.stemsState = 'loading'; this.audio.removeAttribute('src'); this.audio.load(); this._elItem = null; this.loading = { n: 0, total: item.stems.length }; this._emit();
      await this.hooks.loadClips?.(item); const ok = await this.deck.load(item, (n, total) => { this.loading = { n, total }; this._emit(); }); this.loading = null; if (!ok) return; this.stemsState = 'ready';
    } else {
      this.mode = 'element'; this.deck.dispose(); this._solo(); this.stemsState = item.kind === 'render' ? 'unloaded' : 'none'; this._elItem = item; await this._setSrc(item.kind === 'render' ? item.mix : item.src);
    }
    this._applyOut(); this._media(item); this._emit();
    if (item.kind === 'render' && this.stemPolicy === 'auto') this.ensureStems();
  }
  // ---- music videos: what plays for `item` — a video item itself, or (with video mode on) its linked video; else null
  videoOf(item) {
    if (!item || this.dj) return null; if (item.kind === 'video') return item;
    if (this._pick && this._pick.item === item) return this._pick.video;
    return this.videoMode ? this.hooks.videoFor?.(item) || null : null;
  }
  _useEl(el) { const old = this.audio; if (old === el) return; old.pause(); if (old === this.videoEl) { old.removeAttribute('src'); old.load(); } this.audio = el; }
  // Video mode: tracks with a linked music video play the video (with its own sound) instead. Applies to the track now
  // playing at once (from the start: a video's edit seldom lines up with the album version).
  async setVideoMode(on) {
    this.videoMode = !!on; this._pick = null; try { localStorage.setItem('bootleg.videoMode', on ? '1' : '0'); } catch { /* private mode */ }
    const item = this.item; if (item && item.kind !== 'video' && !!this.video !== !!this.videoOf(item)) { const was = this.playing; await this._load(item); if (was || on) this.play(); }
    this._emit();
  }
  /// Plays one particular video for the track now playing (or, with null, goes back to the track).
  async watch(video) { const item = this.item; if (!item) return; this._pick = video ? { item, video } : { item, video: null }; await this._load(item); this.play(); }
  async ensureStems() {
    const item = this.item; if (this.video || this.dj || !item || item.kind !== 'render' || this.stemsState !== 'unloaded' || (this.mode !== 'element' && this.mode !== 'buf')) return;
    const wait = this._fadingUntil - performance.now(); if (wait > 0) { clearTimeout(this._esT); this._esT = setTimeout(() => this.ensureStems(), wait + 50); return; }   // the last track is still fading out of the stem deck
    this.stemsState = 'loading'; this._stemsFor = item; this.loading = { n: 0, total: item.stems.length }; this._emit();
    try {
      await this.hooks.loadClips?.(item); const ok = await this.deck.load(item, (n, total) => { this.loading = { n, total }; this._emit(); });
      if (!ok || this.item !== item || this._stemsFor !== item || this.dj) { this.loading = null; if (this.stemsState === 'loading') this.stemsState = 'unloaded'; return; }
      const pos = this.pos(), was = this.playing; this._invalidate();
      if (this.mode === 'buf') this.main.pause(); else this.audio.pause();
      this.deck.offset = pos; this.mode = 'deck'; this._solo(); this.stemsState = 'ready'; this.loading = null; if (was) this.deck.play(pos);
    } catch (e) { this.loading = null; this.stemsState = 'unloaded'; this.stemsError = String(e && e.message || e); }
    this._emit();
  }
  // Give the memory back: go back to playing the mix (or the decoded track) from where the stems were.
  async unloadStems() {
    if (this.mode !== 'deck' || this.dj) return; const item = this.item, pos = this.deck.pos(), was = this.deck.playing;
    let D = [this.A, this.B].find(d => d.item === item && d.buf);
    if (!D && this._elItem !== item && decodable(item)) { D = this.A === this.main ? this.B : this.A; try { await D.load(item); } catch { D = null; } if (this.item !== item || this.mode !== 'deck') return; }
    if (D) { this._invalidate(); this.deck.dispose(); this.main = D; this.mode = 'buf'; D.offset = pos; D.setRate(1); this._solo(); if (was) D.play(undefined, pos); }
    else if (item.mix && this._elItem === item) { this._invalidate(); this.deck.dispose(); this.mode = 'element'; this.audio.currentTime = pos; this._solo(); if (was) this.audio.play().catch(() => {}); }
    else return;
    this.stemsState = 'unloaded'; this._emit();
  }
  // Only the source now playing is heard (the others are silent until a transition fades them).
  _solo() {
    const t = this.ctx.currentTime, set = (g, v) => { g.cancelScheduledValues(0); g.setValueAtTime(v, t); };
    set(this.elFade.gain, this.mode === 'element' ? 1 : 0); set(this.stemFade.gain, this.mode === 'deck' ? 1 : 0);
    for (const d of [this.A, this.B]) set(d.fade.gain, this.mode === 'buf' && d === this.main ? 1 : 0);
  }
  _fadeOf() { return this.mode === 'buf' ? this.main.fade.gain : this.mode === 'deck' ? this.stemFade.gain : this.elFade.gain; }
  // While casting, local playback keeps running (the visualizer and timeline need it) but is silent: the output is
  // disconnected from the speakers, the analysers stay connected.
  setLocalOutput(on) { this.localOut = on !== false; this._applyOut(); }
  _applyOut() {
    const bus = this._bus(); for (const n of [this.vol, this.lim]) { try { n.disconnect(); } catch { /* not connected */ } }
    if (this.localOut === false) return;
    if (this.dj || this.transition.mode === 'crossfade') { this.vol.connect(this.lim); this.lim.connect(bus); } else this.vol.connect(bus);
  }
  // What reaches the speakers goes through one bus, where extensions can insert processing (an equalizer, …). The analysers
  // (visualizer, meters) listen before it. insert(input, output = input) → a function that takes it out again.
  _bus() {
    const ctx = this.ctx; if (!this.bus) { this.bus = ctx.createGain(); this.inserts = []; this._wire(); } return this.bus;
  }
  _wire() {
    const ctx = this.ctx; let prev = this.bus; try { prev.disconnect(); } catch { /* fresh */ }
    for (const x of this.inserts) { try { x.out.disconnect(); } catch { /* fresh */ } prev.connect(x.in); prev = x.out; } prev.connect(ctx.destination);
  }
  insert(input, output = input) { this._bus(); const x = { in: input, out: output }; this.inserts.push(x); this._wire(); return () => { const i = this.inserts.indexOf(x); if (i < 0) return; this.inserts.splice(i, 1); try { x.out.disconnect(); } catch { /* gone */ } this._wire(); }; }
  // Some webviews cannot play a stream the element is pointed at (WebKitGTK/GStreamer and asset://, cross-origin servers without
  // CORS, ...). When the element errors — or goes silent for too long — fetch the file ourselves (the asset protocol / the desktop
  // HTTP plugin can) and play it from a blob: URL. This never blocks playback from starting: the element is tried first, at once.
  async _setSrc(src) {
    const a = this.audio, tok = ++this._tok, cur = this.item; if (this._blob) { URL.revokeObjectURL(this._blob); this._blob = null; }
    clearTimeout(this._dog);
    if (src.urlAsync) { try { const u = await src.urlAsync(); if (tok === this._tok) a.src = u; } catch (e) { this._fail(`Could not play “${cur?.title || src.name}”: ${e.message || e}`); } return; }      // a part of a .bstem/.bsong package
    a.src = src.url(); if (src.kind !== 'tauri' && src.kind !== 'remote') return;
    const fallback = async why => {
      if (tok !== this._tok || this._blob || this.item !== cur) return;
      try { const r = await (src.fetch ? src.fetch() : fetch(src.url())); if (!r.ok) throw new Error('HTTP ' + r.status); this._blob = URL.createObjectURL(new Blob([await r.arrayBuffer()], { type: mimeOf(r, src.name) })); if (tok === this._tok) { a.src = this._blob; if (this._wantPlay && this.mode === 'element') a.play().catch(() => {}); } }
      catch (e) { this._fail(`Could not play “${cur?.title || src.name}”: ${why}${e && e.message ? ' (' + e.message + ')' : ''}`); }
    };
    a.addEventListener('error', () => fallback(a.error ? `the player rejected it (code ${a.error.code})` : 'load error'), { once: true });
    this._dog = setTimeout(() => { if (tok === this._tok && this._wantPlay && this.mode === 'element' && a.readyState < 2 && !this._blob) fallback('it did not start loading'); }, 7000);     // silent stall (no error event)
  }
  _fail(msg) { this.lastError = msg; this.dispatchEvent(new CustomEvent('playerror', { detail: msg })); }
  play() {
    this._wantPlay = true; this.ctx.resume();
    if (this.dj) { const d = this.djMain(); if (d && d.buf) d.play(); }
    else if (this.mode === 'buf') { if (!this.main?.buf) { this._emit(); return this.item ? this._playCurrent() : undefined; } this.main.play(); } else if (this.mode === 'deck') this.deck.play();
    else this.audio.play().catch(e => { if (e && e.name !== 'AbortError' && !this._blob && e.name !== 'NotSupportedError') this._fail(`Playback was blocked: ${e.message || e.name}`); });
    this._emit();
  }
  pause() {
    this._wantPlay = false; this._invalidate(); this.auto = null;
    if (this.dj) { this.A.pause(); this.B.pause(); this._emit(); return; }
    if (this.mode === 'buf') this.main.pause(); else if (this.mode === 'deck') this.deck.pause(); else this.audio.pause();
    this._retire(); this._emit();
  }
  toggle() { this.playing ? this.pause() : this.play(); }
  stop() { this._invalidate(); this.auto = null; this.deck.pause(); this.audioEl.pause(); this.videoEl.pause(); this.A.pause(); this.B.pause(); this._emit(); }
  seek(t) {
    t = Math.max(0, t); this._invalidate();
    if (this.dj) this.djMain()?.seek(t); else if (this.mode === 'buf') this.main.seek(t); else if (this.mode === 'deck') this.deck.seek(t); else this.audio.currentTime = t;
    this.dispatchEvent(new CustomEvent('seek', { detail: t })); this._emit();
  }
  setVolume(v) { this.dispatchEvent(new CustomEvent('volume', { detail: v })); this.volume = v; this.vol.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01); try { localStorage.setItem('bootleg.volume', String(v)); } catch { /* private mode */ } this._emit(); }
  next() { if (this.dj) return this.djLoadNext(); this._step(1, false); }
  prev() { if (this.dj) return this.djMain()?.seek(0); if (this.pos() > 3) this.seek(0); else this._step(-1, false); }
  _step(dir, natural) {
    if (!this.queue.length) return; let p = this.order.indexOf(this.index) + dir;
    if (p >= this.order.length) { if (this.repeat === 'all' || !natural) p = 0; else { this.ended = true; this.stop(); return; } } if (p < 0) p = this.order.length - 1;
    this.index = this.order[p]; this._playCurrent();
  }
  _ended() { if (this.repeat === 'one') { this.seek(0); this.play(); } else this._step(1, true); }
  _deckEnded(d) { this._commit(); if (this.dj) { this._emit(); return; } if (d === this.main && this.mode === 'buf' && !this.plan) this._ended(); }
  _media(item) { if (!('mediaSession' in navigator)) return; navigator.mediaSession.metadata = new MediaMetadata({ title: item.title || '', artist: item.artist || '', album: item.album || '', artwork: item.coverUrl ? [{ src: item.coverUrl }] : [] }); }

  // ---- transitions: scheduled on the audio clock well ahead (a background window's timers are slow), committed lazily by _tick
  _tick() {
    this._commit();
    if (this.dj) { const a = this.auto; if (a && this.ctx.currentTime >= a.t0 + a.len) { this.auto = null; a.from.pause(); this.setX(a.to === this.B ? 1 : 0, true); } return; }
    if (this.transition.mode === 'off' || !this._wantPlay || !this.playing || this.plan || this.localOut === false || !this.item || this.video) return;   // no gapless/crossfade out of a video
    if (this.mode === 'element' && this.audio.currentTime > PROMOTE_AFTER) this._promote();
    const o = this._cur(); if (!o) return;
    const ni = this.peekNext(); if (ni == null) return; const next = this.queue[ni]; if (next === this._failed || !decodable(next) || this.videoOf(next)) return;   // …or into one
    if ((o.dur - o.pos) / o.rate < this.transition.seconds + PREPARE) this._schedule(ni);
  }
  // the source now playing, as the transition sees it
  _cur() {
    const bpm = +(this.item && this.item.bpm) || 0;
    // at(s): the audio-clock time its position s plays — exact for the decks (from when their sources started), estimated for the element
    if (this.mode === 'buf') { const d = this.main; return d.buf && d.playing ? { kind: 'buf', fade: d.fade.gain, dur: d.dur(), pos: d.pos(), rate: d.rate, bpm, at: s => d.t0 + (s - d.offset) / d.rate } : null; }
    if (this.mode === 'deck') { const k = this.deck; return k.dur && k.playing ? { kind: 'deck', fade: this.stemFade.gain, dur: k.dur, pos: k.pos(), rate: 1, bpm, at: s => k.t0 + s - k.offset } : null; }
    const a = this.audio, now = this.ctx.currentTime, r = a.playbackRate || 1, p = a.currentTime;
    return isFinite(a.duration) && a.duration > 0 ? { kind: 'element', fade: this.elFade.gain, dur: a.duration, pos: p, rate: r, bpm, at: s => now + (s - p) / r } : null;
  }
  // Move the current track from the streaming element onto a deck, in place (a 30 ms overlap of the same audio).
  async _promote() {
    const item = this.item; if (this.mode !== 'element' || this._promoting || !item || item === this._failed || this.dj) return;
    if (!decodable(item, isFinite(this.audio.duration) ? this.audio.duration : 0)) return;
    const ni = this.peekNext(), nextItem = ni != null ? this.queue[ni] : null;
    const D = [this.A, this.B].find(d => d.item === item) || [this.A, this.B].find(d => !nextItem || d.item !== nextItem) || this.A;
    this._promoting = item;
    try { await D.load(item); } catch { this._failed = item; return; } finally { this._promoting = null; }
    if (this.item !== item || this.mode !== 'element' || this.dj || !D.buf) return;
    this._toDeck(D);
  }
  _toDeck(D) {
    const a = this.audio, c = this.ctx, was = !a.paused; this._invalidate(); this.main = D; this.mode = 'buf'; D.setRate(1); D.setFade(0);
    if (was) {
      const lead = 0.12, T = c.currentTime + lead; D.play(T, a.currentTime + lead * (a.playbackRate || 1));
      fadeGain(D.fade.gain, T, 0.03, 'in'); fadeGain(this.elFade.gain, T, 0.03, 'out'); setTimeout(() => { if (this.mode !== 'element') a.pause(); }, 400);
    } else { D.offset = a.currentTime; this._solo(); }
    this._emit();
  }
  async _schedule(ni) {
    if (this._sched) return; this._sched = true; const tok = this._ptok, cur = this.item, next = this.queue[ni];
    try {
      const O = this.mode === 'buf' ? this.main : null;
      const I = O ? (O === this.A ? this.B : this.A) : ([this.A, this.B].find(d => d.item === next) || [this.A, this.B].find(d => d.item !== cur) || this.B);
      const share = [this.A, this.B].find(d => d !== I && d.item === next && d.buf);
      if (share) { I.unload(); I.item = next; I.buf = share.buf; } else await I.load(next);
      if (tok !== this._ptok || this.plan || !this.playing || this.item !== cur || this.peekNext() !== ni || this.dj || I === this.main) return;
      const o = this._cur(); if (!o) return;
      const c = this.ctx, now = c.currentTime, xf = this.transition.mode === 'crossfade' ? this.transition.seconds : 0;
      const match = xf > 0 && this.transition.match && o.bpm > 0 && I.bpm() > 0;
      I.setRate(match ? matchRate(o.bpm * o.rate, I.bpm()) : 1);
      const start = transitionStart({ dur: o.dur, pos: o.pos, rate: o.rate, xf, bpm: o.bpm, onBar: match });
      const T = o.at(start), len = Math.max(0, (o.dur - start) / o.rate);
      if (T < now + 0.08) return;                                                   // too late to do cleanly: it ends and the next one loads
      I.setFade(0);
      if (len > 0.05) { fadeGain(I.fade.gain, T, len, 'in'); fadeGain(o.fade, T, len, 'out'); }
      else { I.fade.gain.setValueAtTime(1, T); o.fade.setValueAtTime(0, T + 0.003); }
      I.play(T, 0); this.plan = { I, T, len, idx: ni };
    } catch (e) { this._failed = next; console.warn('bootleg: no gapless / crossfade into', next?.title, e); } finally { this._sched = false; }
  }
  // the next track has started: it is the current one now
  _commit() {
    const p = this.plan; if (!p || this.ctx.currentTime < p.T) return; this.plan = null;
    const was = this.mode, done = p.len * 1000 + 300; this._fadingUntil = performance.now() + done;
    this.index = p.idx; this.main = p.I; this.mode = 'buf'; this.ended = false; this._stemsFor = null; this.loading = null;
    const item = this.item; this.stemsState = item.kind === 'render' ? 'unloaded' : 'none';
    if (was === 'element') setTimeout(() => { if (this.mode !== 'element') this.audio.pause(); }, done);
    else if (was === 'deck') setTimeout(() => { if (this.mode !== 'deck') { this.deck.dispose(); this._emit(); } }, done);
    if (Math.abs(p.I.rate - 1) > 0.002) this._glide(p.I, p.len);
    this._media(item); this._emit();
    if (item.kind === 'render' && this.stemPolicy === 'auto') this.ensureStems();
  }
  // cancel a transition that has not started (the user did something); the playing source goes back to full level
  _invalidate() {
    this._commit(); this._ptok++; const p = this.plan; if (!p) return; this.plan = null;
    p.I.stopSrc(); p.I.playing = false; p.I.offset = 0; p.I.setFade(0); p.I.setRate(1);
    const g = this._fadeOf(), t = this.ctx.currentTime; g.cancelScheduledValues(0); g.setValueAtTime(1, t);
  }
  // pausing during a crossfade: what was fading out stops too
  _retire() {
    if (this._fadingUntil <= performance.now()) return; this._fadingUntil = 0;
    for (const d of [this.A, this.B]) if (d !== this.main || this.mode !== 'buf') d.pause();
    if (this.mode !== 'element') this.audio.pause(); if (this.mode !== 'deck') this.deck.pause();
  }
  _glide(deck, after) {                    // after a tempo-matched crossfade the new track eases back to its own tempo
    clearInterval(this._gt); clearTimeout(this._gw);
    this._gw = setTimeout(() => {
      const r0 = deck.rate, t0 = performance.now();
      this._gt = setInterval(() => { const k = Math.min(1, (performance.now() - t0) / 14000); if (deck !== this.main || !deck.playing || this.dj) return clearInterval(this._gt); deck.setRate(r0 + (1 - r0) * k); if (k >= 1) clearInterval(this._gt); }, 250);
    }, after * 1000 + 500);
  }

  // ---- DJ mode
  djMain() { const pick = this.x < 0.5 ? this.A : this.B, other = pick === this.A ? this.B : this.A; return pick.item || pick.loading ? pick : other.item ? other : pick; }
  djIdle() { const m = this.djMain(); return m === this.A ? this.B : this.A; }
  async setDJ(on) {
    if (!!on === this.dj) return; this._invalidate(); clearInterval(this._gt); clearTimeout(this._gw);
    if (on) {
      const item = this.item;
      if (item && this.mode !== 'buf') {                                            // bring what is playing onto a deck, in place
        const pos = this.pos(), was = this.playing, D = [this.A, this.B].find(d => d.item === item) || this.A;
        if (!decodable(item, this.dur())) { this._fail(`“${item.title}” is too long for a DJ deck (over 20 minutes); it keeps playing as it is`); return; }
        try { await D.load(item); } catch (e) { this._fail(`Could not load “${item.title}” onto a deck: ${e.message || e}`); return; }
        if (this.item !== item || this.dj) return;
        if (this.mode === 'element') this._toDeck(D);
        else { this.deck.pause(); this.main = D; this.mode = 'buf'; D.offset = pos; this._solo(); if (was) D.play(undefined, pos); this.deck.dispose(); this.stemsState = 'unloaded'; }
      }
      if (this.mode !== 'buf') { this.audio.pause(); this.deck.pause(); this.main = this.A; this.mode = 'buf'; }
      for (const d of [this.A, this.B]) if (d !== this.main) d.pause();
      this.dj = true; this.x = this.main === this.B ? 1 : 0; this.setX(this.x, true);
    } else {
      this.auto = null; this.dj = false; const keep = this.x < 0.5 ? (this.A.item ? this.A : this.B) : (this.B.item ? this.B : this.A), other = keep === this.A ? this.B : this.A;
      other.pause(); this.main = keep; this.mode = 'buf'; this._solo(); for (const d of [this.A, this.B]) d.flat();
      if (keep.item) { let i = this.queue.indexOf(keep.item); if (i < 0) { i = this.index + 1; this.queue.splice(i, 0, keep.item); } this.index = i; this._rebuild(); if (Math.abs(keep.rate - 1) > 0.002) this._glide(keep, 0); this._media(keep.item); }
    }
    this._applyOut(); this._emit();
  }
  setX(x, now) {                                       // crossfader, equal power: 0 = deck A, 1 = deck B
    const was = this.djMain(); this.x = Math.max(0, Math.min(1, x)); const n = this.ctx.currentTime, a = Math.cos(this.x * Math.PI / 2), b = Math.sin(this.x * Math.PI / 2);
    for (const [d, v] of [[this.A, a], [this.B, b]]) { d.fade.gain.cancelScheduledValues(0); if (now) d.fade.gain.setValueAtTime(v, n); else d.fade.gain.setTargetAtTime(v, n, 0.01); }
    if (this.djMain() !== was) { const it = this.item; if (it) this._media(it); this._emit(); }
  }
  async djLoad(deck, item) {
    if (!item) return; if (!decodable(item)) { this._fail(`“${item.title}” is too long for a DJ deck`); return; }
    this._emit(); try { await deck.load(item); deck.flat(); } catch (e) { this._fail(`Could not load “${item.title}”: ${e.message || e}`); } this._emit();
  }
  djLoadIdle(item) { const idle = this.A.playing && !this.B.playing ? this.B : !this.A.playing && this.B.playing ? this.A : this.djIdle(); return this.djLoad(idle, item); }
  djLoadNext() { const cur = this.djMain().item, i = cur ? this.queue.indexOf(cur) : this.index, n = this.queue.length ? this.queue[(i + 1) % this.queue.length] : null; if (n) return this.djLoad(this.djIdle(), n); }
  djToggle(deck) { this.ctx.resume(); if (deck.playing) deck.pause(); else if (deck.buf) deck.play(); this._emit(); }
  sync(deck) {                                         // tempo and beat/bar phase to the other deck
    const o = deck === this.A ? this.B : this.A; if (!deck.buf || !o.buf || !deck.bpm() || !o.bpm()) return false;
    deck.setRate(matchRate(o.eff(), deck.bpm())); if (deck.playing && o.playing) this._phase(deck, o); return true;
  }
  _phase(deck, o) {                                    // shift `deck` so its bars (or beats, in half/double time) land on `o`'s
    const lead = 0.03, bar = Math.abs(deck.eff() / o.eff() - 1) < 0.02, unit = bar ? 4 : 1;
    const pa = (((o.pos() + lead * o.rate) * o.bpm() / (60 * unit)) % 1 + 1) % 1, pb = (((deck.pos() + lead * deck.rate) * deck.bpm() / (60 * unit)) % 1 + 1) % 1;
    let diff = pa - pb; if (diff > 0.5) diff -= 1; if (diff < -0.5) diff += 1;
    deck.seek(deck.pos() + lead * deck.rate + diff * unit * 60 / deck.bpm());
  }
  // bring in the other deck on the next bar line of the playing one and crossfade over `len` seconds
  async autoMix(len = this.transition.seconds || 6, match = this.transition.match) {
    const from = this.A.playing && (!this.B.playing || this.x < 0.5) ? this.A : this.B.playing ? this.B : null, to = from ? (from === this.A ? this.B : this.A) : null;
    if (!from || this.auto) return;
    if (!to.buf) { const cur = from.item, i = this.queue.indexOf(cur), n = this.queue[(i + 1) % Math.max(1, this.queue.length)]; if (!n || n === cur) return; await this.djLoad(to, n); if (!to.buf || !from.playing) return; }
    const now = this.ctx.currentTime;
    if (match && from.bpm() && to.bpm()) to.setRate(matchRate(from.eff(), to.bpm()));
    let T = now + 0.3; if (from.bpm()) { const bar = 240 / from.bpm(), pf = from.pos(), nb = (Math.floor(pf / bar) + 1) * bar; T = now + Math.max(0.3, (nb - pf) / from.rate); }
    const tb = to.bpm() ? 240 / to.bpm() : 0, off = tb ? Math.round(to.offset / tb) * tb : to.offset; len = Math.max(2, len);
    fadeGain(from.fade.gain, T, len, 'out', from.fade.gain.value); fadeGain(to.fade.gain, T, len, 'in');
    to.play(T, off); this.auto = { from, to, t0: T, len }; this._emit();
  }
}
