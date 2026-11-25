// Notes, ratings, provenance, playlists and import/export — the cataloguing side of the player.
import { parseNfo, buildAlbumNfo, nfoRatingToStars } from './nfo.js';
import { MODES, STATUSES } from './libraries.js';
import { albumKey } from './album-details.js';
import { NotesStore, IdbBackend, MemoryBackend, PROVENANCE_KINDS, toM3U, parseM3U, matchEntries } from './notes.js';

export const trackKey = t => !t ? null : t.kind === 'render' ? 'render:' + t.dir : 'file:' + (t.src?.path || t.title) + '#' + (t.src?.size ?? '');
const KIND_LABEL = { 'vinyl-rip': 'Vinyl rip', 'cd-rip': 'CD rip (retail)', 'mix-cd-rip': 'Mix CD rip', 'live-recording': 'Live recording', 'digital-purchase': 'Digital purchase', streaming: 'Streaming', 'studio-recording': 'Studio recording', mixdown: 'Mixdown', demo: 'Demo', rehearsal: 'Rehearsal', 'stem-render': 'Stem render', other: 'Other' };

export function stars(h, value, onset) {
  const el = h('span', { class: 'stars', role: 'group', 'aria-label': `Rating ${value || 'none'}` });
  for (let i = 1; i <= 5; i++) {
    const full = value >= i, half = !full && value >= i - 0.5;
    el.append(h('button', { class: 'star' + (full ? ' full' : half ? ' half' : ''), title: `${i} stars (left half = ${i - 0.5})`, 'aria-label': `${i} stars`, onclick: e => { const r = e.currentTarget.getBoundingClientRect(), v = e.clientX - r.left < r.width / 2 ? i - 0.5 : i; onset(v === value ? 0 : v); } }, '★'));
  }
  return el;
}

