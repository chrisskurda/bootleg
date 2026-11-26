// node plugins/cd/cd.test.mjs — the CD plugin's page logic (the native part has its own tests: cargo test in native/).
import assert from 'node:assert/strict';
import { mbDiscUrl, releaseChoices, metaFromRelease, blankMeta, findOffset, annotations } from './cd-logic.js';

const disc = { musicbrainzId: 'abc.def-', musicbrainzToc: '1+3+1000+150+400+700', toc: { tracks: [1, 2, 3].map(n => ({ number: n, audio: true })).concat([{ number: 4, audio: false }]) } };
assert.match(mbDiscUrl(disc), /^https:\/\/musicbrainz\.org\/ws\/2\/discid\/abc\.def-\?toc=1\+3\+1000\+150\+400\+700&cdstubs=no&inc=artist-credits\+recordings\+labels\+release-groups\+isrcs&fmt=json$/);

// a two-disc release: the medium holding this disc id is chosen, data track skipped
const mb = { releases: [{ id: 'R1', title: 'Album', date: '1994-03-01', country: 'GB', barcode: '0123', 'artist-credit': [{ name: 'Band', joinphrase: ' & ', artist: { id: 'A1' } }, { name: 'Guest' }], 'release-group': { id: 'G1' }, 'label-info': [{ label: { name: 'Label' }, 'catalog-number': 'CAT 1' }],
  media: [{ position: 1, format: 'CD', discs: [{ id: 'other' }], tracks: [{ id: 'x', title: 'Wrong' }] }, { position: 2, format: 'CD', discs: [{ id: 'abc.def-' }], tracks: [{ id: 'T1', title: 'One', recording: { id: 'REC1' } }, { id: 'T2', title: 'Two', 'artist-credit': [{ name: 'Solo' }] }, { id: 'T3', recording: { id: 'REC3', title: 'Three' } }] }] }] };
const ch = releaseChoices(mb, disc); assert.equal(ch.length, 1);
assert.deepEqual({ artist: ch[0].artist, label: ch[0].label, catalog: ch[0].catalog, disc: ch[0].disc, discs: ch[0].discs, exact: ch[0].exact }, { artist: 'Band & Guest', label: 'Label', catalog: 'CAT 1', disc: 2, discs: 2, exact: true });
const m = metaFromRelease(ch[0], disc);
assert.equal(m.albumArtist, 'Band & Guest'); assert.equal(m.disc, 2); assert.equal(m.releaseId, 'R1'); assert.equal(m.artistId, 'A1');
assert.deepEqual(m.tracks.map(t => [t.number, t.title, t.artist, t.recordingId]), [[1, 'One', 'Band & Guest', 'REC1'], [2, 'Two', 'Solo', ''], [3, 'Three', 'Band & Guest', 'REC3']]);
assert.deepEqual(blankMeta(disc).tracks.map(t => t.number), [1, 2, 3]);

// AccurateRip's drive list
const html = `<table><tr><td><font>ASUS - DRW-24D5MT</font></td><td><font>+6</font></td><td>Submitted by</td></tr>
<tr><td>HL-DT-ST&nbsp;- DVDRAM GP65NB60</td><td>+6</td></tr><tr><td>PLEXTOR - DVDR   PX-716A</td><td>+30</td></tr><tr><td>MATSHITA - CD-RW CW-8124</td><td>[Purged]</td></tr></table>`;
assert.equal(findOffset(html, 'PLEXTOR', 'DVDR   PX-716A'), 30);
assert.equal(findOffset(html, 'HL-DT-ST', 'DVDRAM GP65NB60'), 6);
assert.equal(findOffset(html, 'MATSHITA', 'CD-RW CW-8124'), null);
assert.equal(findOffset(html, 'NOBODY', 'X'), null);

// what a rip writes into the library
const result = { tracks: [
  { path: '/m/a.flac', status: 'verified', crc32: 'AAAA', isrc: 'GBX', accuraterip: { matched: 'v2', confidence: 12, total: 12 }, defects: [], unreadable: 0, uncertain: 0 },
  { path: '/m/b.flac', status: 'damaged', crc32: 'BBBB', accuraterip: { matched: null, confidence: 0, total: 12 }, defects: [{ start: 61.5, end: 62.25, kind: 'unreadable', detail: '10 sectors' }], unreadable: 10, uncertain: 0 },
] };
const ann = annotations(result, { vendor: 'PLEXTOR', model: 'PX-716A' }, '2026-11-26');
const a = ann('/m/a.flac'), b = ann('/m/b.flac');
assert.deepEqual(a.tags, ['rip:verified']); assert.equal(a.provenance.kind, 'cd-rip'); assert.equal(a.provenance.device, 'PLEXTOR PX-716A'); assert.match(a.provenance.source, /AccurateRip verified \(v2, confidence 12\)/); assert.equal(a.notes.length, 0);
assert.deepEqual(b.tags, ['rip:damaged']); assert.equal(b.defects.length, 1); assert.match(b.notes[0].text, /10 sectors unreadable.*1:01\.5–1:02\.3 unreadable/);
assert.deepEqual(ann('/elsewhere.flac'), {});
console.log('cd plugin: ok');
