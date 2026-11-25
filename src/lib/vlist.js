// A windowed ("virtual") list: only the rows near the viewport exist in the DOM, so a 100,000-track library scrolls and
// re-renders as fast as a 100-track one. Rows have a fixed height. `scroller` is the element that scrolls; `container` lives inside it.
export class VirtualList {
  constructor({ scroller, container, rowH, render, overscan = 8 }) {
    Object.assign(this, { scroller, container, rowH, render, overscan }); this.items = []; this.rows = new Map(); this._raf = 0; this._range = [0, 0];
    container.style.position = 'relative'; scroller.addEventListener('scroll', () => this.schedule(), { passive: true });
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => this.schedule()).observe(scroller);
  }
  setItems(items) { this.items = items; this.container.style.height = items.length * this.rowH + 'px'; this.paint(true); }
  schedule() { if (!this._raf) this._raf = requestAnimationFrame(() => { this._raf = 0; this.paint(); }); }
  // Index range currently needed, from the scroller's position relative to the container.
  range() {
    const top = Math.max(0, this.scroller.scrollTop - (this.container.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top + this.scroller.scrollTop)), h = this.scroller.clientHeight || 800;
    return [Math.max(0, Math.floor(top / this.rowH) - this.overscan), Math.min(this.items.length, Math.ceil((top + h) / this.rowH) + this.overscan)];
  }
  paint(force = false) {
    const [a, b] = this.range(); if (!force && a === this._range[0] && b === this._range[1]) return; this._range = [a, b];
    if (force) { this.rows.clear(); this.container.replaceChildren(); }
    for (const [i, el] of this.rows) if (i < a || i >= b) { el.remove(); this.rows.delete(i); }
    const frag = document.createDocumentFragment(); for (let i = a; i < b; i++) if (!this.rows.has(i)) { const el = this.render(this.items[i], i); el.classList.add('vrow'); el.style.top = i * this.rowH + 'px'; el.style.height = this.rowH + 'px'; this.rows.set(i, el); frag.append(el); }
    this.container.append(frag);
  }
  scrollToIndex(i) { const off = this.container.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top + this.scroller.scrollTop; this.scroller.scrollTop = off + i * this.rowH - this.scroller.clientHeight / 2; }
}