export function initNotes({ backend: given, player, lib, libs, h, fmt, toast, show, saveText, $ }) {
  const drafts = new Map(); let backend = given; if (!backend) try { backend = new IdbBackend(); } catch { backend = new MemoryBackend(); }
  const store = new NotesStore(backend); let cur = null, curKey = null, rangeFrom = null;
  libs.onchange = () => paint(); $('#notesPanel').addEventListener('focusout', () => setTimeout(() => { if (pendingPaint) paint(); }, 0));
  const refresh = async () => { curKey = trackKey(player.item); cur = curKey ? await store.get(curKey) : null; paint(); paintMarks(); paintBarStars(); };
  store.addEventListener('change', () => { refresh(); paintLists(); });
  player.addEventListener('change', () => { if (trackKey(player.item) !== curKey) { rangeFrom = null; refresh(); } else paintMarks(); });

  // ---- player bar stars
  const paintBarStars = () => { const el = $('#npStars'); el.replaceChildren(cur ? stars(h, cur.rating, v => store.setRating(curKey, v)) : ''); };

  // ---- markers on the seek bar
  function paintMarks() {
    const m = $('#marks'), d = player.dur(); m.replaceChildren(); if (!cur || !d) return;
    for (const n of cur.notes.filter(n => n.at != null)) {
      const left = Math.min(100, n.at / d * 100), el = h('button', { class: 'mark' + (n.to != null ? ' range' : ''), title: `${fmt(n.at)}${n.to != null ? '–' + fmt(n.to) : ''}  ${n.text}`, onclick: () => player.seek(n.at) });
      el.style.left = left + '%'; if (n.to != null) el.style.width = Math.max(0.4, (n.to - n.at) / d * 100) + '%'; m.append(el);
    }
  }
  let lastDur = 0; (function watch() { const d = player.dur(); if (d !== lastDur) { lastDur = d; paintMarks(); } requestAnimationFrame(watch); })();

  // ---- the panel under the visualizer
  const prov = () => cur?.provenance || { kind: 'other', date: '', device: '', venue: '', source: '', note: '' };
  let pendingPaint = false;
  function paint() {
    const p = $('#notesPanel'); if (!cur) { p.hidden = true; return; }
    // never rebuild the form under someone who is typing in it: wait until the field loses focus
    const ae = document.activeElement; if (!p.hidden && p.contains(ae) && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) { pendingPaint = true; return; }
    pendingPaint = false; p.hidden = false; const it = player.item, pv = prov(), mode = MODES[libs.modeOf(it)], provKinds = [...new Set([...mode.provenance, pv.kind])];
    const field = (k, label, ph, type = 'text') => h('label', { class: 'f' }, h('span', {}, label), h('input', { type, value: pv[k] || '', placeholder: ph, onchange: e => store.patchProvenance(curKey, { [k]: e.target.value }) }));
    const ta = h('textarea', { id: 'noteText', rows: 2, placeholder: 'A note about this moment, or the whole recording…  (Cmd/Ctrl+Enter to add)' });
    const kindSel = h('select', { id: 'noteKind', title: 'What kind of note' }, ...mode.noteKinds.map(([k, l]) => h('option', { value: k }, l)));
    const d = drafts.get(curKey) || { text: '', kind: '' };      // an unsent note survives the panel repainting after a rating/status/tag change
    ta.value = d.text; if (d.kind && mode.noteKinds.some(k => k[0] === d.kind)) kindSel.value = d.kind; ta.oninput = () => drafts.set(curKey, { text: ta.value, kind: kindSel.value }); kindSel.onchange = () => drafts.set(curKey, { text: ta.value, kind: kindSel.value });
    const add = async (at, to) => { const text = ta.value.trim(); if (!text) { ta.focus(); return; } drafts.delete(curKey); await store.addNote(curKey, { text, at, to, kind: kindSel.value }); ta.value = ''; rangeFrom = null; };
    ta.onkeydown = e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') add(player.pos()); };
    const list = [...cur.notes].sort((a, b) => (a.at ?? -1) - (b.at ?? -1) || a.created - b.created).map(n => noteRow(n));
    p.replaceChildren(
      h('h4', {}, 'Notes — ', h('span', { class: 'muted' }, it.title), h('span', { class: 'chip' }, mode.label + ' library')),
      h('div', { class: 'np-top' },
        h('div', {}, h('div', { class: 'lbl' }, 'Rating'), stars(h, cur.rating, v => store.setRating(curKey, v))),
        mode.status ? h('label', { class: 'f' }, h('span', {}, 'Status'), h('select', { onchange: e => store.setStatus(curKey, e.target.value) }, h('option', { value: '' }, '—'), ...STATUSES.map(x => h('option', { value: x, selected: x === cur.status }, x)))) : '',
        h('label', { class: 'f grow' }, h('span', {}, 'Tags (comma separated)'), h('input', { value: cur.tags.join(', '), placeholder: 'live, favorite, to-clean…', onchange: e => store.setTags(curKey, e.target.value.split(',')) }))),
      h('details', { class: 'prov', open: !!cur.provenance }, h('summary', {}, (mode.status ? 'How this was recorded / where it came from' : 'Where this recording came from')),
        h('div', { class: 'provgrid' },
          h('label', { class: 'f' }, h('span', {}, 'Kind'), h('select', { onchange: e => store.patchProvenance(curKey, { kind: e.target.value }) }, ...provKinds.map(k => h('option', { value: k, selected: k === pv.kind }, KIND_LABEL[k] || k)))),
          field('date', 'Date', '', 'date'), field('device', 'Device / gear', 'Technics SL-1200 → Audient iD14'), field('venue', 'Venue / place', 'Where it was recorded or bought'), field('source', 'Source', 'Disc, seller, mix-CD title, URL…'), field('note', 'Notes on the transfer', 'cleaned stylus, azimuth fixed…'))),
      nfoBlock(it),
      h('div', { class: 'composer' }, ta,
        h('div', { class: 'cbtns' }, kindSel,
          h('button', { class: 'btn primary', onclick: () => add(player.pos()) }, `Add at ${fmt(player.pos())}`),
          h('button', { class: 'btn', title: 'Mark a section: click once to start, again to end', onclick: () => { if (rangeFrom == null) { rangeFrom = player.pos(); toast(`Range starts at ${fmt(rangeFrom)} — click again to end it`); e2(); } else { const a = Math.min(rangeFrom, player.pos()), b = Math.max(rangeFrom, player.pos()); add(a, b); } } }, rangeFrom == null ? 'Mark a range' : `Range from ${fmt(rangeFrom)} — end here`),
          h('button', { class: 'btn', onclick: () => add(null, null) }, 'Add to whole recording'))),
      h('div', { class: 'notelist' }, list.length ? list : h('div', { class: 'muted small' }, 'No notes yet. Notes with a time appear as markers on the seek bar.')));
    function e2() { paint(); }
  }
  // ---- .nfo: show what the folder's NFO files say, import it as notes, or write an album.nfo from what we know
  const dirOf = p => p.slice(0, Math.max(0, p.lastIndexOf('/')));
  function nfoBlock(it) {
    const n = it.nfo, parts = [];
    if (n) {
      const a = n.album, r = n.artist;
      if (a?.text) parts.push(h('div', {}, h('div', { class: 'lbl' }, `Album — ${a.path.split('/').pop()}`), h('div', { class: 'nfotext' }, a.text)));
      if (r?.text) parts.push(h('div', {}, h('div', { class: 'lbl' }, `Artist — ${r.path.split('/').pop()}`), h('div', { class: 'nfotext' }, r.text)));
      for (const t of n.texts) parts.push(h('div', {}, h('div', { class: 'lbl' }, t.path.split('/').pop()), h('div', { class: 'nfotext mono' }, t.text)));
    }
    const sibs = () => lib.tracks.filter(t => dirOf(t.src.path) === dirOf(it.src.path)).sort((x, y) => (x.disc - y.disc) || (x.track - y.track) || x.title.localeCompare(y.title));
    const importIt = async () => { let c = 0; for (const x of [n.album?.text, n.artist?.text, ...n.texts.map(t => t.text)].filter(Boolean)) { await store.addNote(curKey, { text: x, kind: 'nfo' }); c++; } if (n.album?.rating && !cur.rating) await store.setRating(curKey, nfoRatingToStars(n.album.rating)); toast(`Imported ${c} note(s) from .nfo`); };
    const exportIt = () => { const whole = cur.notes.filter(x => x.at == null).map(x => x.text).join('\n\n'); saveText('album.nfo', buildAlbumNfo({ album: it.album || dirOf(it.src.path).split('/').pop(), artist: it.albumArtist || it.artist, year: it.year, genres: (it.genre || '').split(/\s*,\s*/).filter(Boolean), rating: cur.rating, review: whole || n?.album?.text, tracks: sibs().map(t => ({ position: t.track || undefined, title: t.title, duration: t.duration ? fmt(t.duration) : '' })) }), 'text/xml', it.kind === 'track' && it.src.kind === 'tauri' ? dirOf(it.src.path) + '/album.nfo' : null); };
    return h('div', { class: 'nfo' }, ...parts, h('div', { class: 'cbtns' }, n && parts.length ? h('button', { class: 'btn', onclick: importIt }, 'Import .nfo text as notes') : '', it.kind === 'track' ? h('button', { class: 'btn', title: 'Writes a Kodi-style album.nfo with this album, its rating and your whole-recording notes', onclick: exportIt }, 'Save album.nfo…') : ''));
  }
  function noteRow(n) {
    const row = h('div', { class: 'note' });
    const view = () => row.replaceChildren(
      n.at != null ? h('button', { class: 'chip time', title: 'Jump here', onclick: () => player.seek(n.at) }, fmt(n.at) + (n.to != null ? '–' + fmt(n.to) : '')) : h('span', { class: 'chip' }, 'whole'),
      n.kind && n.kind !== 'note' ? h('span', { class: 'chip kind' }, n.kind) : '', h('span', { class: 'ntext' }, n.text),
      h('span', { class: 'nacts' }, h('button', { class: 'mini', onclick: edit }, 'edit'), h('button', { class: 'mini', onclick: () => store.removeNote(curKey, n.id) }, '✕')));
    const edit = () => { const i = h('textarea', { rows: 2 }, n.text); i.value = n.text; row.replaceChildren(i, h('button', { class: 'mini', onclick: () => store.editNote(curKey, n.id, { text: i.value.trim() || n.text }) }, 'save'), h('button', { class: 'mini', onclick: view }, 'cancel')); i.focus(); };
    view(); return row;
  }
  $('#markHere').onclick = () => { if (!cur) { toast('Play something first'); return; } show('now'); setTimeout(() => $('#noteText')?.focus(), 50); };

  // ---- Notes browser: everything annotated, across the library
  const byKey = () => { const m = new Map(); for (const t of [...lib.tracks, ...lib.renders]) m.set(trackKey(t), t); for (const a of lib.albums()) m.set(albumKey(a), { title: a.album, artist: a.artist, album: 'album', tracks: a.tracks, isAlbum: true }); return m; };
  async function paintLists() {
    if ($('#view-notes').hidden && $('#view-playlists').hidden) return;       // repainted when those views open (keeps big libraries cheap)
    const q = $('#noteSearch').value, minR = +$('#noteMin').value, tag = $('#noteTag').value, status = $('#noteStatus').value, recs = await store.find({ minRating: minR, text: q || undefined, tag: tag || undefined, status: status || undefined }), keys = byKey();
    const tags = await store.allTags(), tsel = $('#noteTag'); if (tsel.options.length !== tags.length + 1 || [...tsel.options].slice(1).some((o, i) => o.value !== tags[i][0])) { tsel.replaceChildren(h('option', { value: '' }, 'any tag'), ...tags.map(([g, n]) => h('option', { value: g, selected: g === tag }, `${g} (${n})`))); }
    const rows = recs.filter(r => r.rating || r.status || r.tags.length || r.notes.length || r.provenance).sort((a, b) => b.updated - a.updated).map(r => {
      const t = keys.get(r.key), pv = r.provenance;
      return h('div', { class: 'ncard' },
        h('div', { class: 'nc-head' }, h('b', {}, t ? t.title : r.key.replace(/^file:|^album:|#\d*$/g, '')), r.key.startsWith('album:') ? h('span', { class: 'chip' }, 'album') : '', h('span', { class: 'muted' }, t ? [t.artist, t.album].filter(Boolean).join(' · ') : 'not in the current library'), r.rating ? stars(h, r.rating, v => store.setRating(r.key, v)) : '', t ? h('button', { class: 'mini', onclick: () => player.playList(t.isAlbum ? t.tracks : [t], 0) }, '▶ play') : ''),
        pv ? h('div', { class: 'nc-prov' }, h('span', { class: 'chip' }, KIND_LABEL[pv.kind] || pv.kind), ' ', [pv.date, pv.device, pv.venue, pv.source].filter(Boolean).join(' · '), pv.note ? ' — ' + pv.note : '') : '',
        r.tags.length || r.status ? h('div', {}, r.status ? h('span', { class: 'chip status' }, r.status) : '', ...r.tags.map(x => h('button', { class: 'chip tag', title: 'Filter by this tag', onclick: () => { $('#noteTag').value = x; paintLists(); } }, '#' + x))) : '',
        ...r.notes.slice(0, 4).map(n => h('div', { class: 'nc-note' }, h('span', { class: 'chip' }, n.at != null ? fmt(n.at) : 'whole'), ' ', n.text)), r.notes.length > 4 ? h('div', { class: 'muted small' }, `+ ${r.notes.length - 4} more`) : '');
    });
    $('#noteCards').replaceChildren(...rows); $('#emptyNotes').hidden = rows.length > 0;
    const pls = await store.playlists(); $('#plList').replaceChildren(...pls.map(p => h('div', { class: 'ncard' }, h('div', { class: 'nc-head' }, h('b', {}, p.name), h('span', { class: 'muted' }, `${p.items.length} tracks`),
      h('button', { class: 'mini', onclick: () => playPlaylist(p) }, '▶ play'), h('button', { class: 'mini', onclick: () => exportM3U(p) }, 'export M3U'), h('button', { class: 'mini', onclick: () => store.deletePlaylist(p.id).then(paintLists) }, 'delete')))));
    $('#emptyPl').hidden = pls.length > 0;
  }
  $('#noteSearch').oninput = paintLists; $('#noteMin').onchange = paintLists; $('#noteTag').onchange = paintLists; $('#noteStatus').onchange = paintLists;

  // ---- playlists
  const resolve = p => { const m = byKey(); return p.items.map(k => m.get(k)).filter(Boolean); };
  async function playPlaylist(p) { const ts = resolve(p); if (!ts.length) { toast('None of this playlist’s tracks are in the library right now', true); return; } if (ts.length < p.items.length) toast(`${p.items.length - ts.length} track(s) not in the library`); player.playList(ts, 0); }
  const m3uTrack = t => ({ title: t.title, artist: t.artist, album: t.album, duration: t.duration, path: t.src?.path || t.title });
  const exportM3U = p => saveText(p.name.replace(/[^\w .-]+/g, '_') + '.m3u8', toM3U(p.name, resolve(p).map(m3uTrack)), 'audio/x-mpegurl');
  $('#plSave').onclick = async () => { const name = $('#plName').value.trim() || 'Playlist ' + new Date().toLocaleDateString(); if (!player.queue.length) { toast('The queue is empty — add some tracks first', true); return; } await store.savePlaylist({ name, items: player.queue.map(trackKey) }); $('#plName').value = ''; toast(`Saved “${name}”`); };
  $('#plImport').onclick = () => $('#m3uIn').click();
  $('#m3uIn').onchange = async e => { for (const f of e.target.files) { const { name, items } = parseM3U(await f.text()), m = matchEntries(items, lib.tracks), hit = m.filter(x => x.track); await store.savePlaylist({ name: name || f.name.replace(/\.[^.]+$/, ''), items: hit.map(x => trackKey(x.track)) }); toast(`Imported “${name || f.name}”: ${hit.length} of ${items.length} matched the library`, hit.length === 0); } e.target.value = ''; };

  // ---- notes export / import (everything: notes, ratings, provenance, playlists)
  $('#notesExport').onclick = async () => { const doc = await store.export(); await saveText(`bootleg-notes-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(doc, null, 2), 'application/json'); };
  $('#notesImport').onclick = () => $('#notesIn').click();
  $('#notesIn').onchange = async e => { const f = e.target.files[0]; e.target.value = ''; if (!f) return; try { const r = await store.import(JSON.parse(await f.text())); toast(`Imported: ${r.added} new, ${r.merged} merged, ${r.playlists} playlists`); } catch (err) { toast('Could not import: ' + err.message, true); } };

  refresh(); paintLists();
  return { store, paintLists, refresh };
}
