// Portable players and SD cards: what goes on a card, and what comes back from it. No UI and no Tauri here, so it is
// tested in Node; the card itself is only ever touched by the Rust side (src-tauri/src/devices.rs → vendor/bootleg-sync).
//
// A card's selection lives in its own .bootleg/device.toml (so it travels with the card): `playlists` (names) and
// `select` ({ min_rating, starred }). Stem sets go as their mix + metadata unless `stems` is on.

const META_FILES = ['manifest.json', 'clips.json', 'provenance.json', 'musicset.json'];
const ext = p => { const m = /\.([^./]+)$/.exec(p || ''); return m ? m[1].toLowerCase() : ''; };
const base = p => (p || '').split('/').pop();
const dir = p => (p || '').split('/').slice(0, -1).join('/');
const pad = n => String(n).padStart(2, '0');
const clean = s => String(s || '').trim();

/** Where a track goes under the card's managed folder: `Artist/Album/01 Title.ext` (disc > 1: `2-01 Title`). */
export function relFor(t) {
  const p = t.src?.path || '', x = ext(p);
  const artist = clean(t.albumArtist) || clean(t.artist), album = clean(t.album), title = clean(t.title);
  if (!artist && !album) return 'Unsorted/' + base(p);
  const n = t.track ? (t.disc > 1 ? `${t.disc}-` : '') + pad(t.track) + ' ' : '';
  return `${artist || 'Unknown artist'}/${album || 'Unknown album'}/${n}${title || base(p).replace(/\.[^.]+$/, '')}.${x}`;
}

/**
 * Library items → files for `device_plan`: [{ track, path, rel }], plus what can't go and why.
 * `keyOf` is the app's track key (notes-ui.js trackKey). The first file of each item carries the item's own key, so
 * playlists and the player's plays and ratings point at it.
 */
export function filesFor(tracks, { keyOf, stems = false }) {
  const files = [], skipped = [], seen = new Set();
  const add = (track, path, rel) => { if (!seen.has(track)) { seen.add(track); files.push({ track, path, rel }); } };
  for (const t of tracks) {
    const key = keyOf(t);
    if (t.src?.kind === 'remote') { skipped.push({ track: key, title: t.title, why: 'on a server, not on this computer' }); continue; }
    if (t.kind === 'render') {
      if (t.pkgSrc) { skipped.push({ track: key, title: t.title, why: 'stem packages (.bstem / .bsong) are not synced yet' }); continue; }
      const folder = `Stem sets/${clean(t.artist) ? clean(t.artist) + ' - ' : ''}${clean(t.title) || base(t.dir)}`;
      if (!t.mix?.path) { skipped.push({ track: key, title: t.title, why: 'no mix file (render one, or turn on stems for this card)' }); if (!stems) continue; }
      else add(key, t.mix.path, `${folder}/mix.${ext(t.mix.path)}`);
      const metaDir = t.manifestSrc?.path ? dir(t.manifestSrc.path) : t.dir;
      for (const f of META_FILES) if (t.manifestSrc?.path && dir(t.manifestSrc.path) === metaDir) add(`${key}|${f}`, `${metaDir}/${f}`, `${folder}/${f}`);
      if (t.coverSrc?.path) add(`${key}|cover`, t.coverSrc.path, `${folder}/${base(t.coverSrc.path)}`);
      if (stems) for (const s of t.stems || []) if (s.src?.path) add(`${key}|stem:${s.name}`, s.src.path, `${folder}/stems/${base(s.src.path)}`);
      continue;
    }
    if (!t.src?.path) { skipped.push({ track: key, title: t.title, why: 'not a file' }); continue; }
    add(key, t.src.path, relFor(t));
  }
  return { files, skipped };
}

/**
 * The tracks a card should hold, in priority order: its playlists first (in the order chosen), then the smart
 * selection (`select.min_rating`, `select.starred`). Returns the tracks and the playlists to write on the card.
 * `playlists`: the app's saved playlists ({ name, items: track keys }); `byKey`: track key → library item;
 * `records`: notes records ({ key, rating, tags }).
 */
export function selectionFor(medium, { playlists, byKey, records = [] }) {
  const out = [], have = new Set(), onCard = [];
  const take = t => { if (t && !have.has(t.id)) { have.add(t.id); out.push(t); } };
  for (const name of medium.playlists || []) {
    const pl = playlists.find(p => p.name === name); if (!pl) continue;
    const items = pl.items.map(k => byKey.get(typeof k === 'string' ? k : k?.key)).filter(Boolean);
    items.forEach(take); onCard.push({ name, items });
  }
  const sel = medium.select || {}, min = +sel.min_rating || 0;
  if (min || sel.starred) {
    for (const r of records) {
      if ((min && r.rating >= min) || (sel.starred && (r.tags || []).includes('starred'))) take(byKey.get(r.key));
    }
  }
  return { tracks: out, playlists: onCard };
}

/**
 * Merge a card's outbox (plays, ratings, notes, tags made on a player) into the notes store.
 * Ratings and tags apply only when newer than what bootleg has; notes are added once (same text at the same moment
 * is not added again). Keys bootleg doesn't know (files it did not put there) are counted, not stored.
 */
export async function mergeOutbox(store, files, { known = () => true } = {}) {
  const r = { plays: 0, ratings: 0, notes: 0, tags: 0, unknown: 0, older: 0 };
  const events = files.flatMap(f => f.events).sort((a, b) => a.ts - b.ts);
  for (const e of events) {
    const key = e.track;
    if (!key || !known(key)) { r.unknown++; continue; }
    const rec = await store.get(key);
    switch (e.type) {
      case 'play': case 'skip': r.plays++; break;
      case 'rating':
        if (e.ts > (rec.updated || 0)) { await store.setRating(key, +e.stars || 0); r.ratings++; } else r.older++;
        break;
      case 'tags':
        if (Array.isArray(e.tags)) { await store.setTags(key, [...(rec.tags || []), ...e.tags]); r.tags++; }
        break;
      case 'note': {
        const at = e.at ?? null, to = e.to ?? null, text = clean(e.text);
        if (!text || rec.notes.some(n => n.text === text && (n.at ?? null) === at)) break;
        await store.addNote(key, { text, at, to }); r.notes++; break;
      }
      default: break;   // newer event types: ignored, not lost (the card keeps them until acknowledged)
    }
  }
  return r;
}

/** bootleg-notes v1 for just the tracks on a card (for .bootleg/notes.json). */
export async function notesFor(store, keys) {
  const doc = await store.export(), want = new Set(keys);
  return { ...doc, tracks: doc.tracks.filter(t => want.has(t.key)), playlists: [] };
}

export function human(n) {
  if (n == null) return '?';
  return n >= 1e12 ? (n / 1e12).toFixed(2) + ' TB' : n >= 1e9 ? (n / 1e9).toFixed(2) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n >= 1e3 ? Math.round(n / 1e3) + ' KB' : n + ' B';
}

export const MODES = {
  add: { label: 'Add', hint: 'Copies new music in; never deletes anything.' },
  mirror: { label: 'Mirror', hint: 'The card holds exactly the selection; bootleg removes its own files you dropped. All or nothing.' },
  fill: { label: 'Fill', hint: 'Fills the card up to the space you allow, in order; rotates what was there before.' },
};
