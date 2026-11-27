import { Secrets, connKey, splitConfig, fullConfig, migrateConnections } from '../src/lib/secrets.js';
import { Libraries } from '../src/lib/libraries.js';
let bad = 0; const t = (n, ok, note = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${note ? '   ' + note : ''}`); if (!ok) bad++; };
const mem = o => { const m = { ...o }; return { get: (k, d) => k in m ? JSON.parse(JSON.stringify(m[k])) : d, set: (k, v) => { m[k] = JSON.parse(JSON.stringify(v)); }, m }; };
const sub = { id: 'subsonic', secrets: ['token'] }, getSource = id => (id === 'subsonic' ? sub : null);

// no OS store (browser): app storage, and it says so
{ const st = mem({}), s = new Secrets({ store: st }); await s.init();
  t('without a keychain, secrets fall back to app storage and say so', !s.secure && /app storage/.test(s.where));
  await s.set('plugin/x/key', 'abc'); t('…and round-trip there', (await new Secrets({ store: st }).get('plugin/x/key')) === 'abc' && st.m.secrets['plugin/x/key'] === 'abc');
  await s.set('plugin/x/key', ''); t('setting an empty value deletes', (await s.get('plugin/x/key')) === null && !('plugin/x/key' in st.m.secrets));
  let threw = false; try { await s.get('bad key'); } catch { threw = true; } t('bad keys are refused', threw); }

// an OS store (mocked invoke)
{ const kc = new Map(), calls = []; const invoke = async (c, a) => { calls.push(c); if (c === 'secret_status') return { kind: 'os', store: 'macOS Keychain', error: null }; if (c === 'secret_get') return kc.get(a.key) ?? null; if (c === 'secret_set') { kc.set(a.key, a.value); return null; } if (c === 'secret_delete') { kc.delete(a.key); return null; } throw new Error(c); };
  const st = mem({}), s = new Secrets({ invoke, store: st }); await s.init();
  t('with a keychain, Settings can say which one', s.secure && s.where === 'in the macOS Keychain');
  const p = s.scoped('scrobble'); await p.set('listenbrainz', 'tok');
  t('a plugin\'s secrets are namespaced by its id and go to the keychain, not app storage', kc.get('plugin/scrobble/listenbrainz') === 'tok' && !st.m.secrets && (await p.get('listenbrainz')) === 'tok');
  let threw = false; try { await p.get('../cd/x'); } catch { threw = true; } t('a plugin cannot reach outside its namespace', threw && !('_s' in p) && Object.keys(p).every(k => ['get', 'set', 'delete', 'secure', 'where'].includes(k)));
  const n = calls.length; await p.get('listenbrainz'); t('reads are cached', calls.length === n);

  // connections
  const conn = { id: 'c1', plugin: 'subsonic', title: 'x', config: { url: 'u', username: 'a', salt: 's', token: 'T' } };
  const { config, secret } = splitConfig(sub, conn.config); t('splitConfig keeps the secret fields out of the saved config', !('token' in config) && config.salt === 's' && secret.token === 'T');
  const libs = new Libraries(mem({})); libs.addConnection(libs.target().id, { ...conn, config: { ...conn.config } }); libs.addConnection(libs.target().id, { id: 'c2', plugin: 'stemserver', title: 'y', config: { url: 'v' } });
  const moved = await migrateConnections(s, libs, getSource);
  t('old connections are migrated: the token moves to the keychain, other connections are untouched', moved === 1 && !('token' in libs.connection('c1').config) && JSON.parse(kc.get('source/subsonic/c1')).token === 'T' && libs.connection('c2').config.url === 'v');
  t('…and migrating again does nothing', (await migrateConnections(s, libs, getSource)) === 0);
  const s2 = new Secrets({ invoke, store: st }); await s2.init(); await s2.preload([connKey(libs.connection('c1'))]);
  t('after a restart, preload + fullConfig give the session its token back synchronously', fullConfig(s2, libs.connection('c1')).token === 'T' && fullConfig(s2, libs.connection('c1')).url === 'u'); }

// a keychain that fails at startup → app storage
{ const s = new Secrets({ invoke: async () => ({ kind: 'none', store: '', error: 'no Secret Service' }), store: mem({}) }); await s.init();
  t('a missing Secret Service (Linux without a keyring) falls back to app storage with the reason', !s.secure && s.status.error === 'no Secret Service'); }

console.log(bad ? `\n${bad} FAILED` : '\nall secrets tests pass'); process.exit(bad ? 1 : 0);
