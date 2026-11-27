// Scrobbling plugin: ListenBrainz and Last.fm. Watches the player, counts the time a track is really heard
// (scrobble-logic.js), sends "now playing" as a track starts and the listen once it counts. Listens wait in a queue
// kept in the plugin's settings, so plays made offline (or while a service is down) are sent later, oldest first.
// Tokens and keys are secrets (api.secrets → the system keychain); the Scrobbling page shows the queue and signs in to Last.fm.
import { md5 } from './md5.js';
import { PlayTracker, Queue, LB, lbBody, LFM, lfmForm, lfmScrobbleParams, lfmNowPlayingParams, lfmErrorAction } from './scrobble-logic.js';

const VERSION = '0.1.0';

export function activate(api) {
  const S = (k, d) => api.settings.get(k, d);
  const queue = new Queue({ load: () => S('queue', []), save: q => api.settings.set('queue', q) });
  const log = [], note = (text, bad = false) => { log.unshift({ at: new Date(), text, bad }); log.length = Math.min(log.length, 40); paint(); };
  const client = { name: 'bootleg', version: VERSION };
  const net = (url, init) => api.net.fetch(url, init);

  // ── the services ────────────────────────────────────────────────────────────────────────────────────────────────
  const lb = { id: 'listenbrainz', name: 'ListenBrainz', token: null, user: '', error: '', batch: 100,
    get on() { return !!this.token && !this.error; },
    async init() {
      this.token = await api.secrets.get('listenbrainzToken'); this.user = ''; this.error = ''; if (!this.token) return;
      try { const j = await (await net(`${LB}/1/validate-token`, { headers: { Authorization: `Token ${this.token}` } })).json(); if (j.valid) this.user = j.user_name; else this.error = 'The token was not accepted. Copy it again from your ListenBrainz settings.'; }
      catch (e) { this.user = ''; note(`ListenBrainz: could not check the token (${e.message || e}); listens wait in the queue`, true); }
    },
    async post(body) {
      const r = await net(`${LB}/1/submit-listens`, { method: 'POST', headers: { Authorization: `Token ${this.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (r.ok) return { ok: true };
      if (r.status === 401) return { action: 'auth', msg: 'The token was refused. Copy it again from your ListenBrainz settings.' };
      if (r.status === 429) return { action: 'retry', wait: (+r.headers.get('X-RateLimit-Reset-In') || 10) * 1000, msg: 'rate limited' };
      if (r.status >= 500) return { action: 'retry', msg: `server error ${r.status}` };
      return { action: 'drop', msg: `refused (${r.status}): ${(await r.text().catch(() => '')).slice(0, 200)}` };
    },
    nowPlaying(l) { return this.post(lbBody('playing_now', [l], client)); },
    submit(ls) { return this.post(lbBody(ls.length === 1 ? 'single' : 'import', ls, client)); },
  };
  const lfm = { id: 'lastfm', name: 'Last.fm', key: null, secret: null, sk: null, user: '', error: '', batch: 50, pending: null,
    get on() { return !!(this.key && this.secret && this.sk) && !this.error; },
    get creds() { return { key: this.key, secret: this.secret, sk: this.sk }; },
    async init() {
      [this.key, this.secret, this.sk] = await Promise.all(['lastfmKey', 'lastfmSecret', 'lastfmSession'].map(k => api.secrets.get(k))); this.user = S('lastfmUser', ''); this.error = '';
    },
    async call(method, params, withSession = true) {
      const r = await net(LFM, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: lfmForm(method, params, { key: this.key, secret: this.secret, sk: withSession ? this.sk : null }, md5) });
      const j = await r.json().catch(() => ({ error: 8, message: `HTTP ${r.status}` }));
      if (j.error) { const action = lfmErrorAction(j.error); return { action, msg: `${j.message || 'error'} (${j.error})`, json: j }; }
      return { ok: true, json: j };
    },
    nowPlaying(l) { return this.call('track.updateNowPlaying', lfmNowPlayingParams(l)); },
    async submit(ls) {
      const r = await this.call('track.scrobble', lfmScrobbleParams(ls)); if (!r.ok) return r;
      const ig = r.json.scrobbles?.['@attr']?.ignored; if (ig) note(`Last.fm ignored ${ig} of ${ls.length} (it filters some tracks, e.g. very old timestamps)`);
      return r;
    },
    // Desktop sign-in: get a token, the user allows bootleg on last.fm, then the token becomes a session key (a secret).
    async signIn() {
      const r = await this.call('auth.getToken', {}, false); if (!r.ok) throw new Error(r.msg);
      this.pending = r.json.token; await api.ui.openExternal(`https://www.last.fm/api/auth/?api_key=${encodeURIComponent(this.key)}&token=${encodeURIComponent(this.pending)}`);
    },
    async finish() {
      const r = await this.call('auth.getSession', { token: this.pending }, false); if (!r.ok) throw new Error(r.action === 'auth' ? 'Last.fm has not been told yet that bootleg may scrobble for you. Allow it in the browser, then press Finish again.' : r.msg);
      this.sk = r.json.session.key; this.user = r.json.session.name; this.pending = null; this.error = '';
      await api.secrets.set('lastfmSession', this.sk); api.settings.set('lastfmUser', this.user);
    },
    async signOut() { this.sk = null; this.user = ''; await api.secrets.delete('lastfmSession'); api.settings.set('lastfmUser', ''); },
  };
  const services = [lb, lfm];

  // ── sending ─────────────────────────────────────────────────────────────────────────────────────────────────────
  let sending = false;
  async function flush() {
    if (sending) return; sending = true;
    try {
      for (const s of services) {
        while (s.on && queue.ready(s.id) && queue.count(s.id)) {
          const batch = queue.take(s.id, s.single ? 1 : s.batch); let r;
          try { r = await s.submit(batch.map(x => x.listen)); } catch (e) { r = { action: 'retry', msg: e.message || String(e) }; }
          if (r.ok) { queue.done(batch); queue.ok(s.id); note(`${s.name}: sent ${batch.length === 1 ? `“${batch[0].listen.title}”` : `${batch.length} listens`}`); continue; }
          if (r.action === 'auth') { s.error = r.msg; note(`${s.name}: ${r.msg}`, true); break; }
          if (r.action === 'drop') { if (batch.length > 1) { s.single = true; continue; } queue.done(batch); note(`${s.name}: dropped “${batch[0].listen.title}”: ${r.msg}`, true); continue; }      // a refused batch: go one by one to find the listen it refuses
          const wait = r.wait ? (queue.waitUntil(s.id, r.wait), r.wait) : queue.failed(s.id); note(`${s.name}: ${r.msg}; trying again in ${Math.round(wait / 60000) || 1} min`, true); break;
        }
        if (!queue.count(s.id)) s.single = false;
      }
    } finally { sending = false; paint(); }
  }

  // ── watching the player ─────────────────────────────────────────────────────────────────────────────────────────
  const tracker = new PlayTracker(); let paused = S('paused', false), current = null;
  const eligible = t => t && (t.kind === 'track' || (t.kind === 'render' && S('stems', false)));
  const tick = () => {
    const p = api.player, it = p.item, ok = !paused && eligible(it);
    const ev = tracker.tick(ok ? it : null, ok ? p.pos() : 0, ok && p.playing);
    if (ev.start) { current = ev.start; if (S('nowPlaying', true)) for (const s of services) if (s.on) s.nowPlaying(ev.start).catch(() => {}); paint(); }
    if (ev.counted) { for (const s of services) if (s.token || s.sk) queue.add(s.id, ev.counted); note(`Counted “${ev.counted.title}” by ${ev.counted.artist}`); flush(); }
  };
  const timer = setInterval(tick, 1000), retry = setInterval(flush, 60000);
  const onOnline = () => flush(); globalThis.addEventListener?.('online', onOnline);

  // ── the page ────────────────────────────────────────────────────────────────────────────────────────────────────
  let root = null;
  const el = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs || {})) { if (v == null || v === false) continue; if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (k in e) e[k] = v; else e.setAttribute(k, v); } for (const c of kids.flat()) if (c != null && c !== false && c !== '') e.append(c.nodeType ? c : String(c)); return e; };
  const btn = (label, onclick, cls = 'btn') => el('button', { class: cls, onclick: async () => { try { await onclick(); } catch (e) { note(e.message || String(e), true); } paint(); } }, label);
  function serviceCard(s) {
    const n = queue.count(s.id);
    const state = s.error ? el('span', { class: 'scbad' }, s.error) : s.on ? el('span', { class: 'scok' }, s.user ? `Signed in as ${s.user}` : 'Ready') : el('span', { class: 'muted' }, 'Not set up');
    const kids = [el('h4', {}, s.name), state, n ? el('div', { class: 'muted small' }, `${n} waiting to be sent`) : ''];
    if (s === lb && !lb.token) kids.push(el('div', { class: 'muted small' }, 'Paste your user token in Settings → Plugins → Scrobbling.'));
    if (s === lfm) {
      if (!lfm.key || !lfm.secret) kids.push(el('div', { class: 'muted small' }, 'Add an API key and shared secret in Settings → Plugins → Scrobbling, then sign in here.'));
      else if (!lfm.sk) kids.push(lfm.pending ? el('div', { class: 'scrow' }, el('span', { class: 'small' }, 'Allow bootleg in the browser, then:'), btn('Finish signing in', () => lfm.finish().then(flush))) : btn('Sign in to Last.fm…', () => lfm.signIn()));
      else kids.push(btn('Sign out', () => lfm.signOut(), 'link'));
    }
    if (s.error) kids.push(btn('Try again', async () => { s.error = ''; await s.init(); flush(); }, 'link'));
    return el('div', { class: 'sccard' }, ...kids);
  }
  function paint() {
    if (!root) return;
    root.replaceChildren(el('div', { class: 'scpage' },
      el('div', { class: 'schead' }, el('h3', {}, 'Scrobbling'), el('label', { class: 'scrow' }, el('input', { type: 'checkbox', checked: paused, onchange: e => { paused = e.target.checked; api.settings.set('paused', paused); paint(); } }), 'Pause (nothing is counted while paused)')),
      el('p', { class: 'muted small' }, current && !paused ? `Now: ${current.artist} – ${current.title}` : paused ? 'Paused.' : 'Nothing playing.', ' ', `A track counts after half of it, or 4 minutes, has been heard.`),
      el('div', { class: 'scgrid' }, ...services.map(serviceCard)),
      queue.count() ? el('div', { class: 'scrow' }, btn('Send now', flush), btn('Discard waiting listens', () => { const n = queue.count(); queue.done(queue.items.slice()); note(`Discarded ${n} waiting listen${n === 1 ? '' : 's'}`); }, 'link')) : '',
      log.length ? el('ul', { class: 'sclog' }, ...log.map(x => el('li', { class: x.bad ? 'scbad' : '' }, el('span', { class: 'muted' }, x.at.toLocaleTimeString(), ' '), x.text))) : ''));
  }
  const remove = api.ui.addView({ title: 'Scrobbling', mount(r) { r.append(el('style', {}, CSS)); root = el('div'); r.append(root); paint(); return () => { root = null; }; } });

  Promise.all(services.map(s => s.init())).then(() => { paint(); flush(); });
  return {
    stop() { clearInterval(timer); clearInterval(retry); globalThis.removeEventListener?.('online', onOnline); remove(); },
    status() {
      const on = services.filter(s => s.on).map(s => s.name + (s.user ? ` (${s.user})` : '')), bad = services.filter(s => s.error).map(s => `${s.name}: sign in again`), n = queue.count();
      return [paused ? 'paused' : on.length ? on.join(', ') : 'not set up', ...bad, n ? `${n} waiting` : ''].filter(Boolean).join(' · ');
    },
    _test: { tick, flush, queue, services, tracker },
  };
}

const CSS = `
.scpage { max-width: 860px; padding: 14px 4px 40px; display: grid; gap: 14px; }
.schead { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; } .schead h3 { margin: 0; }
.scrow { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.scgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
.sccard { background: var(--panel2); border-radius: 10px; padding: 12px 14px; display: grid; gap: 6px; justify-items: start; } .sccard h4 { margin: 0; }
.scok { color: #5fd28a; } .scbad { color: #ff8a8a; }
.sclog { list-style: none; margin: 0; padding: 0; font-size: 12px; display: grid; gap: 3px; max-height: 260px; overflow: auto; }
`;
