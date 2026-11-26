// Edit tags in bootleg: one track (every field) or a whole album (the fields an album shares). Edits are stored with the
// notes and shown instead of what the file or server says — the files and the server are not touched. Each edited field
// shows what the source says and can be reverted on its own. Saving only stores what differs from the source.
import { EDIT_FIELDS } from './library.js';

const LABELS = { title: 'Title', artist: 'Artist', album: 'Album', albumArtist: 'Album artist', year: 'Year', track: 'Track', disc: 'Disc', genre: 'Genre' };
const ALBUM_FIELDS = ['album', 'albumArtist', 'artist', 'year', 'genre'];
const shown = v => (v == null || v === 0 ? '' : String(v));
const coerce = (k, v) => (k === 'track' || k === 'disc' ? (parseInt(v, 10) || 0) : v.trim());

export function openTagEditor(tracks, { h, store, keyOf, toast, title }) {
  tracks = tracks.filter(t => t && t.kind === 'track'); if (!tracks.length) return;
  const many = tracks.length > 1, fields = many ? ALBUM_FIELDS : EDIT_FIELDS, remote = tracks.some(t => t.remote);
  const source = (t, k) => shown(t.orig ? t.orig[k] : t[k]);                                 // what the file / server says
  const common = k => { const vs = new Set(tracks.map(t => shown(t[k]))); return vs.size === 1 ? [...vs][0] : null; };   // null: the tracks differ
  const rows = fields.map(k => {
    const now = common(k), edited = tracks.some(t => t.edited?.has(k)), srcs = new Set(tracks.map(t => source(t, k)));
    const input = h('input', { name: k, value: now ?? '', placeholder: now == null ? '(several values — leave empty to keep each)' : '', inputmode: k === 'track' || k === 'disc' || k === 'year' ? 'numeric' : 'text', autocomplete: 'off' });
    const row = { k, input, initial: now ?? '', mixed: now == null, revert: false };
    const note = edited ? h('small', { class: 'muted' }, remote ? 'server says: ' : 'file says: ', h('i', {}, srcs.size === 1 ? [...srcs][0] || '(empty)' : '(several)'), ' ',
      h('button', { type: 'button', class: 'link', onclick: () => { row.revert = true; input.value = srcs.size === 1 ? [...srcs][0] : ''; input.placeholder = ''; note.replaceChildren(h('small', { class: 'muted' }, 'will revert to the source')); } }, 'revert')) : '';
    row.el = h('label', { class: 'f' }, h('span', {}, LABELS[k]), input, note); return row;
  });
  const dlg = h('dialog', { class: 'tagdlg', 'aria-label': 'Edit tags' });
  const close = () => { dlg.close(); dlg.remove(); };
  const save = async () => {
    let n = 0;
    for (const t of tracks) {
      const patch = {};
      for (const r of rows) {
        const v = r.input.value; if (!r.revert && (v === r.initial || (r.mixed && v === ''))) continue;        // untouched
        const val = r.revert ? null : coerce(r.k, v); patch[r.k] = val == null || shown(val) === source(t, r.k) ? null : val;   // same as the source: no edit needed
      }
      if (Object.keys(patch).length) { await store.setEdits(keyOf(t), patch); n++; }
    }
    close(); if (n) toast(`Tags saved in bootleg for ${n === 1 ? '1 track' : n + ' tracks'}`);
  };
  dlg.append(h('form', { method: 'dialog', onsubmit: e => { e.preventDefault(); save().catch(err => toast(String(err.message || err), true)); } },
    h('h3', {}, title || (many ? `Edit album — ${tracks.length} tracks` : 'Edit tags')),
    h('div', { class: 'muted small' }, `Saved in bootleg only: ${remote ? 'the server' : 'the file'} keeps its own tags. Edited fields are marked ✎ and can be reverted here.`),
    h('div', { class: 'tagfields' }, ...rows.map(r => r.el)),
    h('div', { class: 'cbtns' }, h('button', { class: 'btn primary', type: 'submit' }, 'Save'), h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'))));
  dlg.addEventListener('cancel', () => dlg.remove());
  document.body.append(dlg); dlg.showModal(); rows[0].input.focus(); rows[0].input.select();
  return dlg;
}
