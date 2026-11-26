// The player's side of the mini player window (mini.html): publishes what is playing and carries out the window's
// commands. Same origin, so a BroadcastChannel is enough; the window says hello every 2 s, which is how we know it is open.
export const MINI_CHANNEL = 'bootleg-mini';
const clamp01 = v => Math.max(0, Math.min(1, v));

export class MiniHost {
  constructor({ player, onShowMain = () => {} }) {
    Object.assign(this, { player, onShowMain }); this.bc = new BroadcastChannel(MINI_CHANNEL); this.lastHello = -Infinity; this.sig = ''; this.coverFor = undefined;
    this.bc.onmessage = e => { const m = e.data || {}; if (m.hello) { const was = this.alive; this.lastHello = performance.now(); if (!was) this.coverFor = undefined; this.send(true); } else if (m.cmd) this.cmd(m); };
    player.addEventListener('change', () => this.send()); player.addEventListener('seek', () => this.send(true)); player.addEventListener('volume', () => setTimeout(() => this.send(), 0));
    setInterval(() => { if (this.alive && player.playing) this.send(true); }, 1000);
  }
  get alive() { return performance.now() - this.lastHello < 5000; }
  snapshot() {
    const p = this.player, it = p.item;
    return { type: 'state', playing: p.playing, pos: p.pos(), dur: p.dur(), volume: p.volume, shuffle: p.shuffle, repeat: p.repeat, index: p.index, count: p.queue.length, stems: it?.kind === 'render' ? it.stems.length : 0,
      track: it ? { id: it.id, title: it.title || '', artist: it.artist || '', album: it.album || '', bpm: it.bpm || null, key: it.key || '' } : null };
  }
  send(force) {
    if (!this.alive) return; const s = this.snapshot(), { pos, ...rest } = s, sig = JSON.stringify(rest); if (!force && sig === this.sig) return; this.sig = sig; this.bc.postMessage(s);
    if (s.track?.id !== this.coverFor) { this.coverFor = s.track?.id; this._cover(); }
  }
  // a small jpeg data URL: works in any window, whatever kind of URL the cover has here
  async _cover() {
    const it = this.player.item, id = it?.id ?? null; if (!it?.coverUrl) { this.bc.postMessage({ type: 'cover', id, data: null }); return; }
    try {
      const img = new Image(); img.crossOrigin = 'anonymous'; img.src = it.coverUrl; await img.decode();
      const n = 248, c = document.createElement('canvas'), s = Math.min(img.naturalWidth, img.naturalHeight); c.width = c.height = n;
      c.getContext('2d').drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, n, n);
      if (this.player.item?.id === id) this.bc.postMessage({ type: 'cover', id, data: c.toDataURL('image/jpeg', 0.8) });
    } catch { this.bc.postMessage({ type: 'cover', id, data: null }); }
  }
  cmd(m) {
    const p = this.player;
    switch (m.cmd) {
      case 'toggle': p.item ? p.toggle() : null; break; case 'next': p.next(); break; case 'prev': p.prev(); break;
      case 'seek': if (Number.isFinite(m.to)) p.seek(clamp01(m.to) * (p.dur() || 0)); break;
      case 'seekBy': if (Number.isFinite(m.by)) p.seek(Math.max(0, Math.min(p.dur() || 0, p.pos() + m.by))); break;
      case 'volume': if (Number.isFinite(m.to)) p.setVolume(clamp01(m.to)); break;
      case 'shuffle': p.setShuffle(!p.shuffle); break;
      case 'repeat': p.setRepeat(p.repeat === 'off' ? 'all' : p.repeat === 'all' ? 'one' : 'off'); break;
      case 'showMain': this.onShowMain(); break;
    }
  }
}
