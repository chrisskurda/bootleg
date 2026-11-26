// The Devices page: pair SD cards and USB-storage players, choose what goes on each, sync, and bring back what was
// played and rated on them. Desktop only. Logic: devices.js; the card itself: src-tauri/src/devices.rs.
import { filesFor, selectionFor, mergeOutbox, notesFor, human, MODES } from '/lib/devices.js';

const RATINGS = { 0: 'Off', 3: '★★★ and up', 3.5: '★★★½ and up', 4: '★★★★ and up', 4.5: '★★★★½ and up', 5: '★★★★★ only' };
const ago = s => { if (!s) return 'never'; const d = Date.now() / 1000 - s; return d < 90 ? 'just now' : d < 5400 ? Math.round(d / 60) + ' min ago' : d < 129600 ? Math.round(d / 3600) + ' h ago' : new Date(s * 1000).toLocaleDateString(); };

export function initDevices({ root, h, lib, notes, keyOf, toast, store, plural }) {
  const T = window.__TAURI__, invoke = T?.core?.invoke;
  const known = () => store.get('devices.known', {});          // paired media this computer has seen, by id
  const remember = m => { const k = known(); k[m.id] = { id: m.id, name: m.name, volume: m.volume, lastSeen: Date.now(), player: m.players?.[0]?.name || k[m.id]?.player || '' }; store.set('devices.known', k); };
  const forget = id => { const k = known(); delete k[id]; store.set('devices.known', k); };
  const state = new Map();                                       // volume → { plan, busy, progress, confirm, msg }
  const st = v => { if (!state.has(v)) state.set(v, {}); return state.get(v); };
  let media = [], loading = false, timer = 0;

  async function refresh() {
    if (!invoke || loading) return; loading = true;
    try { media = await invoke('devices_list', { known: Object.values(known()).map(k => k.volume) }); media.filter(m => m.paired && m.id).forEach(remember); }
    catch (e) { toast('Devices: ' + (e.message || e), true); }
    loading = false; paint();
  }

  // ---- selection → files
  async function selection(m) {
    const all = [...lib.tracks, ...lib.renders], byKey = new Map(all.map(t => [keyOf(t), t]));
    const doc = await notes.export(), playlists = await notes.playlists();
    const sel = selectionFor(m, { playlists, byKey, records: doc.tracks });
    const { files, skipped } = filesFor(sel.tracks, { keyOf, stems: m.stems });
    return { files, skipped, keys: sel.tracks.map(keyOf), playlists: sel.playlists.map(p => ({ name: p.name, tracks: p.items.map(keyOf) })), byKey };
  }

  async function bringBack(m, quiet = false) {
    const files = await invoke('device_outbox', { volume: m.volume });
    if (!files.length) { if (!quiet) toast('Nothing new from the player'); return null; }
    const all = new Set([...lib.tracks, ...lib.renders].map(keyOf));
    const r = await mergeOutbox(notes, files, { known: k => all.has(k) });
    await invoke('device_outbox_ack', { volume: m.volume, files: files.map(f => f.file) });
    const bits = [r.ratings && plural(r.ratings, 'rating'), r.notes && plural(r.notes, 'note'), r.tags && plural(r.tags, 'tag change'), r.plays && plural(r.plays, 'play')].filter(Boolean);
    if (!quiet || bits.length) toast(`From ${m.name}: ${bits.join(', ') || 'nothing that applies here'}${r.unknown ? ` (${r.unknown} for files bootleg didn’t put there)` : ''}`);
    return r;
  }

  async function check(m) {
    const s = st(m.volume); s.busy = 'Checking…'; s.confirm = false; paint();
    try {
      const sel = await selection(m);
      s.plan = await invoke('device_plan', { volume: m.volume, items: sel.files, playlists: sel.playlists });
      s.plan.skipped = [...sel.skipped, ...s.plan.skipped.map(x => ({ ...x, title: sel.byKey.get(x.track)?.title || x.track }))];
      s.keys = sel.keys;
    } catch (e) { s.plan = null; s.msg = String(e.message || e); }
    s.busy = null; paint();
    return s.plan;
  }

  async function sync(m) {
    const s = st(m.volume);
    if (!s.plan) { await check(m); if (!s.plan) return; if (s.plan.delete && !s.confirm) { s.confirm = true; paint(); return; } }
    if (s.plan.short_by) { toast(`Doesn’t fit: ${human(s.plan.short_by)} short. Choose less, or use Fill.`, true); return; }
    s.busy = 'Syncing…'; s.progress = { done: 0, total: 1, what: '' }; paint();
    try {
      await bringBack(m, true);                                   // the player's ratings first, so notes.json carries them
      const ch = new T.core.Channel(); ch.onmessage = p => { s.progress = p; paintProgress(m.volume); };
      const r = await invoke('device_apply', { planId: s.plan.id, onProgress: ch });
      await invoke('device_write_notes', { volume: m.volume, doc: await notesFor(notes, s.keys || []) }).catch(() => {});
      toast(r.cancelled ? `Stopped. ${plural(r.copied, 'file')} copied so far.` : `${m.name}: ${plural(r.copied, 'file')} copied (${human(r.bytes)}), ${r.deleted} removed${r.failed.length ? `, ${r.failed.length} failed` : ''}`, !!r.failed.length);
      s.msg = r.failed.length ? r.failed.slice(0, 5).map(([p, e]) => `${p}: ${e}`).join('\n') : '';
    } catch (e) { toast(String(e.message || e), true); }
    s.plan = null; s.busy = null; s.progress = null; s.confirm = false; await refresh();
  }

  async function set(m, patch) {
    try { const n = await invoke('device_settings', { volume: m.volume, patch }); Object.assign(m, n); st(m.volume).plan = null; remember(m); }
    catch (e) { toast(String(e.message || e), true); }
    paint();
  }

  // ---- painting
  const bar = m => {
    if (!m.total) return '';
    const used = m.total - (m.free ?? 0), ours = m.bytes || 0;
    return h('div', { class: 'dv-space', title: `${human(m.free)} free of ${human(m.total)}` },
      h('i', { class: 'other', style: `width:${Math.max(0, (used - ours) / m.total * 100)}%` }), h('i', { class: 'ours', style: `width:${ours / m.total * 100}%` }));
  };
  const row = (label, hint, input) => h('label', { class: 'srow' }, h('span', {}, h('b', {}, label), hint ? h('small', {}, hint) : ''), input);

  function pairForm(m) {
    const name = h('input', { value: m.label, 'aria-label': 'Name' }), mode = h('select', { 'aria-label': 'Mode' }, ...Object.entries(MODES).map(([k, x]) => h('option', { value: k }, x.label)));
    const folder = h('input', { value: 'Music/bootleg', 'aria-label': 'Folder on the card', title: 'bootleg’s music goes in this folder on the card' });
    return h('div', { class: 'lib-head' }, name, mode, folder,
      h('button', { class: 'btn primary', onclick: async () => {
        try { const n = await invoke('device_pair', { volume: m.volume, name: name.value || m.label, mode: mode.value, root: folder.value, kind: null }); remember(n); toast(`Paired ${n.name}`); refresh(); }
        catch (e) { toast(String(e.message || e), true); }
      } }, 'Pair'));
  }

  function planBox(m) {
    const s = st(m.volume), p = s.plan;
    if (s.busy && !s.progress) return h('div', { class: 'muted small' }, s.busy);
    if (s.progress) return h('div', { class: 'dv-prog', 'data-vol': m.volume }, h('div', { class: 'pbar' }, h('i', { style: `width:${s.progress.done / Math.max(1, s.progress.total) * 100}%` })), h('span', { class: 'small muted' }, s.progress.what), h('button', { class: 'link', onclick: () => invoke('device_cancel') }, 'stop'));
    const out = [];
    if (s.msg) out.push(h('pre', { class: 'err' }, s.msg));
    if (!p) return out.length ? h('div', {}, ...out) : '';
    const parts = [`${plural(p.copy, 'file')} to copy (${human(p.bytes_in)})`, p.delete ? `${p.delete} of bootleg’s files to remove (${human(p.bytes_freed)} freed)` : '', p.playlists ? plural(p.playlists, 'playlist') : '', `${p.unchanged} already there`, p.kept_unselected ? `${p.kept_unselected} no longer chosen but kept (Add mode never deletes)` : ''].filter(Boolean);
    out.push(h('div', { class: p.short_by ? 'err' : 'small' }, p.short_by ? `Doesn’t fit: ${human(p.short_by)} short. Mirror copies all or nothing; choose less, free space, or use Fill.` : parts.join(' · ')));
    if (s.confirm) out.push(h('div', { class: 'dv-confirm' }, h('span', {}, `This removes ${plural(p.delete, 'file')} bootleg put on the card. Files you put there yourself are never touched.`), h('button', { class: 'btn primary', onclick: () => sync(m) }, 'Remove and sync'), h('button', { class: 'btn', onclick: () => { s.confirm = false; s.plan = null; paint(); } }, 'Cancel')));
    if (p.renamed.length) out.push(h('div', { class: 'small muted' }, `${plural(p.renamed.length, 'track')} got a “(bootleg)” name because a file of yours already has that name.`));
    if (p.skipped.length) out.push(h('details', { class: 'small' }, h('summary', {}, `${p.skipped.length} left out`), h('ul', {}, ...p.skipped.slice(0, 300).map(x => h('li', {}, h('b', {}, x.title || x.track), ' — ', x.why)))));
    if (p.preview.length) out.push(h('details', { class: 'small' }, h('summary', {}, 'What changes on the card'), h('pre', { class: 'dv-preview' }, p.preview.join('\n') + (p.copy + p.delete + p.playlists > p.preview.length ? '\n…' : ''))));
    return h('div', { class: 'dv-plan' }, ...out);
  }

  function pairedCard(m, playlists) {
    const s = st(m.volume), sel = m.select || {};
    const player = m.players?.length ? m.players.map(p => `${p.name || p.id}${p.app ? ` (${p.app})` : ''}, ${ago(p.last_seen)}`).join('; ') : 'No player has reported in. bootleg-pod does; other players work without it.';
    const plBoxes = playlists.length ? h('div', { class: 'dv-pls' }, ...playlists.map(p => h('label', {}, h('input', { type: 'checkbox', checked: m.playlists.includes(p.name), onchange: e => set(m, { playlists: e.target.checked ? [...m.playlists, p.name] : m.playlists.filter(x => x !== p.name) }) }), ' ', p.name))) : h('span', { class: 'muted small' }, 'No playlists yet (Playlists → save the queue).');
    return h('div', { class: 'lib-card dv-card' + (m.error ? ' bad' : '') },
      h('div', { class: 'lib-head' }, h('input', { value: m.name, 'aria-label': 'Name', onchange: e => set(m, { name: e.target.value }) }), h('span', { class: 'chip' }, m.kind), h('span', { class: 'muted small' }, m.volume), h('span', { class: 'grow' }), h('span', { class: 'small muted' }, `${human(m.free)} free · bootleg: ${plural(m.files, 'file')} (${human(m.bytes)}) · synced ${ago(m.last_sync)}`)),
      bar(m),
      m.error ? h('div', { class: 'err' }, m.error) : '',
      m.recovered ? h('div', { class: 'small muted' }, m.recovered) : '',
      h('div', { class: 'small muted' }, 'Player: ', player),
      row('Mode', MODES[m.mode]?.hint, h('select', { onchange: e => set(m, { mode: e.target.value }) }, ...Object.entries(MODES).map(([k, x]) => h('option', { value: k, selected: k === m.mode }, x.label)))),
      row('Playlists', 'Copied in this order, first ones first when space runs out. Each is also written to the card as an .m3u8.', plBoxes),
      row('Also rated', 'Every track with at least this rating.', h('select', { onchange: e => set(m, { select: { ...sel, min_rating: +e.target.value } }) }, ...Object.entries(RATINGS).map(([k, l]) => h('option', { value: k, selected: +k === (+sel.min_rating || 0) }, l)))),
      row('Also starred', 'Tracks tagged “starred” (a server’s favourites).', h('input', { type: 'checkbox', checked: !!sel.starred, onchange: e => set(m, { select: { ...sel, starred: e.target.checked } }) })),
      row('Stems', 'Stem sets go as their mix and details by default (a few MB). With this on, their stems go too.', h('input', { type: 'checkbox', checked: m.stems, onchange: e => set(m, { stems: e.target.checked }) })),
      row('Keep free', 'Space to leave on the card (e.g. 2GB). Fill and Add stop there.', h('input', { value: m.keep_free, placeholder: '0', style: 'width:90px', onchange: e => set(m, { keep_free: e.target.value }) })),
      m.outbox ? h('div', { class: 'dv-out' }, h('span', {}, `${m.outbox.toLocaleString()} ${m.outbox === 1 ? 'play, rating or note' : 'plays, ratings and notes'} from the player waiting.`), h('button', { class: 'btn', onclick: async () => { await bringBack(m).catch(e => toast(String(e), true)); refresh(); } }, 'Bring them in')) : '',
      h('div', { class: 'cbtns' },
        h('button', { class: 'btn', disabled: !!s.busy, onclick: () => check(m) }, 'Check'),
        h('button', { class: 'btn primary', disabled: !!s.busy || !!m.error, onclick: () => sync(m) }, 'Sync'),
        h('span', { class: 'grow' }),
        s.unpair ? h('span', { class: 'dv-confirm' }, 'Unpair? The music stays on the card as ordinary files.', h('button', { class: 'btn', onclick: async () => { try { await invoke('device_unpair', { volume: m.volume }); forget(m.id); toast(`Unpaired ${m.name}`); } catch (e) { toast(String(e), true); } s.unpair = false; refresh(); } }, 'Unpair'), h('button', { class: 'link', onclick: () => { s.unpair = false; paint(); } }, 'cancel'))
          : h('button', { class: 'link', onclick: () => { s.unpair = true; paint(); } }, 'Unpair…')),
      planBox(m));
  }

  function paintProgress(volume) {
    const el = root.querySelector(`.dv-prog[data-vol="${CSS.escape(volume)}"]`), p = st(volume).progress; if (!el || !p) return paint();
    el.querySelector('i').style.width = (p.done / Math.max(1, p.total) * 100) + '%'; el.querySelector('span').textContent = p.what;
  }

  async function paint() {
    if (root.hidden) return;
    if (!invoke) { root.replaceChildren(h('div', { class: 'empty' }, h('b', {}, 'Players and SD cards'), h('br'), 'Syncing to players needs the bootleg desktop app.')); return; }
    const playlists = await notes.playlists();
    const paired = media.filter(m => m.paired), others = media.filter(m => !m.paired);
    const away = Object.values(known()).filter(k => !paired.some(m => m.id === k.id));
    root.replaceChildren(h('div', { class: 'settings devices' },
      h('div', { class: 'lib-head' }, h('h3', { class: 'grow' }, 'Players and SD cards'), h('button', { class: 'btn', onclick: refresh }, loading ? 'Looking…' : 'Refresh'),
        h('button', { class: 'btn', title: 'Pair a folder that isn’t listed (a player mounted somewhere else)', onclick: async () => { const d = await T.dialog.open({ directory: true, title: 'The player’s or card’s folder' }); if (!d) return; media.push({ volume: d, label: d.split(/[\\/]/).pop(), paired: false }); paint(); } }, 'Use a folder…')),
      h('div', { class: 'muted small' }, 'bootleg only ever replaces or removes files it put on a card itself (it keeps a list in a hidden .bootleg folder there). Your own files are never touched.'),
      ...paired.map(m => pairedCard(m, playlists)),
      others.length ? h('h3', {}, 'Not paired') : '',
      ...others.map(m => h('div', { class: 'lib-card' }, h('div', { class: 'lib-head' }, h('b', {}, m.label), h('span', { class: 'muted small' }, m.volume), h('span', { class: 'grow' }), h('span', { class: 'small muted' }, `${human(m.free)} free of ${human(m.total)}${m.fat32 ? ' · FAT32' : ''}`)), h('div', { class: 'muted small' }, 'Pairing writes only a .bootleg folder on it.'), pairForm(m))),
      away.length ? h('h3', {}, 'Paired, not connected') : '',
      ...away.map(k => h('div', { class: 'srow' }, h('span', {}, h('b', {}, k.name), h('small', {}, `Last seen ${new Date(k.lastSeen).toLocaleString()}${k.player ? ` in ${k.player}` : ''} at ${k.volume}`)), h('button', { class: 'link', onclick: () => { forget(k.id); paint(); } }, 'forget'))),
      !media.length && !away.length ? h('div', { class: 'empty' }, h('b', {}, 'No cards or players found.'), h('br'), 'Connect a player or put in an SD card, then press Refresh.') : ''));
  }

  return {
    shown() { paint(); refresh(); clearInterval(timer); timer = setInterval(() => { if (root.hidden) clearInterval(timer); else if (![...state.values()].some(s => s.busy)) refresh(); }, 15000); },
    refresh,
  };
}
