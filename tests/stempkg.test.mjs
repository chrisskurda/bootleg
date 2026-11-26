// .bstem / .bsong packages: reading the zip's directory (plain and Zip64), stored entries in place, deflated JSON,
// and the song's parts as sources (what the library and the player use).
import { readDirectory, readEntry, openPackage, readDawProject, parseComment, parseXml, PKG_RE } from '../src/lib/stempkg.js';
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

// ---- song format 3 and DAWproject files
const PROJECT = (lanes, extraTracks = '') => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Project version="1.0"><Application name="Bitwig Studio" version="6.1.7"/>
<Transport><Tempo max="666" min="20" unit="bpm" value="120.000000" id="id0" name="Tempo"/></Transport>
<Structure>
 <Track contentType="audio" loaded="true" id="t1" name="Kick &amp; Snare"><Channel role="regular" id="c1"><Volume unit="linear" value="0.5" id="v1"/></Channel></Track>
 <Track contentType="audio" loaded="true" id="t2" name="bass"><Channel role="regular" id="c2"><Volume unit="linear" value="1.0" id="v2"/></Channel></Track>${extraTracks}
 <Track contentType="audio notes" loaded="true" id="tm" name="Master"><Channel role="master" id="cm"/></Track>
</Structure>
<Arrangement id="a"><Lanes timeUnit="beats" id="l">${lanes}</Lanes>
<Markers id="m"><Marker time="0.0" name="intro"/><Marker time="16.0" name="drop"/></Markers></Arrangement><Scenes/></Project>`;
const lane = (track, file, time = '0.0') => `<Lanes track="${track}" id="l${track}"><Clips id="k${track}"><Clip time="${time}" duration="16" playStart="0.0"><Clips id="kk${track}"><Clip time="0" duration="16" playStart="0">
  <Warps contentTimeUnit="seconds" timeUnit="beats" id="w${track}"><Audio channels="2" sampleRate="44100" duration="8.0" id="a${track}"><File path="${file}"/></Audio><Warp time="0" contentTime="0"/><Warp time="16" contentTime="8"/></Warps></Clip></Clips></Clip></Clips></Lanes>`;
const META = '<?xml version="1.0"?><MetaData><Title>From Bitwig</Title><Artist>Me</Artist><Comment>late night take\n\n-- bootleg --\nid: 3f0c-id\nrevision: 4\nkey: a#m\npacks: P1; P2</Comment></MetaData>';

t('.dawproject files are songs to the library', PKG_RE.test('x.dawproject') && PKG_RE.test('x.bstem'));
const x = parseXml('<a k="1 &lt; 2"><b>t&amp;u</b><c/><![CDATA[<raw>]]></a>');
t('the XML reader handles attributes, entities, empty elements and CDATA', x.children[0].attrs.k === '1 < 2' && x.children[0].children[0].text === 't&u' && x.children[0].children.length === 2 && x.children[0].text === '<raw>');
t('the bootleg comment block is read, the user text kept apart', JSON.stringify(parseComment('hi\nthere\n\n-- bootleg --\nid: a\nRevision: 2')) === JSON.stringify({ comment: 'hi\nthere', block: { id: 'a', revision: '2' } }) && parseComment('plain').block.id === undefined);
const daw = readDawProject(PROJECT(lane('t1', 'audio/kick.flac') + lane('t2', 'audio/bass.flac')), META);
t('project.xml: tracks, levels, files, tempo, markers', daw.application === 'Bitwig Studio 6.1.7' && daw.bpm === 120 && daw.tracks.map(t => t.name).join() === 'Kick & Snare,bass' && daw.tracks[0].volume === 0.5 && daw.tracks[1].clips[0].file === 'audio/bass.flac' && daw.markers.length === 2);

// a DAW's stems export: no manifest, audio deflated (Bitwig does that) in its own folder
const bw = makeZip([{ name: 'project.xml', data: PROJECT(lane('t1', 'audio/kick.flac') + lane('t2', 'audio/bass.flac')), method: 'deflate' }, { name: 'metadata.xml', data: META, method: 'deflate' },
  { name: 'audio/kick.flac', data: audio(900), method: 'deflate' }, { name: 'audio/bass.flac', data: audio(700), method: 'deflate' }]);
const fp = await openPackage({ name: 'Take.dawproject', path: '/m/Take.dawproject', reader: () => reader(bw) });
t('a DAW stems export plays as a stem set (no mix: the stems are the song)', fp.mix === null && fp.stems.join() === 'audio/kick.flac,audio/bass.flac' && fp.names['audio/kick.flac'] === 'Kick & Snare');
t('…its manifest comes from the project: title, artist, bpm, sections, levels', fp.manifest.title === 'From Bitwig' && fp.manifest.artist === 'Me' && fp.manifest.bpm === 120 && fp.manifest.sections.map(s => `${s.name}@${s.start_s}-${s.end_s}`).join() === 'intro@0-8,drop@8-8' && fp.manifest.stems_gain_db['Kick & Snare'] === -6.02 && fp.manifest.stems_gain_db.bass === 0);
t('…and the song keeps its bootleg id (notes and ratings follow it back from the DAW)', fp.manifest.id === '3f0c-id' && fp.manifest.key === 'a#m' && fp.manifest.licences.packs.join() === 'P1,P2');
t('…deflated audio still plays', Buffer.from(await (await fp.sourceFor('audio/kick.flac').fetch()).arrayBuffer()).equals(audio(900)));
for (const [why, proj] of [['a clip that starts later', PROJECT(lane('t1', 'audio/kick.flac', '4.0'))], ['a note track', PROJECT(lane('t1', 'audio/kick.flac') + '<Lanes track="t3" id="l3"><Clips id="k3"><Clip time="0" duration="4"><Notes id="n"><Note time="0" duration="1" key="60" vel="0.8"/></Notes></Clip></Clips></Lanes>', '<Track contentType="notes" id="t3" name="synth"><Channel role="regular" id="c3"/></Track>')]]) {
  let err = ''; try { await openPackage({ name: 'Arr.dawproject', path: '/m/Arr.dawproject', reader: () => reader(makeZip([{ name: 'project.xml', data: proj }, { name: 'audio/kick.flac', data: audio(10) }])) }); } catch (e) { err = String(e.message); }
  t(`an arranged DAWproject (${why}) is left to Composer`, /bootleg Composer/.test(err));
}
// our own package (version 3) under the DAW name: the manifest wins, project.xml is ignored by the player
const v3 = makeZip([{ name: 'manifest.json', data: JSON.stringify({ format: 'bootleg-song', version: 3, id: 'ours', title: 'Ours' }), method: 'deflate' }, { name: 'mix.flac', data: audio(100) },
  { name: 'project.xml', data: PROJECT(lane('t1', 'stems/kick.flac')), method: 'deflate' }, { name: 'metadata.xml', data: META, method: 'deflate' }, { name: 'stems/kick.flac', data: audio(50) }, { name: 'project/history.json', data: '{"head":1}', method: 'deflate' }]);
for (const name of ['Ours.bsong', 'Ours.dawproject']) {
  const o = await openPackage({ name, path: '/m/' + name, reader: () => reader(v3) });
  t(`a version-3 song plays as before (${name})`, o.manifest.id === 'ours' && o.mix === 'mix.flac' && o.stems.join() === 'stems/kick.flac' && o.project && !o.daw);
}
console.log(bad ? `\n${bad} FAILED` : '\nall stem package tests pass'); process.exit(bad ? 1 : 0);
