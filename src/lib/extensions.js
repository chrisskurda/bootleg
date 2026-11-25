// Extensions: optional add-ons that use a small, stable API (docs/EXTENSIONS.md) instead of reaching into the app.
// Each lives in extensions/<id>/ with an extension.json and an ES module exporting `activate(api)` → { stop?, status? }.
// Nothing here knows about any particular extension, and nothing runs unless the user turns it on.
export class Extensions extends EventTarget {
  constructor({ store, api }) { super(); this.store = store; this.api = api; this.list = []; this.running = new Map(); this.errors = new Map(); }
  async init() {
    try { this.list = await (await fetch('/extensions.json')).json(); } catch { this.list = []; }
    await Promise.all(this.list.filter(e => this.enabled(e.id)).map(e => this.start(e.id)));
  }
  enabled(id) { return !!this.store.get('extensions', {})[id]; }
  status(id) { try { return this.running.get(id)?.status?.() || ''; } catch { return ''; } }
  error(id) { return this.errors.get(id) || ''; }
  setting(id, key, def) { return this.store.get(`ext.${id}.${key}`, def); }
  async setSetting(id, key, value) { this.store.set(`ext.${id}.${key}`, value); if (this.running.has(id)) { await this.stop(id); await this.start(id); } }      // simplest correct behaviour: restart with the new value
  async setEnabled(id, on) { const m = this.store.get('extensions', {}); m[id] = !!on; this.store.set('extensions', m); on ? await this.start(id) : await this.stop(id); this.dispatchEvent(new Event('change')); }
  async start(id) {
    if (this.running.has(id)) return; const meta = this.list.find(e => e.id === id); if (!meta) return; this.errors.delete(id);
    try { const mod = await import(meta.entry), inst = await (mod.activate || mod.default)(this.api(id)); this.running.set(id, inst || {}); }
    catch (e) { this.errors.set(id, `Could not start: ${e && e.message || e}`); }
    this.dispatchEvent(new Event('change'));
  }
  async stop(id) { const inst = this.running.get(id); this.running.delete(id); try { await inst?.stop?.(); } catch { /* it is going away anyway */ } this.dispatchEvent(new Event('change')); }
}
