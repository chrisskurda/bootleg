import { findings, arFinding, albums, annotation, lossyGuess, TAG } from './checker-logic.js';
let bad = 0; const t = (n, ok, note = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${note ? '   ' + note : ''}`); if (!ok) bad++; };
const base = (o = {}) => ({ format: 'flac', codec: 'FLAC', lossless: true, rate: 44100, channels: 2, bits: 16, seconds: 200, expectedSeconds: 200, damage: [], truncated: false, md5: 'ok', decodeError: null, ...o, measures: { frames: 0, peakDb: -0.3, clipRuns: 0, clipSamples: 0, dr: 11, usedBits: 16, spectrum: { cutoffHz: 21500, steep: true, dropDb: 40, bandHz: 172, bands: [] }, ...(o.measures || {}) } });
const codes = c => findings(c).map(f => f.code).join(',');

t('a clean CD rip (the ADC filter near 21–22 kHz is not a lossy cliff) has nothing to report', codes(base()) === '');
t('a 128 kbps MP3 saved as FLAC', codes(base({ measures: { spectrum: { cutoffHz: 16710, steep: true, dropDb: 60 } } })) === 'lossy' && /128 kbps/.test(findings(base({ measures: { spectrum: { cutoffHz: 16710, steep: true, dropDb: 60 } } }))[0].text));
t('…but a gentle fade at 16 kHz is not called lossy', codes(base({ measures: { spectrum: { cutoffHz: 16000, steep: false, dropDb: 8 } } })) === '');
t('lossy files themselves are not called lossy', codes(base({ lossless: false, format: 'mp3', measures: { spectrum: { cutoffHz: 16000, steep: true, dropDb: 60 } } })) === '');
t('bitrate guesses', /96 kbps/.test(lossyGuess(14000)) && /160–192/.test(lossyGuess(17500)) && /320/.test(lossyGuess(19800)));
t('upsampled 96 kHz', codes(base({ rate: 96000, bits: 24, measures: { usedBits: 24, spectrum: { cutoffHz: 22875, steep: true, dropDb: 42 } } })) === 'upsampled');
t('real hi-res is fine', codes(base({ rate: 96000, bits: 24, measures: { usedBits: 24, spectrum: { cutoffHz: 40000, steep: false, dropDb: 3 } } })) === '');
t('16-bit audio padded to 24', codes(base({ bits: 24, measures: { usedBits: 16 } })) === 'padded');
t('damage, with where', /0:05–0:06/.test(findings(base({ damage: [{ start: 5, end: 6.5, detail: 'damaged audio' }] }))[0].text) && codes(base({ damage: [{ start: 5, end: 6.5, detail: 'x' }], md5: 'mismatch' })) === 'damaged');
t('a file cut short (not also reported as damage or a checksum mismatch)', codes(base({ truncated: true, seconds: 120, damage: [{ start: 120, end: 200, detail: 'the file ends early' }], md5: 'mismatch' })) === 'truncated');
t('a checksum mismatch alone means the audio was changed', codes(base({ md5: 'mismatch' })) === 'md5');
t('clipping needs more than a few touches', codes(base({ measures: { clipRuns: 5, clipSamples: 20 } })) === '' && codes(base({ measures: { clipRuns: 400, clipSamples: 2000 } })) === 'clipping');

const album = { state: 'checked', tracks: [{ matched: 'v2', confidence: 12, total: 12 }, { matched: null, confidence: 0, total: 12 }] };
t('AccurateRip findings', arFinding(album, 0).tag === 'rip:verified' && arFinding(album, 1).tag === 'rip:suspect' && arFinding({ state: 'not-found', tracks: [] }, 0) === null);

const tr = (path, album, track, extra = {}) => ({ src: { path }, album, track, artist: 'A', ...extra });
const g = albums([tr('/m/A/02.flac', 'X', 2), tr('/m/A/01.flac', 'X', 1), tr('/m/B/01.flac', 'Y', 1), tr('/m/B/03.flac', 'Y', 3), tr('/m/C/01.mp3', 'Z', 1), tr('/m/D/1-01.flac', 'W', 1, { disc: 1 }), tr('/m/D/2-01.flac', 'W', 1, { disc: 2 })]);
t('discs: grouped by folder, album and disc, in track order; gaps in the numbering and lossy files are left out', JSON.stringify(g) === JSON.stringify([['/m/A/01.flac', '/m/A/02.flac'], ['/m/D/1-01.flac'], ['/m/D/2-01.flac']]), JSON.stringify(g));

const a1 = annotation(base({ measures: { spectrum: { cutoffHz: 16000, steep: true, dropDb: 60 } } }), arFinding(album, 1));
t('annotation: tags added, the ones that no longer apply removed, one note', a1.tags.includes(TAG.lossy) && a1.tags.includes('rip:suspect') && a1.removeTags.includes(TAG.damaged) && a1.removeTags.includes('rip:verified') && !a1.removeTags.includes(TAG.lossy) && a1.notes.length === 1 && /^Library check:/.test(a1.notes[0].text));
const a2 = annotation(base());
t('a clean file: every check tag removed, no note (clears an old one), no defects, rip tags left alone', a2.tags.length === 0 && a2.removeTags.length === 7 && a2.notes.length === 0 && a2.defects.length === 0 && !a2.removeTags.some(x => x.startsWith('rip:')));
const a3 = annotation(base({ truncated: true, seconds: 100, damage: [{ start: 100, end: 200, detail: 'the file ends early' }] }));
t('a file cut short gets a "missing" defect', a3.defects[0].kind === 'missing' && a3.defects[0].start === 100);
const a4 = annotation(null, undefined, 'not a readable FLAC file');
t('a file that cannot be read at all', a4.tags[0] === TAG.damaged && /Could not be read/.test(a4.notes[0].text));

console.log(bad ? `\n${bad} FAILED` : '\nall checker tests pass'); process.exit(bad ? 1 : 0);
