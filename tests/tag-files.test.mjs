// Writing tag edits to files: finding a server track's file on a share (by the server's path, wherever the share is
// mounted, else by exact size), refusing to guess, and what happens after a write (local: notes follow the new size and the
// edit is dropped; server: marked written, server asked to rescan, edit dropped once the server agrees).
import { TagFiles } from '../src/lib/tag-files.js';
import { NotesStore, MemoryBackend } from '../src/lib/notes.js';
let bad = 0; const t = (n, ok, note = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${note ? '   ' + note : ''}`); if (!ok) bad++; };

// the share as this Mac sees it: /Volumes/Data holds the server's music folder "music" (the server calls its paths "Artist/…")
const files = new Map([['/Volumes/Data/music/Band/Album/01 One.flac', 1000], ['/Volumes/Data/music/Band/Album/02 Two.flac', 2000], ['/Volumes/Data/music/Other/x.mp3', 3000],
  ['/Volumes/Data/music/Loose/renamed.flac', 4000], ['/Volumes/Data/music/Dupes/a.flac', 5000], ['/Volumes/Data/music/Dupes/b.flac', 5000], ['/Music/local.flac', 700]]);
let mounted = true; const writes = [], allowed = [];
const fs = {
  stat: async p => { if (!mounted && p.startsWith('/Volumes')) throw new Error('gone'); if (files.has(p)) return { size: files.get(p) }; if ([...files.keys()].some(f => f.startsWith(p + '/')) || p === '/Volumes/Data') return { size: 0, isDirectory: true }; throw new Error('missing ' + p); },
  readDir: async p => [...new Set([...files.keys()].filter(f => f.startsWith(p + '/')).map(f => f.slice(p.length + 1).split('/')[0]))].map(name => ({ name, isDirectory: !files.has(p + '/' + name) })),
  scan: async root => [...files].filter(([p]) => p.startsWith(root + '/')).map(([path, size]) => ({ path, size })),
  allow: async p => { allowed.push(p); }, write: async (p, fields) => { writes.push([p, fields]); files.set(p, files.get(p) + 10); return { size: files.get(p), mtime: 9 }; },
};
const kvm = new Map(), kv = { get: (k, d) => (kvm.has(k) ? JSON.parse(kvm.get(k)) : d), set: (k, v) => kvm.set(k, JSON.stringify(v)) };
const keyOf = x => 'file:' + x.src.path + '#' + (x.src.kind === 'remote' ? '' : x.src.size);
const remote = (id, path, size, title) => ({ kind: 'track', title, src: { kind: 'remote', name: title + '.flac', path: 'subsonic:c1/' + id, remote: { plugin: 'subsonic', conn: 'c1', item: { id, path, size, suffix: path.split('.').pop() || 'flac' } } } });
const tr = [remote('s1', 'Band/Album/01 One.flac', 1000, 'One'), remote('s2', 'Band/Album/02 Two.flac', 2000, 'Two'), remote('s3', 'Other/x.mp3', 3000, 'X'),
  remote('s4', '', 4000, 'Renamed'), remote('s5', 'Dupes/zzz.flac', 5000, 'Dupe'), { kind: 'track', title: 'Local', src: { kind: 'tauri', name: 'local.flac', path: '/Music/local.flac', size: 700 } }];
tr[3].src.remote.item.suffix = 'flac';
const lib = { tracks: tr, _update: (x, s) => { x.src = s; x.reread = true; } }, store = new NotesStore(new MemoryBackend()), rescans = [];
const plugin = { rescan: async ses => rescans.push(ses) };
// like the app: when records move or change, the library re-derives each track from the store (an edit at another key does not apply)
store.addEventListener('change', async () => { const all = await store.allEdits(); for (const x of tr) if (x.edited && !all.has(keyOf(x))) { x.edited = null; } });
const tf = new TagFiles({ lib, store, kv, keyOf, fs, getPlugin: () => plugin, sessionOf: () => 'ses', makeSource: (path, size, mtime) => ({ kind: 'tauri', name: path.split('/').pop(), path, size, mtime }) });

const d = await tf.setFolder('c1', '/Volumes/Data');
t('the chosen folder is opened for bootleg (allowed) and the layout is worked out: the server folder is the "music" subfolder', allowed.includes('/Volumes/Data') && d.prefix === 'music' && d.drop === 0 && d.sample === 4 && d.matched === 3,      /* s5's reported path does not exist */ JSON.stringify(d));
t('…by the server path', (await tf.resolve(tr[0])).path === '/Volumes/Data/music/Band/Album/01 One.flac');
const r4 = await tf.resolve(tr[3]); t('no path from the server: found by its exact size and type', r4.path === '/Volumes/Data/music/Loose/renamed.flac' && r4.how === 'matched by size', JSON.stringify(r4));
const r5 = await tf.resolve(tr[4]); t('two files with that size: refuses to guess', !r5.path && /2 files/.test(r5.error), r5.error);
await tf.setFolder('c1', '/Volumes/Data/music'); t('choosing the server folder itself needs no prefix', tf.folders().c1.prefix === '' && (await tf.resolve(tr[1])).path === '/Volumes/Data/music/Band/Album/02 Two.flac');
mounted = false; const off = await tf.resolve(tr[0]); t('share not mounted: reported as offline, nothing written', off.offline && /not reachable/.test(off.error)); mounted = true;

// edits → apply
const ed = (x, e) => { x.orig = Object.fromEntries(Object.keys(e).map(k => [k, x[k] ?? ''])); Object.assign(x, e); x.edited = new Set(Object.keys(e)); return store.setEdits(keyOf(x), e); };
tr[0].album = 'Albm'; await ed(tr[0], { album: 'Album', year: 1999 }); await store.setRating(keyOf(tr[0]), 4);
tr[5].title = 'Lcal'; await ed(tr[5], { title: 'Local' }); await store.addNote(keyOf(tr[5]), { text: 'keep me' }); await store.savePlaylist({ name: 'P', items: [keyOf(tr[5])] });
const pend = await tf.pending(); t('pending lists each edited track with old → new per field', pend.length === 2 && pend[0].changes.map(c => `${c.field}:${c.from}→${c.to}`).join() === 'album:Albm→Album,year:→1999', JSON.stringify(pend.map(p => p.changes)));
const res = await tf.apply(pend);
t('writes go to the resolved files with the edited fields', res.every(r => r.ok) && JSON.stringify(writes) === JSON.stringify([['/Volumes/Data/music/Band/Album/01 One.flac', { album: 'Album', year: 1999 }], ['/Music/local.flac', { title: 'Local' }]]), JSON.stringify(res.map(r => r.error || r.path)));
const sRec = await store.get(keyOf(tr[0])); t('server track: marked written, edit kept until the server agrees, server asked to rescan', sRec.editState?.written > 0 && sRec.edits?.album === 'Album' && sRec.rating === 4 && rescans.length === 1);
const newKey = 'file:/Music/local.flac#710', lRec = await store.get(newKey);
t('local file: notes and playlist places move to the new size\'s key, the edit is dropped, the file is re-read', lRec.notes.length === 1 && !lRec.edits && (await store.playlists())[0].items[0] === newKey && tr[5].reread && tr[5].src.size === 710);
tr[5].edited = null; tr[5].orig = null;      // the real library does this when it re-reads the file
t('a written server edit is not written again before the server rescans', (await tf.apply(await tf.pending())).every(r => r.skipped) && writes.length === 2);
tr[0].orig = { album: 'Album', year: '1999' }; await tf.prune(); t('once the server reports the new tags, the bootleg edit is dropped', !(await store.get(keyOf(tr[0]))).edits);
t('the last run is remembered for the Settings page', tf.lastRun()?.ok >= 0);
console.log(bad ? `\n${bad} FAILED` : '\nall tag-files tests pass'); process.exit(bad ? 1 : 0);
