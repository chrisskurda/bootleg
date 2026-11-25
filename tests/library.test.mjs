// Stem-set detection on the layouts real music folders use. A set must show up as ONE item, never as its parts.
import { Library } from '../src/lib/library.js';
globalThis.requestAnimationFrame = f => setTimeout(f, 0); globalThis.window = { VisStems: { roleOf: n => ({ kick: 'kick', snare: 'snare', hats: 'hats', bass: 'bass', lead: 'lead', pad: 'pad', arp: 'lead', vox: 'vocals', fx: 'fx', perc: 'perc', sub: 'bass', riser: 'fx', stab: 'other' }[String(n).toLowerCase().replace(/\.[^.]+$/, '').replace(/[^a-z0-9]/g, '')] || 'other') } };
let bad = 0; const t = (n, ok, note = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${note ? '   ' + note : ''}`); if (!ok) bad++; };
const src = p => ({ kind: 'tauri', name: p.split('/').pop(), path: p, size: 1000, mtime: 1, url: () => 'x', reader: () => ({ size: 0, read: async () => new Uint8Array(0) }), text: async () => '{"name":"From Manifest","bpm":120,"seconds":30}' });
const mk = paths => { const l = new Library(); l.add(paths.map(src), 'music'); return l; };
const names = l => [...l.tracks.map(x => x.title), ...l.renders.map(x => '[' + x.title + ' ' + x.stems.length + ']')].sort();

// 1. the standard render: mix + manifest + clips + stems/
let l = mk(['/T/out_a/mix.flac', '/T/out_a/manifest.json', '/T/out_a/clips.json', '/T/out_a/provenance.json', ...['kick', 'snare', 'bass'].map(x => `/T/out_a/stems/${x}.flac`)]);
t('standard render (manifest + stems/ + mix): one item, mix and stems hidden', l.tracks.length === 0 && l.renders.length === 1 && l.renders[0].stems.length === 3 && l.renders[0].mix.name === 'mix.flac' && !!l.renders[0].clipsSrc);
// 2. stems/ with NO manifest, nested (the "gm" layout)
l = mk(['/T/out_ghost/ghost/gm/mix.wav', '/T/out_ghost/ghost/gm/stems/kick.wav', '/T/out_ghost/ghost/gm/stems/bass.wav', '/T/out_ghost/ghost/gm/stems/pad.wav', '/T/out_ghost/ghost/ghost.mid', '/T/out_ghost/ghost/midi/kick.mid']);
t('stems/ without a manifest still groups (nested "gm" layout), titled after the meaningful folder', l.tracks.length === 0 && l.renders.length === 1 && l.renders[0].title === 'ghost' && !!l.renders[0].mix, JSON.stringify(names(l)));
// 3. stems only, no mix
l = mk(['/T/genesis/slowmoon/stems/lead.wav', '/T/genesis/slowmoon/stems/kick.wav', '/T/genesis/slowmoon/stems/bass.wav', '/T/genesis/slowmoon/stems/hats.wav']);
t('stems with no mix at all are still one item', l.tracks.length === 0 && l.renders.length === 1 && !l.renders[0].mix);
// 4. loose stem set (a folder of stem-named files + musicset.json)
l = mk(['/T/musicsets/liquid/bed.flac', '/T/musicsets/liquid/pad.flac', '/T/musicsets/liquid/drums.flac', '/T/musicsets/liquid/lead.flac', '/T/musicsets/liquid/bass.flac', '/T/musicsets/liquid/musicset.json']);
t('a loose set of stem-named files is one item', l.tracks.length === 0 && l.renders.length === 1 && l.renders[0].stems.length === 5 && l.renders[0].loose === true, JSON.stringify(names(l)));
// 5. an ordinary album must NOT be mistaken for a stem set
l = mk(['/T/Album/01 Intro.flac', '/T/Album/02 Bass Is Back.flac', '/T/Album/03 Lead Me On.flac', '/T/Album/04 Pad Thai.flac', '/T/Album/05 Kick Rocks.flac']);
t('an ordinary album (stem words only inside longer titles) stays as tracks', l.renders.length === 0 && l.tracks.length === 5);
l = mk(['/T/Mixed/kick.flac', '/T/Mixed/bass.flac', '/T/Mixed/Song One.flac', '/T/Mixed/Song Two.flac', '/T/Mixed/Song Three.flac']);
t('…and a few stem-named files among real songs do not turn the folder into a stem set', l.renders.length === 0 && l.tracks.length === 5);
// 6. generic file names take the folder's name
l = mk(['/T/gostraight/gostraight_genesis/mix.wav', '/T/gostraight/gostraight_genesis/midi/kick.mid', '/T/Album/mix.flac']);
t('a lone "mix.wav" is titled after its folder', l.tracks.find(x => x.src.path.includes('gostraight')).title === 'gostraight_genesis' && l.tracks.find(x => x.src.path.includes('/Album/')).title === 'Album');
// 7. many sets, mixed with tracks, added in slices
const many = []; for (let i = 0; i < 40; i++) many.push(`/T/s${String(i).padStart(2, '0')}/mix.flac`, `/T/s${String(i).padStart(2, '0')}/manifest.json`, ...['kick', 'bass', 'pad'].map(x => `/T/s${String(i).padStart(2, '0')}/stems/${x}.flac`)); many.push('/T/zz single.flac');
many.sort(); l = new Library(); await l.addChunked(many.map(src), 'music', { chunk: 7 });
t('loading in small slices never splits a stem set (40 sets + 1 track)', l.renders.length === 40 && l.tracks.length === 1 && l.renders.every(r => r.stems.length === 3 && r.mix));
// 8. lists: sets and tracks are merged, sets can be hidden
l = mk(['/T/a/mix.flac', '/T/a/manifest.json', '/T/a/stems/kick.flac', '/T/a/stems/bass.flac', '/T/solo.flac']); t('the item list contains the set once, plus the track', l.visibleItems.length === 2 && l.sortedTracks().length === 2);
l.includeRenders = false; l._changed(); t('…and sets can be hidden from the list', l.visibleItems.length === 1 && l.sortedTracks().length === 1 && l.renders.length === 1);
setTimeout(() => { console.log(bad ? `\n${bad} FAILED` : '\nall library tests pass'); process.exit(bad ? 1 : 0); }, 50);
