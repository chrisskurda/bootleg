// Extensions and plugins: optional add-ons that use a small, stable API instead of reaching into the app.
//   spec 1 (docs/EXTENSIONS.md): extensions/<id>/extension.json + an ES module exporting `activate(api)` → { stop?, status? }
//   spec 2 (docs/PLUGIN-SPEC.md): plugins/<id>/plugin.json — the same activate(api), plus platforms, native code, stability
// Nothing here knows about any particular one, and nothing runs unless the user turns it on.
export const PLUGIN_SPEC = '2.0';
const [SPEC_MAJOR, SPEC_MINOR] = PLUGIN_SPEC.split('.').map(Number);

/// Can this app load a plugin written against `spec`? Same major, minor not newer (spec §1).
export function specOk(spec) { const [M, m] = String(spec || '1.0').split('.').map(Number); return M === 1 || (M === SPEC_MAJOR && (m || 0) <= SPEC_MINOR); }

/// Where a plugin stands on this target (spec §4): { status, why, native, can } — `can` = it may be turned on here.
export function availability(meta, rt) {
  if (!meta.spec || String(meta.spec).startsWith('1')) return { status: 'supported', why: '', can: true };      // spec 1: JS only, everywhere
  if (!specOk(meta.spec)) return { status: 'unavailable', why: `written for plugin spec ${meta.spec}; this bootleg implements ${PLUGIN_SPEC}`, can: false };
  const p = meta.platforms?.[rt.os] || { status: 'unavailable' };
  const experimental = meta.stability === 'experimental';
  if (p.status === 'unavailable') return { status: 'unavailable', why: p.why || `not available on ${rt.os}`, can: false };
  if (meta.native && !rt.native.includes(meta.id)) return { status: 'missing', why: 'not included in this build', can: false };
  return { status: experimental && p.status === 'supported' ? 'experimental' : p.status, why: '', can: true, experimental };
}

export class Extensions extends EventTarget {
  constructor({ store, api, runtime }) { super(); this.store = store; this.api = api; this.runtime = runtime || { os: 'web', arch: '', native: [], spec: PLUGIN_SPEC }; this.list = []; this.running = new Map(); this.errors = new Map(); }
  async init() {
    const get = async u => { try { return await (await fetch(u)).json(); } catch { return []; } };
    const [ext, plug] = await Promise.all([get('/extensions.json'), get('/plugins.json')]);
    this.list = [...plug.map(p => ({ ...p, kind: 'plugin' })), ...ext.filter(e => !plug.some(p => p.id === e.id)).map(e => ({ ...e, spec: '1.0', kind: 'extension' }))];
    await Promise.all(this.list.filter(e => this.enabled(e.id) && this.availability(e.id).can).map(e => this.start(e.id)));
  }
  meta(id) { return this.list.find(e => e.id === id); }
  availability(id) { const m = this.meta(id); return m ? availability(m, this.runtime) : { status: 'unavailable', why: 'unknown plugin', can: false }; }
  enabled(id) { return !!this.store.get('extensions', {})[id]; }
  /// Experimental targets/plugins and disclaimers need the user's OK once (spec §4, §9.2); remembered per plugin version.
  needsConfirm(id) { const m = this.meta(id), a = this.availability(id); if (!m || !(a.status === 'experimental' || m.disclaimer)) return ''; return this.store.get('pluginConfirmed', {})[id] === m.version ? '' : (m.disclaimer || `${m.name} is experimental on ${this.runtime.os}: it passes its tests against a simulator but has not been checked on real hardware here yet.`); }
  confirm(id) { const c = this.store.get('pluginConfirmed', {}); c[id] = this.meta(id)?.version; this.store.set('pluginConfirmed', c); }
  status(id) { try { return this.running.get(id)?.status?.() || ''; } catch { return ''; } }
  error(id) { return this.errors.get(id) || ''; }
  setting(id, key, def) { return this.store.get(`ext.${id}.${key}`, def); }
  async setSetting(id, key, value) { this.store.set(`ext.${id}.${key}`, value); if (this.running.has(id)) { await this.stop(id); await this.start(id); } }      // simplest correct behaviour: restart with the new value
  async setEnabled(id, on) {
    if (on && !this.availability(id).can) return;
    const m = this.store.get('extensions', {}); m[id] = !!on; this.store.set('extensions', m); on ? await this.start(id) : await this.stop(id); this.dispatchEvent(new Event('change'));
  }
  async start(id) {
    if (this.running.has(id)) return; const meta = this.meta(id); if (!meta) return; this.errors.delete(id);
    try { const mod = await import(meta.entry), inst = await (mod.activate || mod.default)(this.api(id, meta)); this.running.set(id, inst || {}); }
    catch (e) { this.errors.set(id, `Could not start: ${e && e.message || e}`); }
    this.dispatchEvent(new Event('change'));
  }
  async stop(id) { const inst = this.running.get(id); this.running.delete(id); try { await inst?.stop?.(); } catch { /* it is going away anyway */ } this.dispatchEvent(new Event('change')); }
}

/// `api.native` for a plugin with a Rust part (spec §6): its own commands only, plus jobs over a Tauri Channel.
export function nativeApi(T, id) {
  const cmd = c => `plugin:bootleg-${id}|${c}`;
  return {
    invoke: (c, args = {}) => T.core.invoke(cmd(c), args),
    /// job(cmd, args, onEvent) → { id: Promise<number>, done: Promise<result>, cancel() } — the native command receives the Channel as `onEvent`
    job(c, args = {}, onEvent = () => {}) {
      let jobId = null, cancelWanted = false, resolveId; const idP = new Promise(r => { resolveId = r; });
      const done = new Promise((ok, no) => {
        const ch = new T.core.Channel();
        ch.onmessage = ev => {
          if (ev.type === 'started') { jobId = ev.id; resolveId(ev.id); if (cancelWanted) T.core.invoke('plugin_job_cancel', { id: jobId }); }
          try { onEvent(ev); } catch (e) { console.warn(e); }
          if (ev.type === 'done') ok(ev.result); else if (ev.type === 'error') { const e = new Error(ev.message); e.cancelled = ev.cancelled; no(e); }
        };
        T.core.invoke(cmd(c), { ...args, onEvent: ch }).then(n => { if (jobId == null) { jobId = n; resolveId(n); } }, no);
      });
      return { id: idP, done, cancel() { cancelWanted = true; if (jobId != null) return T.core.invoke('plugin_job_cancel', { id: jobId }); } };
    },
  };
}
