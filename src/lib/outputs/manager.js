// Mirrors the player to a cast target. Local playback keeps running silently (so the visualizer, timeline and notes keep
// working); play/pause/seek/volume/track changes are forwarded to the device.
import { getOutput, listOutputs } from './plugin.js';

export class Outputs extends EventTarget {
  constructor(player, { resolveUrl }) {
    super(); this.player = player; this.resolveUrl = resolveUrl; this.devices = []; this.active = null; this.scanning = false; this.error = ''; this._itemId = null; this._playing = false;
    player.addEventListener('change', () => this._onChange()); player.addEventListener('seek', e => this._call('seek', e.detail)); player.addEventListener('volume', e => this._call('volume', e.detail));
  }
  _emit() { this.dispatchEvent(new Event('change')); }
  async scan(extra = []) {
    this.scanning = true; this.error = ''; this._emit();
    try {
      const found = (await Promise.all(listOutputs().map(p => p.discover({ timeoutMs: 3000 }).catch(() => [])))).flat();
      for (const x of extra) { try { found.push(await getOutput(x.plugin).add(x.input)); } catch { /* unreachable now */ } }
      const byId = new Map(found.map(d => [d.plugin + ':' + d.id, d])); this.devices = [...byId.values()];
    } finally { this.scanning = false; this._emit(); }
  }
  async addByAddress(pluginId, input) { const d = await getOutput(pluginId).add(input); this.devices = [...this.devices.filter(x => !(x.id === d.id && x.plugin === d.plugin)), d]; this._emit(); return d; }
  async _call(fn, ...args) { if (!this.active) return; try { await getOutput(this.active.plugin)[fn](this.active, ...args); } catch (e) { this._fail(e); } }
  _fail(e) { this.error = String(e?.message || e); this._emit(); }

  async select(device) {
    if (this.active) { const old = this.active; this.active = null; try { await getOutput(old.plugin).stop(old); } catch { /* already gone */ } }
    this.error = ''; this.player.setLocalOutput(!device); this.active = device || null; this._itemId = null; this._playing = false; this._emit();
    if (device) { this.player.setLocalOutput(false); await this._cast(); }
  }
  async _cast() {
    const p = this.player, item = p.item; if (!this.active || !item) return; this._itemId = item.id; this._playing = p.playing;
    try {
      const m = await this.resolveUrl(item); if (!m) throw new Error('This item cannot be sent to a device (open it from the desktop app, or from a server)');
      const dev = this.active, plug = getOutput(dev.plugin);
      await plug.play(dev, { ...m, title: item.title, artist: item.artist, album: item.album, duration: p.dur() }); await plug.volume(dev, p.volume).catch(() => {});
      const pos = p.pos(); if (pos > 2) setTimeout(() => plug.seek(dev, pos).catch(() => {}), 1200);       // joined mid-track
      if (!p.playing) await plug.pause(dev).catch(() => {}); this.error = ''; this._emit();
    } catch (e) { this._fail(e); }
  }
  _onChange() {
    if (!this.active) return; const p = this.player;
    if (p.item && p.item.id !== this._itemId) { this._cast(); return; }
    if (p.playing !== this._playing) { this._playing = p.playing; this._call(p.playing ? 'resume' : 'pause'); }
  }
}
