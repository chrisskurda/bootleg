// Tag reader against real files made with ffmpeg: mp3 (ID3v2.3, v2.4, v1), flac, m4a — Unicode, cover art, track numbers, duration.
import { spawnSync } from 'node:child_process'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { readTags, bufferReader } from '../src/lib/tags.js';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bootleg-tags-')); let bad = 0; const t = (n, ok, note = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${note ? '   ' + note : ''}`); if (!ok) bad++; };
const ff = (...a) => { const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...a]); if (r.status) throw new Error(r.stderr.toString()); };
ff('-f', 'lavfi', '-i', 'color=c=0xcc5533:s=320x320:d=1', '-frames:v', '1', path.join(dir, 'art.png'));
const TITLE = 'Café Ünïcødé ✓ 日本語', META = { title: TITLE, artist: 'The Quarterlies', album: 'Funk Report', date: '2026-03-01', track: '3/12', genre: 'Business Funk', composer: 'A. Analyst', BPM: '104' };
const md = o => Object.entries(o).flatMap(([k, v]) => ['-metadata', `${k}=${v}`]);
const sine = ['-f', 'lavfi', '-i', 'sine=frequency=330:duration=3'], art = ['-i', path.join(dir, 'art.png')];
const make = (name, ...a) => { ff(...a, path.join(dir, name)); return new Uint8Array(fs.readFileSync(path.join(dir, name))); };
const files = {
  'v23.mp3': make('v23.mp3', ...sine, ...art, '-map', '0:a', '-map', '1:v', '-c:a', 'libmp3lame', '-c:v', 'mjpeg', '-id3v2_version', '3', ...md(META)),
  'v24.mp3': make('v24.mp3', ...sine, ...art, '-map', '0:a', '-map', '1:v', '-c:a', 'libmp3lame', '-c:v', 'mjpeg', '-id3v2_version', '4', ...md(META)),
  'tagged.flac': make('tagged.flac', ...sine, ...art, '-map', '0:a', '-map', '1:v', '-c:a', 'flac', '-c:v', 'mjpeg', '-disposition:v', 'attached_pic', ...md({ ...META, initialkey: 'Am', DISCNUMBER: '2' })),
  'tagged.m4a': make('tagged.m4a', ...sine, ...art, '-map', '0:a', '-map', '1:v', '-c:a', 'aac', '-c:v', 'mjpeg', '-disposition:v', 'attached_pic', ...md(META)),
  'v1.mp3': (() => { const mp3 = make('plain.mp3', ...sine, '-c:a', 'libmp3lame', '-map_metadata', '-1', '-id3v2_version', '0'); const v1 = new Uint8Array(128), put = (s, o) => v1.set(new TextEncoder().encode(s), o);   // a hand-made 128-byte ID3v1 block
    put('TAG', 0); put('Old Tag', 3); put('Old Artist', 33); put('Old Album', 63); put('1999', 93); v1[125] = 0; v1[126] = 7; v1[127] = 17; const o = new Uint8Array(mp3.length + 128); o.set(mp3); o.set(v1, mp3.length); return o; })(),
  'bare.wav': make('bare.wav', ...sine),
};
for (const [name, u8] of Object.entries(files)) {
  const g = await readTags(bufferReader(u8)); const tag = `${name}:`;
  if (name === 'v1.mp3') { t(`${tag} ID3v1 fallback`, g.title === 'Old Tag' && g.artist === 'Old Artist' && g.album === 'Old Album' && g.year === '1999' && g.track === 7, JSON.stringify(g)); continue; }
  if (name === 'bare.wav') { t(`${tag} no tags -> empty, no crash`, Object.keys(g).length === 0, JSON.stringify(g)); continue; }
  t(`${tag} title keeps Unicode`, g.title === TITLE, g.title); t(`${tag} artist / album / year / genre`, g.artist === 'The Quarterlies' && g.album === 'Funk Report' && g.year === '2026' && g.genre === 'Business Funk', `${g.artist} | ${g.album} | ${g.year} | ${g.genre}`);
  t(`${tag} track 3 of 12`, g.track === 3 && g.trackTotal === 12, `${g.track}/${g.trackTotal}`);
  t(`${tag} cover art is a real JPEG`, g.cover && g.cover.mime === 'image/jpeg' && g.cover.data[0] === 0xff && g.cover.data[1] === 0xd8 && g.cover.data.length > 500, g.cover ? `${g.cover.mime} ${g.cover.data.length} B` : 'none');
  if (name !== 'v23.mp3' && name !== 'v24.mp3') t(`${tag} duration ≈ 3 s`, Math.abs(g.duration - 3) < 0.2, String(g.duration));
  if (name.endsWith('.mp3')) t(`${tag} composer and BPM`, g.composer === 'A. Analyst' && g.bpm === 104, `${g.composer} ${g.bpm}`);
  if (name.endsWith('.flac')) t(`${tag} key and disc`, g.key === 'Am' && g.disc === 2, `${g.key} ${g.disc}`);
}
// robustness: truncated and garbage input must not throw
const cut = files['tagged.flac'].subarray(0, 200); t('truncated flac: no crash', typeof (await readTags(bufferReader(cut))) === 'object');
t('garbage bytes: no crash', Object.keys(await readTags(bufferReader(new Uint8Array(500).map((_, i) => (i * 37) & 255)))).length === 0);
// only the ranges it needs: a "huge" flac with the tags at the start must not be read whole
let bytesRead = 0; const big = files['tagged.flac']; await readTags({ size: 500e6, read: async (o, l) => { bytesRead += l; return big.subarray(o, Math.min(big.length, o + l)); } });
t('reads only what it needs from a large file', bytesRead < 4e6, `${(bytesRead / 1024).toFixed(0)} KB requested of 500 MB`);
fs.rmSync(dir, { recursive: true, force: true }); console.log(bad ? `\n${bad} FAILED` : '\nall tag tests pass'); process.exit(bad ? 1 : 0);
