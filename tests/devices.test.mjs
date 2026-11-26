import { relFor, filesFor, selectionFor, mergeOutbox, notesFor } from '../src/lib/devices.js';
import { NotesStore } from '../src/lib/notes.js';
let bad = 0; const t = (n, ok, note = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${note ? '   ' + note : ''}`); if (!ok) bad++; };
const keyOf = x => x.kind === 'render' ? 'render:' + x.dir : 'file:' + x.src.path + '#' + x.src.size;

const a = { id: 't1', kind: 'track', title: 'Tomorrow One', artist: 'Low', albumArtist: '', album: 'Things', track: 1, disc: 1, src: { kind: 'tauri', path: '/m/Low/01.flac', size: 10 } };
const b = { id: 't2', kind: 'track', title: 'B', artist: 'X', album: 'Y', track: 3, disc: 2, src: { kind: 'tauri', path: '/m/x.mp3', size: 5 } };
const untagged = { id: 't3', kind: 'track', title: 'raw', artist: '', album: '', src: { kind: 'tauri', path: '/m/in/raw take.wav', size: 1 } };
const remote = { id: 't4', kind: 'track', title: 'R', src: { kind: 'remote', path: 'subsonic:1/2' } };
const render = { id: 'r1', kind: 'render', title: 'Night', artist: 'gm', dir: '/r/night', manifestSrc: { path: '/r/night/manifest.json' }, coverSrc: { path: '/r/night/cover.jpg' }, mix: { path: '/r/night/mix.flac' }, stems: [{ name: 'kick', src: { path: '/r/night/stems/kick.flac' } }] };
const pkg = { id: 'r2', kind: 'render', title: 'P', dir: '/r/p.bstem', pkgSrc: { path: '/r/p.bstem' } };

t('track path from tags', relFor(a) === 'Low/Things/01 Tomorrow One.flac', relFor(a));
t('second disc gets a disc prefix', relFor(b) === 'X/Y/2-03 B.mp3', relFor(b));
t('untagged keeps its file name', relFor(untagged) === 'Unsorted/raw take.wav');

const f = filesFor([a, remote, render, pkg, a], { keyOf });
t('files: each track once, remote and packages skipped with why', f.files.filter(x => x.track === keyOf(a)).length === 1 && f.skipped.length === 2 && f.skipped.every(s => s.why));
const rf = f.files.filter(x => x.track.startsWith('render:'));
t('stem set goes as mix + metadata, mix carries the set key', rf[0].track === 'render:/r/night' && rf[0].rel === 'Stem sets/gm - Night/mix.flac' && rf.some(x => x.rel.endsWith('/manifest.json')) && rf.some(x => x.rel.endsWith('/cover.jpg')) && !rf.some(x => x.rel.includes('/stems/')));
t('stems only when the card asks for them', filesFor([render], { keyOf, stems: true }).files.some(x => x.rel === 'Stem sets/gm - Night/stems/kick.flac'));

const byKey = new Map([a, b, untagged, render].map(x => [keyOf(x), x]));
const playlists = [{ name: 'Road', items: [keyOf(b), keyOf(a), 'file:gone#1'] }, { name: 'Other', items: [keyOf(untagged)] }];
const records = [{ key: keyOf(render), rating: 5, tags: [] }, { key: keyOf(untagged), rating: 2, tags: ['starred'] }, { key: keyOf(a), rating: 5, tags: [] }];
const s = selectionFor({ playlists: ['Road'], select: { min_rating: 4.5 } }, { playlists, byKey, records });
t('selection: playlists first, then rated, no duplicates', s.tracks.map(x => x.id).join() === 't2,t1,r1', s.tracks.map(x => x.id).join());
t('playlists on the card keep their order and drop missing tracks', s.playlists.length === 1 && s.playlists[0].items.map(x => x.id).join() === 't2,t1');
t('starred adds tagged tracks', selectionFor({ select: { starred: true } }, { playlists, byKey, records }).tracks.map(x => x.id).join() === 't3');
t('no selection, nothing', selectionFor({}, { playlists, byKey, records }).tracks.length === 0);

const store = new NotesStore(), k = keyOf(a);
await store.setRating(k, 3);
const before = (await store.get(k)).updated;
const files = [{ file: 'x', events: [
  { ts: before - 1000, track: k, type: 'rating', stars: 1 },
  { ts: before + 1000, track: k, type: 'rating', stars: 4.5 },
  { ts: before + 2000, track: k, type: 'note', text: 'crowd at 3:10', at: 190 },
  { ts: before + 2001, track: k, type: 'note', text: 'crowd at 3:10', at: 190 },
  { ts: before + 3000, track: k, type: 'tags', tags: ['road'] },
  { ts: before + 4000, track: k, type: 'play', seconds: 200, complete: true },
  { ts: before + 5000, track: 'file:Music/mine.mp3', type: 'rating', stars: 5 },
  { ts: before + 6000, track: k, type: 'brand-new-thing' },
] }];
const r = await mergeOutbox(store, files, { known: key => byKey.has(key) });
const rec = await store.get(k);
t('outbox: newer rating wins, older is ignored', rec.rating === 4.5 && r.ratings === 1 && r.older === 1, JSON.stringify(r));
t('outbox: a note is added once', rec.notes.length === 1 && rec.notes[0].at === 190 && r.notes === 1);
t('outbox: tags added, plays counted, unknown files not stored', rec.tags.includes('road') && r.plays === 1 && r.unknown === 1);
const doc = await notesFor(store, [k]);
t('notes.json holds only the card\'s tracks', doc.format === 'bootleg-notes' && doc.tracks.length === 1 && doc.tracks[0].key === k);

if (bad) { console.log(`\n${bad} failed`); process.exit(1); } else console.log('\nall devices tests passed');
