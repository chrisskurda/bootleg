// One visualizer stage, shown in several places: the tile on Now playing, the big stage on the Visualizer page, and the
// floating mini player while you browse elsewhere. Moving an <iframe> in the page reloads it (the pack restarts), so the stage
// never moves: it is fixed-positioned over whichever placeholder ("slot") is showing, and clipped to the scrolling area.
export class VizDock {
  // stage: the element holding the frame · area: the scrolling region slots live in (clips the docked stage)
  constructor({ stage, area, onChange = () => {} }) { Object.assign(this, { stage, area, onChange }); this.slot = null; this.float = false; this._k = ''; this.visible = false; }
  // slot: the placeholder to cover, or null · float: show as the corner mini player when there is no slot
  place(slot, float) { this.slot = slot; this.float = !!float; this.update(); }
  update() {
    const s = this.stage, fs = document.fullscreenElement === s || document.webkitFullscreenElement === s;
    let k, vis = true;
    if (fs) k = 'fs';
    else if (this.slot && this.slot.isConnected && this.slot.offsetParent) {
      const r = this.slot.getBoundingClientRect(), a = this.area.getBoundingClientRect();
      const t = Math.max(0, a.top - r.top), b = Math.max(0, r.bottom - a.bottom), l = Math.max(0, a.left - r.left), rr = Math.max(0, r.right - a.right);
      vis = t < r.height && b < r.height && r.width > 0;
      k = `d${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)},${Math.round(t)},${Math.round(b)},${Math.round(l)},${Math.round(rr)}`;
      if (k !== this._k) { Object.assign(s.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px', clipPath: t || b || l || rr ? `inset(${t}px ${rr}px ${b}px ${l}px round 12px)` : '' }); }
      s.dataset.mode = 'docked';
    } else if (this.float) { k = 'float'; if (k !== this._k) Object.assign(s.style, { left: '', top: '', width: '', height: '', clipPath: '' }); s.dataset.mode = 'float'; }
    else { k = 'off'; vis = false; }
    s.hidden = !vis; if (k !== this._k || vis !== this.visible) { this._k = k; if (vis !== this.visible) { this.visible = vis; this.onChange(vis); } }
  }
}
