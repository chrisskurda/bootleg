// The split view's right-hand pane: cover, merged details, album-level rating/tags/notes, review text, tracks.
import { albumFacts, albumKey } from './album-details.js';
import { MODES, STATUSES } from './libraries.js';
import { stars } from './notes-ui.js';
import { plural } from './controls.js';

const drafts = new Map();     // unsent note text survives the pane repainting after a rating/tag change
const SRC_LABEL = { tags: 'tags', nfo: '.nfo', server: 'server', files: 'files', library: 'library', bootleg: 'bootleg' };

export async function albumPane(a, { libs, lib, store, player, h, fmt, toast, cover, trackStore }) {
  const key = albumKey(a), rec = await store.get(key), mode = MODES[libs.modeOf(a.tracks[0])] || MODES.listening;
  const { facts, text } = albumFacts(a, { libraryName: id => libs.get(id)?.name || '' });
  const hms = s => { s = Math.round(s); const hh = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return hh ? `${hh} h ${m} min` : `${m} min`; };
  const ta = h('textarea', { rows: 2, id: 'albumNoteText', placeholder: 'A note about this album — what to remember, how it came to be…  (Cmd/Ctrl+Enter to add)' }), kind = h('select', { id: 'albumNoteKind' }, ...mode.noteKinds.map(([k, l]) => h('option', { value: k }, l)));
  ta.value = drafts.get(key) || ''; ta.oninput = () => drafts.set(key, ta.value);
  const add = async () => { const t = ta.value.trim(); if (!t) { ta.focus(); return; } drafts.delete(key); await store.addNote(key, { text: t, kind: kind.value }); };
  ta.onkeydown = e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') add(); };
  const rated = await Promise.all(a.tracks.map(t => trackStore(t)));

  return h('div', { class: 'apane' },
    h('div', { class: 'ahead' }, cover(a.coverUrl, 'cover xl'), h('div', { class: 'agrow' }, h('div', { class: 'big' }, a.album), h('div', { class: 'muted' }, [a.artist, facts.find(f => f.label === 'Year')?.value, plural(a.tracks.length, 'track'), a.tracks.some(t => t.duration) ? hms(a.tracks.reduce((n, t) => n + (t.duration || 0), 0)) : ''].filter(Boolean).join(' · ')),
      h('div', { class: 'arate' }, stars(h, rec.rating, v => store.setRating(key, v)), mode.status ? h('select', { 'aria-label': 'Status', onchange: e => store.setStatus(key, e.target.value) }, h('option', { value: '' }, 'status…'), ...STATUSES.map(x => h('option', { value: x, selected: x === rec.status }, x))) : ''),
      h('div', { class: 'cbtns' }, h('button', { class: 'btn primary', onclick: () => player.playList(a.tracks, 0) }, '▶ Play'), h('button', { class: 'btn', onclick: () => player.playList(a.tracks.slice().sort(() => Math.random() - 0.5), 0) }, 'Shuffle'), h('button', { class: 'btn', onclick: () => { player.enqueue(a.tracks); toast(`Queued ${plural(a.tracks.length, 'track')}`); } }, '+ Queue')))),
    h('h4', {}, 'Details ', h('span', { class: 'muted small' }, 'merged from everything we know — the chip says where each fact came from')),
    h('dl', { class: 'facts' }, ...facts.flatMap(f => [h('dt', {}, f.label), h('dd', {}, h('span', {}, f.value), h('span', { class: 'chip src' }, SRC_LABEL[f.source] || f.source))])),
    ...text.map(x => h('div', {}, h('h4', {}, x.label, ' ', h('span', { class: 'chip src' }, x.source)), h('div', { class: 'nfotext' }, x.text))),
    h('h4', {}, 'Your notes on this album'),
    h('label', { class: 'f' }, h('span', {}, 'Tags (comma separated — shared with every library)'), h('input', { value: rec.tags.join(', '), placeholder: 'live, favorite, to-clean…', onchange: e => store.setTags(key, e.target.value.split(',')) })),
    h('div', { class: 'composer' }, ta, h('div', { class: 'cbtns' }, kind, h('button', { class: 'btn primary', onclick: add }, 'Add note'))),
    h('div', { class: 'notelist' }, ...(rec.notes.length ? rec.notes.slice().sort((x, y) => x.created - y.created).map(n => h('div', { class: 'note' }, n.kind && n.kind !== 'note' ? h('span', { class: 'chip kind' }, n.kind) : '', h('span', { class: 'ntext' }, n.text), h('span', { class: 'nacts' }, h('button', { class: 'mini', onclick: () => store.removeNote(key, n.id) }, '✕')))) : [h('div', { class: 'muted small' }, 'No notes on the album yet. Notes on individual tracks live on the Now-playing panel.')])),
    h('h4', {}, 'Tracks'),
    h('div', { class: 'atracks' }, ...a.tracks.map((t, i) => h('div', { class: 'atrack' + (player.item?.id === t.id ? ' playing' : ''), ondblclick: () => player.playList(a.tracks, i) },
      h('span', { class: 'n' }, String(t.track || i + 1)), h('span', { class: 'tt' }, t.title, rated[i].rating ? h('span', { class: 'mini-stars' }, ' ' + '★'.repeat(Math.floor(rated[i].rating)) + (rated[i].rating % 1 ? '½' : '')) : ''), h('span', { class: 'muted' }, t.artist && t.artist !== a.artist ? t.artist : ''), h('span', { class: 'tm' }, t.duration ? fmt(t.duration) : ''),
      h('span', { class: 'acts' }, h('button', { class: 'mini', onclick: () => player.playList(a.tracks, i) }, '▶'), h('button', { class: 'mini', onclick: () => { player.enqueue([t]); toast('Added to queue'); } }, '+ queue'))))));
}
