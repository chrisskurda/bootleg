// Secrets: API keys, tokens and anything else a service needs that must not sit in plain app storage. On the desktop
// they go in the OS credential store (macOS Keychain, Windows Credential Manager, Linux Secret Service) through the
// `secret_*` commands (src-tauri/src/secrets.rs). Without one (the browser build, or Linux with no keyring running)
// they fall back to app storage, and `where` says so, so Settings can tell the user. See docs/SECRETS.md.
//
// Keys:  source/<plugin>/<connection>   a library connection's secret config fields, as one JSON object
//        plugin/<id>/<name>             a plugin's own secrets (api.secrets, scoped to the plugin)
//
// Reads are cached, so source plugins can rebuild a session synchronously: `preload` the connections' keys once at
// startup, then `cached(key)`.

const KEY_RE = /^[A-Za-z0-9/:._-]{1,200}$/;

export class Secrets {
  /// `invoke`: Tauri's invoke, or null. `store`: the app's { get, set } storage, used when there is no OS store.
  constructor({ invoke = null, store }) { this.invoke = invoke; this.store = store; this.cache = new Map(); this.status = { kind: 'app', store: 'app storage', error: null }; }

  async init() {
    if (this.invoke) try { const s = await this.invoke('secret_status'); if (s.kind !== 'none') this.status = s; else this.status = { kind: 'app', store: 'app storage', error: s.error }; } catch (e) { this.status = { kind: 'app', store: 'app storage', error: String(e?.message || e) }; }
    return this.status;
  }
  get secure() { return this.status.kind === 'os'; }
  /// A sentence for Settings: where secrets are kept on this machine.
  get where() { return this.status.kind === 'os' ? `in the ${this.status.store}` : this.status.kind === 'memory' ? 'in memory (self-test)' : 'in app storage on this computer (no system keychain is available)'; }

  _check(key) { if (!KEY_RE.test(key)) throw new Error(`bad secret key: ${key}`); }
  _app() { return this.store.get('secrets', {}); }
  async get(key) {
    this._check(key); if (this.cache.has(key)) return this.cache.get(key);
    const v = this.status.kind === 'app' ? this._app()[key] ?? null : await this.invoke('secret_get', { key });
    this.cache.set(key, v ?? null); return v ?? null;
  }
  async set(key, value) {
    this._check(key); if (value == null || value === '') return this.delete(key); value = String(value);
    if (this.status.kind === 'app') { const a = this._app(); a[key] = value; this.store.set('secrets', a); } else await this.invoke('secret_set', { key, value });
    this.cache.set(key, value);
  }
  async delete(key) {
    this._check(key);
    if (this.status.kind === 'app') { const a = this._app(); if (key in a) { delete a[key]; this.store.set('secrets', a); } } else await this.invoke('secret_delete', { key });
    this.cache.set(key, null);
  }
  async getJSON(key) { const v = await this.get(key); try { return v ? JSON.parse(v) : null; } catch { return null; } }
  setJSON(key, obj) { return this.set(key, obj && Object.keys(obj).length ? JSON.stringify(obj) : null); }
  cached(key) { const v = this.cache.get(key); try { return v ? JSON.parse(v) : null; } catch { return null; } }
  async preload(keys) { await Promise.all(keys.map(k => this.get(k).catch(e => { console.warn('secret', k, e); return null; }))); }

  /// A plugin's view: its own namespace only.
  scoped(id) {
    const k = name => { if (!/^[A-Za-z0-9._-]{1,80}$/.test(name)) throw new Error(`bad secret name: ${name}`); return `plugin/${id}/${name}`; };
    const s = this;
    return { get: n => s.get(k(n)), set: (n, v) => s.set(k(n), v), delete: n => s.delete(k(n)), get secure() { return s.secure; }, get where() { return s.where; } };
  }
}

// ── Library connections ─────────────────────────────────────────────────────────────────────────────────────────────
// A source plugin lists its secret config fields in `secrets` (Subsonic: ['token']). They are kept out of the saved
// config and stored under source/<plugin>/<connection>; `fullConfig` puts them back for `session(config)`.
export const connKey = conn => `source/${conn.plugin}/${conn.id}`;
export function splitConfig(plugin, config) {
  const keep = { ...config }, secret = {};
  for (const f of plugin?.secrets || []) if (f in keep) { secret[f] = keep[f]; delete keep[f]; }
  return { config: keep, secret };
}
export const fullConfig = (secrets, conn) => ({ ...conn.config, ...(secrets.cached(connKey(conn)) || {}) });

/// Moves secret fields still in saved connections (from before secrets existed) into the store. Returns how many moved.
/// A field is only removed from the config once the store has it.
export async function migrateConnections(secrets, libs, getSource) {
  let n = 0;
  for (const { conn } of libs.allConnections()) {
    const { config, secret } = splitConfig(getSource(conn.plugin), conn.config); if (!Object.keys(secret).length) continue;
    const key = connKey(conn), had = (await secrets.getJSON(key)) || {};
    await secrets.setJSON(key, { ...had, ...secret }); conn.config = config; n++;
  }
  if (n) libs._save();
  return n;
}
