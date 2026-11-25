// Link to the bootleg-bridge-thing desktop extension (a Car Thing remote). We connect out to its localhost WebSocket,
// publish player state (and spectrum frames while the device is watching) and execute the commands it relays back.
export const BRIDGE_URL = 'ws://127.0.0.1:8899/bootleg';

const clamp01 = v => Math.max(0, Math.min(1, v));

export class Bridge {
  constructor({ player, viz, url = BRIDGE_URL }) {
    Object.assign(this, { player, viz, url }); this.ws = null; this.frames = false; this.lastFrame = 0; this.coverFor = null; this.timer = null; this.sig = '';
    player.addEventListener('change', () => this.sendState());
    player.addEventListener('seek', () => this.sendState(true));
    setInterval(() => { if (this.open && player.playing) this.sendState(true); }, 1000);   // keep the device's playhead honest
  }
  get open() { return this.ws && this.ws.readyState === 1; }
  start() { if (this.ws || this.timer) return; this._connect(); }
  stop() { clearTimeout(this.timer); this.timer = null; this.frames = false; this.viz.tap = null; try { this.ws?.close(); } catch { /* closed */ } this.ws = null; }
  _connect() {
    this.timer = null; let ws; try { ws = new WebSocket(this.url); } catch { this._retry(); return; }
    this.ws = ws;
    ws.onopen = () => { this.sig = ''; this.coverFor = null; this.sendState(true); };
    ws.onmessage = e => { try { this._cmd(JSON.parse(e.data)); } catch { /* malformed */ } };
    ws.onclose = () => { if (this.ws === ws) { this.ws = null; this.frames = false; this.viz.tap = null; this._retry(); } };
    ws.onerror = () => { /* onclose follows */ };
  }
  _retry() { if (!this.timer) this.timer = setTimeout(() => this._connect(), 3000); }
  _send(o) { if (this.open) this.ws.send(JSON.stringify(o)); }

  snapshot() {
    const p = this.player, it = p.item, st = p.mode === 'deck' ? p.deck.stems : [];
    return {
      type: 'state', playing: p.playing, pos: p.pos(), dur: p.dur(), volume: p.volume, shuffle: p.shuffle, repeat: p.repeat, index: p.index, count: p.queue.length,
      track: it ? { id: it.id, title: it.title || '', artist: it.artist || '', album: it.album || '', kind: it.kind, bpm: it.bpm || null, key: it.key || '' } : null,
      stems: st.map(s => ({ name: s.name, role: s.role || '', mute: !!s.mute, solo: !!s.solo })), stemsState: p.stemsState, pack: this.viz.pack?.name || '',
    };
  }
  sendState(force) {
    if (!this.open) return; const s = this.snapshot(), { pos, ...rest } = s, sig = JSON.stringify(rest);
    if (!force && sig === this.sig) return; this.sig = sig; this._send(s); if (s.track?.id !== this.coverFor) { this.coverFor = s.track?.id ?? null; this._sendCover(); }
  }
  // cover art arrives as a small jpeg data url so the device needs no access to our files
  async _sendCover() {
    const it = this.player.item, id = it?.id; if (!it?.coverUrl) { this._send({ type: 'cover', id: id ?? null, data: null }); return; }
    try {
      const img = new Image(); img.crossOrigin = 'anonymous'; img.src = it.coverUrl; await img.decode();
      const n = 248, c = document.createElement('canvas'); c.width = c.height = n; const g = c.getContext('2d'), s = Math.min(img.naturalWidth, img.naturalHeight);
      g.drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, n, n);
      if (this.player.item?.id === id) this._send({ type: 'cover', id, data: c.toDataURL('image/jpeg', 0.8) });
    } catch { this._send({ type: 'cover', id: id ?? null, data: null }); }
  }

  _cmd(m) {
    const p = this.player;
    switch (m.cmd) {
      case 'toggle': p.toggle(); break; case 'play': p.play(); break; case 'pause': p.pause(); break;
      case 'next': p.next(); break; case 'prev': p.prev(); break;
      case 'seek': if (Number.isFinite(m.to)) p.seek(clamp01(m.to) * (p.dur() || 0)); break;
      case 'seekBy': if (Number.isFinite(m.by)) p.seek(Math.max(0, Math.min(p.dur() || 0, p.pos() + m.by))); break;
      case 'volume': if (Number.isFinite(m.to)) p.setVolume(clamp01(m.to)); break;
      case 'shuffle': p.setShuffle(!p.shuffle); break;
      case 'repeat': p.setRepeat(p.repeat === 'off' ? 'all' : p.repeat === 'all' ? 'one' : 'off'); break;
      case 'stems': p.ensureStems?.(); break;
      case 'stemMute': case 'stemSolo': {
        if (p.mode !== 'deck') break; const s = p.deck.stems.find(x => x.name === m.name); if (!s) break;
        if (m.cmd === 'stemMute') s.mute = !s.mute; else s.solo = !s.solo; p.deck.applyGains(); p._emit(); break;
      }
      case 'frames': this._frames(!!m.on); break;
      case 'pack': this._pack(m.by | 0); break;
    }
  }
  _pack(by) { const v = this.viz, n = v.packs.length; if (!n || !by) return; const i = Math.max(0, v.packs.indexOf(v.pack)); v.setPack(v.packs[(i + by + n) % n].id); this.sendState(true); }
  _frames(on) {
    this.frames = on; this.viz.tap = on ? A => this._frame(A) : null; if (on) this.viz._kick();
  }
  _frame(A) {
    const now = performance.now(); if (now - this.lastFrame < 45 || !A.spectrum) return; this.lastFrame = now;
    const spec = Array.from(A.spectrum, v => Math.round(clamp01(v) * 255)), stems = (A.stems || []).map(s => Math.round(clamp01(s.level || 0) * 255));
    this._send({ type: 'frame', spec, level: Math.round(clamp01(A.level || 0) * 255), beat: A.beat ? 1 : 0, stems });
  }
}
