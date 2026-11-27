import { relFor, filesFor, selectionFor, hasSelection, mergeOutbox, notesFor } from '../src/lib/devices.js';
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
t('files: each track once, packages skipped with why, server tracks listed to fetch', f.files.filter(x => x.track === keyOf(a)).length === 1 && f.skipped.length === 1 && f.skipped.every(s => s.why) && f.remote.length === 1 && f.remote[0].src === remote.src);
const rem2 = { id: 't5', kind: 'track', title: 'Song', artist: 'Ann', album: 'LP', track: 2, src: { kind: 'remote', name: 'Song.flac', path: 'subsonic:c/9' } };
const fl = filesFor([rem2], { keyOf, localOf: s => s.path === 'subsonic:c/9' ? '/offline/files/9-abc.mp3' : null });
t('a server track with a local copy goes from the copy, named by its tags with the copy\'s format', fl.remote.length === 0 && fl.files[0].path === '/offline/files/9-abc.mp3' && fl.files[0].rel === 'Ann/LP/02 Song.mp3', JSON.stringify(fl.files[0]));
const srv = { id: 'r9', kind: 'render', title: 'Night', artist: '', dir: 'stemserver:c/u1', mix: { kind: 'remote', name: 'mix.flac', path: 'stemserver:c/u1/mix.flac' }, manifestSrc: { kind: 'remote', name: 'manifest.json', path: 'stemserver:c/u1/manifest.json' }, stems: [] };
const fs1 = filesFor([srv], { keyOf }), fs2 = filesFor([srv], { keyOf, localOf: s => '/o/' + s.name });
t('a stem server song: its mix and manifest are fetched, then go as a stem set', fs1.remote.length === 2 && fs1.files.length === 0 && fs2.files.map(x => x.rel).join() === 'Stem sets/Night/mix.flac,Stem sets/Night/manifest.json' && fs2.files[0].track === 'render:stemserver:c/u1');
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
t('tracks a playlist names but the library lacks are reported, not dropped silently', s.missing.length === 1 && s.missing[0].track === 'file:gone#1' && /Road/.test(s.missing[0].why) && s.missing[0].title === 'gone');
t('a chosen playlist that no longer exists is reported', selectionFor({ playlists: ['Nope'] }, { playlists, byKey, records }).missing[0]?.why.includes('no playlist'));
t('hasSelection: playlists, rating or starred', !hasSelection({ playlists: [], select: {} }) && hasSelection({ playlists: ['Road'] }) && hasSelection({ playlists: [], select: { min_rating: 4 } }) && hasSelection({ select: { starred: true } }));

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
