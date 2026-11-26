// .bstem / .bsong packages: reading the zip's directory (plain and Zip64), stored entries in place, deflated JSON,
// and the song's parts as sources (what the library and the player use).
import { readDirectory, readEntry, openPackage } from '../src/lib/stempkg.js';
import { makeZip, bstemFrom } from './zipw.mjs';
let bad = 0; const t = (n, ok, note = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${note ? '   ' + note : ''}`); if (!ok) bad++; };
const reader = buf => ({ size: buf.length, read: async (o, l) => new Uint8Array(buf.subarray(o, o + l)) });
const audio = n => Buffer.from(Array.from({ length: n }, (_, i) => (i * 7) & 255));

for (const zip64 of [false, true]) {
  const z = makeZip([{ name: 'manifest.json', data: '{"id":"x"}', method: 'deflate' }, { name: 'mix.flac', data: audio(5000) }, { name: 'stems/kick.flac', data: audio(3000) }, { name: 'project/revs/1.json', data: '{}', method: 'deflate' }], { zip64 });
  const d = await readDirectory(reader(z)); const tag = zip64 ? ' (Zip64)' : '';
  t('the directory lists every entry with its size' + tag, [...d.keys()].join() === 'manifest.json,mix.flac,stems/kick.flac,project/revs/1.json' && d.get('mix.flac').size === 5000 && d.get('mix.flac').method === 0);
  t('a stored entry is read in place, byte for byte' + tag, Buffer.from(await readEntry(reader(z), d.get('stems/kick.flac'))).equals(audio(3000)));
  t('a deflated entry is inflated' + tag, new TextDecoder().decode(await readEntry(reader(z), d.get('manifest.json'))) === '{"id":"x"}');
}
let threw = false; try { await readDirectory(reader(Buffer.from('not a zip at all'))); } catch { threw = true; } t('a file that is not a zip is refused', threw);

const files = { 'mix.flac': audio(4000), 'stems/kick.flac': audio(1000), 'stems/bass.flac': audio(1200), 'clips.json': '{"clips":[]}', 'cover.png': audio(50), 'provenance.json': '[]' };
const pkg = await openPackage({ name: 'Song.bstem', path: '/m/Song.bstem', size: 0, reader: () => reader(bstemFrom(files, { format: 'bootleg-stem', version: 2, id: 'abc', title: 'Song' })) });
t('a package names its mix, stems, clips and cover', pkg.mix === 'mix.flac' && pkg.stems.join() === 'stems/bass.flac,stems/kick.flac' && pkg.clips === 'clips.json' && pkg.cover === 'cover.png' && pkg.manifest.title === 'Song' && !pkg.project);
const kick = pkg.sourceFor('stems/kick.flac');
t('each part is a source with a path inside the package', kick.path === '/m/Song.bstem#stems/kick.flac' && kick.size === 1000 && kick.name === 'kick.flac');
t('…whose bytes come out by range (for tag reading)', Buffer.from(await kick.reader().read(10, 20)).equals(audio(1000).subarray(10, 30)));
t('…or whole, as a typed response (for the player and the stem deck)', (await kick.fetch()).headers.get('content-type') === 'audio/flac' && (await (await pkg.sourceFor('mix.flac').fetch()).arrayBuffer()).byteLength === 4000);
t('…and JSON parts as text', JSON.parse(await pkg.sourceFor('clips.json').text()).clips.length === 0);
const song = await openPackage({ name: 'S.bsong', path: '/m/S.bsong', reader: () => reader(makeZip([{ name: 'manifest.json', data: '{"id":"s"}', method: 'deflate' }, { name: 'mix.wav', data: audio(10) }, { name: 'project/history.json', data: '{"head":1}', method: 'deflate' }])) });
t('a .bsong is a stem set too; its project is noticed and not played', song.project && song.mix === 'mix.wav' && song.stems.length === 0);
console.log(bad ? `\n${bad} FAILED` : '\nall stem package tests pass'); process.exit(bad ? 1 : 0);
