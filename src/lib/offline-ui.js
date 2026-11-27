// The offline store in the app (desktop): keeps server tracks (and files on network shares) on this computer by the
// rules in Settings → Offline, plays from those copies, and fetches server tracks for device sync.
// Rules and planning: ./offline.js. Files: src-tauri/src/offline.rs. Playback: ./offline-hook.js.
import { OFFLINE_DEFAULTS, QUALITIES, ruleLabel, ruleId, addRule, removeRule, moveRule, hasRule, wantedBy, jobFor, planOffline, bestCopies, isKept, gb, bytesOfGB } from './offline.js';
import { setOfflineResolver } from './offline-hook.js';
import { human } from './devices.js';

export function initOffline({ h, lib, notes, keyOf, toast, store, plural, getPlugin, sessionOf, player }) {
  const T = window.__TAURI__, invoke = T?.core?.invoke;
  if (!invoke) return null;
  let cfg = { ...OFFLINE_DEFAULTS, ...store.get('offline', {}) };
  const held = new Map(store.get('offlineHeld', []));          // entry id → the card it was fetched for ("keep" card fetches)
  let info = null, copies = new Map(), busy = '', progress = null, last = null, box = null, timer = 0, openP = null;
  const save = () => store.set('offline', cfg), saveHeld = () => store.set('offlineHeld', [...held]);
  const listeners = new Set();

  function load(i) {
    info = i; copies = bestCopies(i.entries);
    for (const id of [...held.keys()]) if (!i.entries.some(e => e.id === id)) held.delete(id);
    saveHeld();
    const urls = new Map([...copies].map(([k, c]) => [k, T.core.convertFileSrc(c.path)]));
    setOfflineResolver(cfg.on ? k => urls.get(k) : null);
    paint(); listeners.forEach(f => f());
  }
  const open = () => (openP ||= invoke('offline_open', { dir: cfg.dir || null }).then(load).catch(e => { openP = null; toast('Offline store: ' + (e.message || e), true); }));

  async function ctx() {
    const all = [...lib.tracks, ...lib.renders];
    return { byKey: new Map(all.map(t => [keyOf(t), t])), playlists: await notes.playlists(), albums: new Map(lib.albums().map(a => [a.key, a])), records: (await notes.export()).tracks };
  }
  async function plan() {
    const w = wantedBy(cfg.rules, await ctx(), { stems: cfg.stems, getPlugin });
    const wanted = w.map(x => ({ job: jobFor(x.src, cfg.quality, { getPlugin, sessionOf }), rule: x.rule })).filter(x => x.job);
    return planOffline({ wanted, entries: info.entries, maxBytes: bytesOfGB(cfg.maxGB), held: new Set(held.keys()), auto: cfg.auto, autoBytes: bytesOfGB(cfg.autoGB) });
  }
  function fetchJobs(jobs, temp, onProgress) {
    const ch = new T.core.Channel(); ch.onmessage = p => { progress = p; onProgress?.(p); paintProgress(); };
    return invoke('offline_fetch', { jobs, temp, onProgress: ch });
  }

  /** Bring the store in line with the rules: remove what nothing asks for, then download what's missing. */
  async function sync({ quiet = false } = {}) {
    if (busy) return; await open(); if (!info) return;
    if (!cfg.on) { busy = ''; return; }
    busy = 'Working out what to keep…'; paint();
    try {
      const p = await plan(); last = { over: p.over.length, overBytes: p.over.reduce((n, w) => n + (w.job.size || 0), 0), at: Date.now() };
      if (p.remove.length) load(await invoke('offline_remove', { ids: p.remove }));
      if (p.fetch.length) {
        busy = `Downloading ${plural(p.fetch.length, 'file')}…`; paint();
        const res = await fetchJobs(p.fetch, false), failed = res.filter(r => r.error && r.error !== 'stopped');
        last.failed = failed.slice(0, 20).map(r => `${r.id.split('|')[0]}: ${r.error}`);
        if (!quiet || failed.length) toast(`Offline: ${plural(res.length - failed.length - res.filter(r => r.error === 'stopped').length, 'file')} kept${failed.length ? `, ${failed.length} failed` : ''}`, !!failed.length);
      } else if (!quiet) toast(p.remove.length ? `Offline: ${plural(p.remove.length, 'file')} let go` : 'Offline: everything is already kept');
      load(await invoke('offline_info'));
    } catch (e) { toast('Offline: ' + (e.message || e), true); }
    busy = ''; progress = null; paint();
  }
  const soon = () => { clearTimeout(timer); timer = setTimeout(() => sync({ quiet: true }), 1500); };

  // ---- rules from anywhere in the app (playlist rows, album pages, tracks)
  function toggle(rule) {
    const on = !hasRule(cfg.rules, rule); cfg.rules = on ? addRule(cfg.rules, rule) : removeRule(cfg.rules, rule); save();
    toast(on ? `${ruleLabel(rule)} will be kept offline` : `${ruleLabel(rule)} is no longer kept offline`); soon(); paint(); listeners.forEach(f => f());
  }
  const keepButton = (rule, cls = 'mini') => {
    const on = hasRule(cfg.rules, rule);
    const b = h('button', { class: cls + (on ? ' on' : ''), title: on ? 'Kept on this computer for listening offline. Click to stop keeping it.' : 'Keep on this computer, to play without the server or the network (Settings → Offline)', onclick: e => { e.stopPropagation(); toggle(rule); b.replaceWith(keepButton(rule, cls)); } }, on ? '⤓ offline ✓' : '⤓ keep offline');
    return b;
  };
  const trackButton = t => keepButton({ type: 'track', key: keyOf(t), name: t.title }, 'mini');
  const kept = t => isKept(t, copies, { stems: cfg.stems });

  // ---- device sync: local files for server tracks (fetched when missing; kept or temporary per Settings → Offline)
  async function localFor(srcs, { quality = cfg.quality, card = '', onProgress } = {}) {
    await open(); const map = new Map(), need = [], failed = [];
    for (const src of srcs) {
      if (src.kind !== 'remote') continue;
      const job = jobFor(src, quality, { getPlugin, sessionOf }); if (!job) { failed.push({ key: src.path, why: 'its service does not allow keeping copies' }); continue; }
      const e = info?.entries.find(x => x.id === job.id && x.fp === job.fp);
      if (e) map.set(src.path, e.path); else need.push(job);
    }
    if (!need.length) return { map, failed, fetched: 0 };
    const temp = cfg.cardFetch === 'temp', res = await fetchJobs(need, temp, onProgress);
    for (const r of res) {
      const key = r.id.slice(0, r.id.lastIndexOf('|'));
      if (r.path) { map.set(key, r.path); if (!temp) held.set(r.id, card || 'a card'); } else failed.push({ key, why: r.error });
    }
    saveHeld(); if (!temp) load(await invoke('offline_info'));
    return { map, failed, fetched: res.filter(r => r.path).length };
  }
  /** A kept copy of this server source at this quality (null when there isn't one, or it is out of date). */
  function keptPath(src, quality = cfg.quality) {
    if (src?.kind !== 'remote' || !info) return null;
    const job = jobFor(src, quality, { getPlugin, sessionOf }); if (!job) return null;
    return info.entries.find(x => x.id === job.id && x.fp === job.fp)?.path || null;
  }
  /** Which of these server sources a card sync would have to download first (and roughly how much). */
  function pendingFor(srcs, quality = cfg.quality) {
    let n = 0, bytes = 0;
    for (const src of srcs) {
      if (src.kind !== 'remote') continue; const job = jobFor(src, quality, { getPlugin, sessionOf }); if (!job) continue;
      if (!info?.entries.some(x => x.id === job.id && x.fp === job.fp)) { n++; bytes += job.size || 0; }
    }
    return { n, bytes };
  }
  const afterCard = () => (cfg.cardFetch === 'temp' ? invoke('offline_clear_temp').catch(() => {}) : null);

  // ---- "also keep what I play"
  let lastItem = null;
  player?.addEventListener('change', () => {
    const it = player.item; if (!it || it === lastItem || !info) return; lastItem = it;
    const srcs = it.kind === 'render' ? [it.mix].filter(Boolean) : [it.src];
    const ids = srcs.map(s => copies.get(s?.path)?.id).filter(Boolean);
    if (ids.length) { invoke('offline_touch', { ids }).catch(() => {}); return; }
    if (!cfg.on || !cfg.auto || busy) return;
    const jobs = srcs.filter(s => s?.kind === 'remote').map(s => jobFor(s, cfg.quality, { getPlugin, sessionOf })).filter(Boolean);
    if (jobs.length) fetchJobs(jobs, false).then(async () => { await invoke('offline_touch', { ids: jobs.map(j => j.id) }); load(await invoke('offline_info')); soon(); }).catch(() => {});
  });

  // ---- Settings → Offline
  function paintProgress() {
    const el = box?.querySelector('.off-prog'); if (!el || !progress) return paint();
    const frac = progress.total ? (progress.done + (progress.size ? Math.min(1, progress.bytes / progress.size) : 0)) / progress.total : 0;
    el.querySelector('i').style.width = (frac * 100) + '%'; el.querySelector('span').textContent = `${progress.done + 1 > progress.total ? progress.total : progress.done + 1} of ${progress.total}: ${progress.what}`;
  }
  function paint() {
    if (!box?.isConnected) return;
    const limit = bytesOfGB(cfg.maxGB), used = info?.used || 0, n = info?.entries.length || 0, heldBytes = info ? info.entries.filter(e => held.has(e.id)).reduce((s, e) => s + e.size, 0) : 0;
    const row = (label, hint, input) => h('label', { class: 'srow' }, h('span', {}, h('b', {}, label), hint ? h('small', {}, hint) : ''), input);
    const set = patch => { cfg = { ...cfg, ...patch }; save(); if ('dir' in patch) { openP = null; open(); } else { soon(); paint(); } };
    const rules = cfg.rules.map(r => h('div', { class: 'off-rule' }, h('span', {}, ruleLabel(r)), h('span', { class: 'grow' }),
      h('button', { class: 'mini', title: 'Higher priority', onclick: () => set({ rules: moveRule(cfg.rules, r, -1) }) }, '↑'), h('button', { class: 'mini', title: 'Lower priority', onclick: () => set({ rules: moveRule(cfg.rules, r, 1) }) }, '↓'),
      h('button', { class: 'mini', onclick: () => set({ rules: removeRule(cfg.rules, r) }) }, 'remove')));
    const rating = cfg.rules.find(r => r.type === 'rating');
    box.replaceChildren(
      h('div', { class: 'srow' }, h('span', {}, h('b', {}, 'Kept on this computer'), h('small', {}, info ? `${human(used)} of ${gb(limit)} · ${plural(n, 'file')}${heldBytes ? ` · ${human(heldBytes)} for device cards` : ''}${info.free != null ? ` · ${human(info.free)} free on that disk` : ''}` : 'Opening…')),
        h('span', { class: 'sbtns' }, busy ? h('button', { class: 'btn', onclick: () => invoke('offline_cancel') }, 'Stop') : h('button', { class: 'btn', disabled: !cfg.on, onclick: () => sync() }, 'Sync now'))),
      info ? h('div', { class: 'dv-space', title: `${human(used)} of ${gb(limit)}` }, h('i', { class: 'ours', style: `width:${Math.min(100, used / Math.max(1, limit) * 100)}%` })) : '',
      busy ? h('div', { class: 'off-prog' }, h('div', { class: 'pbar' }, h('i', { style: 'width:0%' })), h('span', { class: 'small muted' }, busy)) : '',
      last?.over ? h('div', { class: 'small err' }, `${plural(last.over, 'file')} (about ${human(last.overBytes)}) didn’t fit in ${gb(limit)}: the rules lowest in the list lose first. Raise the limit or choose less.`) : '',
      last?.failed?.length ? h('details', { class: 'small' }, h('summary', {}, `${last.failed.length} failed`), h('pre', { class: 'err' }, last.failed.join('\n'))) : '',
      row('Keep music offline', 'Server tracks (Subsonic, the stem server) and files on network shares are copied here by the rules below and play from the copy, without the server or the network. Services whose terms forbid copies are never kept.', h('input', { type: 'checkbox', checked: cfg.on, onchange: e => { set({ on: e.target.checked }); load(info); } })),
      h('div', { class: 'srow col' }, h('span', {}, h('b', {}, 'What to keep'), h('small', {}, 'First ones first when space runs out. Add playlists, albums and tracks with “⤓ keep offline” on them.')),
        rules.length ? h('div', { class: 'off-rules' }, ...rules) : h('span', { class: 'muted small' }, 'Nothing yet.')),
      row('Also everything rated', 'Tracks with at least this rating.', h('select', { onchange: e => { const min = +e.target.value; set({ rules: min ? addRule(removeRule(cfg.rules, { type: 'rating' }), { type: 'rating', min }) : removeRule(cfg.rules, { type: 'rating' }) }); } },
        ...[[0, 'no'], [3, '3★ or more'], [4, '4★ or more'], [4.5, '4½★ or more'], [5, '5★']].map(([v, l]) => h('option', { value: v, selected: (rating?.min || 0) === v }, l)))),
      row('Also everything starred', 'Tracks tagged “starred” (a server’s favourites).', h('input', { type: 'checkbox', checked: hasRule(cfg.rules, { type: 'starred' }), onchange: e => set({ rules: e.target.checked ? addRule(cfg.rules, { type: 'starred' }) : removeRule(cfg.rules, { type: 'starred' }) }) })),
      row('Space to use', 'At most this much (GB). Copies kept for device cards count too.', h('input', { type: 'number', min: 0, step: 1, value: cfg.maxGB, style: 'width:90px', onchange: e => set({ maxGB: Math.max(0, +e.target.value || 0) }) })),
      row('Quality', 'Original keeps the file as it is. High and Space saver ask the server to convert (Subsonic servers can; files on shares and stem servers stay original).', h('select', { onchange: e => set({ quality: e.target.value }) }, ...Object.entries(QUALITIES).map(([k, l]) => h('option', { value: k, selected: k === cfg.quality }, l)))),
      row('Stem sets', 'Off: their mix and details (a few MB). On: their stems too, to mute and solo offline.', h('input', { type: 'checkbox', checked: cfg.stems, onchange: e => set({ stems: e.target.checked }) })),
      row('Also keep what I play', 'Server tracks you play are kept too, up to their own limit; the least recently played go first. Off by default.', h('span', { class: 'sbtns' }, h('input', { type: 'checkbox', checked: cfg.auto, onchange: e => set({ auto: e.target.checked }) }), h('input', { type: 'number', min: 0, step: 1, value: cfg.autoGB, style: 'width:70px', title: 'GB', disabled: !cfg.auto, onchange: e => set({ autoGB: Math.max(0, +e.target.value || 0) }) }), h('span', { class: 'small muted' }, 'GB'))),
      row('Server tracks for device cards', 'When a card sync needs server tracks that aren’t kept yet: keep them here too (no second download next time), or fetch them just for the copy.', h('select', { onchange: e => set({ cardFetch: e.target.value }) }, h('option', { value: 'keep', selected: cfg.cardFetch !== 'temp' }, 'Keep them offline (default)'), h('option', { value: 'temp', selected: cfg.cardFetch === 'temp' }, 'Temporary, only for the copy'))),
      row('Where', info ? info.dir : '', h('span', { class: 'sbtns' }, h('button', { class: 'btn', onclick: async () => { const d = await T.dialog?.open?.({ directory: true }).catch(() => null); if (d) set({ dir: String(d) }); } }, 'Choose folder…'), cfg.dir ? h('button', { class: 'link', onclick: () => set({ dir: '' }) }, 'default') : '')),
      held.size ? row('Kept for device cards', `${plural(held.size, 'file')} fetched for card syncs. Let them go to free the space (the next card sync fetches what it needs again; anything a rule above wants is fetched again by the next sync).`, h('button', { class: 'btn', onclick: async () => { const ids = [...held.keys()]; held.clear(); saveHeld(); load(await invoke('offline_remove', { ids })); soon(); } }, 'Let them go')) : '',
    );
    if (busy && progress) paintProgress();
  }
  function settingsSection() { box = h('div', { class: 'off-box' }); open().then(paint); paint(); return [h('h3', {}, 'Offline'), box]; }

  // start: open the store, and once the library has loaded, apply the rules quietly
  open().then(() => setTimeout(() => sync({ quiet: true }), 20000));

  return { open, sync, toggle, keepButton, trackButton, kept, localFor, keptPath, pendingFor, afterCard, settingsSection, hasRule: r => hasRule(cfg.rules, r), get config() { return cfg; }, onChange: f => listeners.add(f), ruleId };
}
