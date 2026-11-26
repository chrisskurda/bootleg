// Plays a stem set: every stem decoded, started together on one clock through its own fader (the audition page's engine).
// Each stem is also tapped before its fader and handed to the visualizer (feed.addStem), so per-stem visuals follow the music even when a stem is muted.
// run fn over items with at most `limit` in flight (decoded stems are large; this bounds the peak memory)
async function pool(items, limit, fn) { const out = new Array(items.length); let i = 0; await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } })); return out; }

export class StemDeck {
  constructor(feed) {
    this.feed = feed; feed._init(); this.ctx = feed.ctx; this.master = this.ctx.createGain(); this.master.connect(this.ctx.destination);
    this.stems = []; this.dur = 0; this.offset = 0; this.t0 = 0; this.playing = false; this.clips = {}; this._id = 0; this.volume = 1;
  }
  async load(render, onProgress) {
    const id = ++this._id; this.dispose(); const gains = (render.manifest && render.manifest.stems_gain_db) || {}; let n = 0;
    const decoded = await pool(render.stems, 3, async s => { if (id !== this._id) return null; const res = await (s.src.fetch ? s.src.fetch() : fetch(s.src.url())); if (!res.ok) throw new Error(`${s.name}: HTTP ${res.status}`); const ab = await res.arrayBuffer(); const buf = await this.ctx.decodeAudioData(ab); onProgress?.(++n, render.stems.length); return { name: s.name, buf }; });
    if (id !== this._id) return false;                                         // the user picked something else while this loaded
    this.stems = decoded.map(({ name, buf }) => {
      const baseDb = gains[name] ?? 0, tap = this.ctx.createGain(), fader = this.ctx.createGain(), role = window.VisStems.roleOf(name);
      tap.connect(fader); fader.connect(this.master); this.feed.addStem(name, tap, { role, gainDb: baseDb });
      return { name, role, buf, tap, fader, baseDb, trimDb: 0, mute: false, solo: false, src: null };
    });
    this.dur = Math.max(...this.stems.map(s => s.buf.duration)); this.offset = 0;
    this.clips = window.VisStems.clipsFromDoc(render.clips, render.manifest && render.manifest.bpm); this.applyGains(true); return true;
  }
  applyGains(now) {
    const any = this.stems.some(s => s.solo), t = this.ctx.currentTime;
    for (const s of this.stems) {
      const audible = !s.mute && (!any || s.solo), db = s.baseDb + s.trimDb, v = audible ? 10 ** (db / 20) : 0;
      if (now) s.fader.gain.value = v; else s.fader.gain.setTargetAtTime(v, t, 0.015);
      this.feed.stemState[s.name] = { muted: s.mute, solo: s.solo, gainDb: db };
    }
  }
  get memoryMB() { return Math.round(this.stems.reduce((n, s) => n + s.buf.length * s.buf.numberOfChannels * 4, 0) / 1048576); }
  pos() { return this.playing ? Math.min(this.dur, this.offset + Math.max(0, this.ctx.currentTime - this.t0)) : this.offset; }
  play(from) {
    this.ctx.resume(); this._stopSources(); this.offset = from ?? this.offset; if (this.offset >= this.dur - 0.05) this.offset = 0;
    const at = this.ctx.currentTime + 0.06;
    for (const s of this.stems) { const src = this.ctx.createBufferSource(); src.buffer = s.buf; src.connect(s.tap); src.start(at, this.offset); s.src = src; }
    this.t0 = at; this.playing = true;
  }
  pause() { if (!this.playing) return; this.offset = this.pos(); this._stopSources(); this.playing = false; }
  seek(t) { t = Math.max(0, Math.min(this.dur, t)); if (this.playing) this.play(t); else this.offset = t; }
  setVolume(v) { this.volume = v; this.master.gain.value = v; }
  _stopSources() { for (const s of this.stems) if (s.src) { try { s.src.stop(); } catch { /* already stopped */ } s.src.disconnect(); s.src = null; } }
  dispose() { this.pause(); this._stopSources(); for (const s of this.stems) { try { s.tap.disconnect(); s.fader.disconnect(); } catch { /* ignore */ } } this.stems = []; this.dur = 0; this.offset = 0; this.feed.clearStems(); }
}
