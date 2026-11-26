#!/usr/bin/env node
// Builds a small, fully synthetic demo library (fictional artists, generated cover art and music-ish audio — nothing copyrighted)
// used for the README screenshots and handy for trying the app:   node scripts/make-demo-library.mjs <outDir>
import { spawnSync, spawn } from 'node:child_process'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), out = path.resolve(process.argv[2] || 'cache/demo-library');
const ALBUMS = [
  ['Static Orchard', 'Slow Currents', 2024, 'Ambient', ['Night Garden', 'Low Tide', 'Paper Lanterns'], ['#0f2a4a', '#3ea6b5', '#e8d8a8'], 84],
  ['Marlowe Hush', 'Velvet Hours', 2023, 'Soul', ['Copper Light', 'Sundial', 'Late Bloom'], ['#5a1d2c', '#d2603a', '#f4c77b'], 92],
  ['The Quarterlies', 'Funk Report', 2026, 'Funk', ['Open Floor', 'Second Quarter', 'Balance Sheet'], ['#2a1458', '#e8467c', '#ffd23f'], 108],
  ['Isobar', 'Forecast', 2025, 'Electronic', ['Low Pressure', 'Cold Front', 'Clear Sky'], ['#0b3d5c', '#2bb3c0', '#e6f7ff'], 124],
  ['Velvet Compass', 'Northbound', 2022, 'Indie', ['Switchbacks', 'Ferry Lights', 'Whiteout'], ['#1f3a2e', '#6fa287', '#f1e4c3'], 100],
  ['Glass Meridian', 'Afterimage', 2024, 'Synthwave', ['Rewind City', 'Chrome Hearts', 'Halogen'], ['#20064d', '#ff4fa3', '#37e6ff'], 118],
  ['Juniper & the Wire', 'Salt Flats', 2021, 'Folk', ['Dry Lake', 'Mile Marker', 'Quiet Truck'], ['#6b4a2b', '#d9a566', '#f6efe0'], 76],
  ['Neon Cartographer', 'Signal Maps', 2025, 'Techno', ['Grid Ref', 'Waypoint', 'True North'], ['#05080f', '#7a3cff', '#00f5c8'], 132],
  ['Hollow Pines', 'Winter Cabin', 2020, 'Ambient', ['Woodsmoke', 'First Snow', 'Lantern Room'], ['#1b2733', '#8aa7bd', '#f2f5f7'], 66],
  ['Delta Quartet', 'Blue Hour', 2019, 'Jazz', ['Streetcar', 'Half Moon', 'Last Set'], ['#0c1b3a', '#2f6fd6', '#f2c14e'], 96],
  ['Orbit Kids', 'Playground Physics', 2023, 'Pop', ['Swing Set', 'Gravity Well', 'Slide Rule'], ['#ff7a59', '#ffd166', '#4cc9f0'], 112],
  ['Saint Rook', 'Lowlight', 2022, 'Hip-hop', ['Basement Tapes', 'Rooftop', 'Curtain Call'], ['#150f1f', '#b5338a', '#f9c74f'], 88],
];
const NOTES = ['A', 'C', 'D', 'E', 'G'], FREQ = { A: 110, C: 130.81, D: 146.83, E: 164.81, G: 196 };
const sh = (cmd, args) => new Promise(ok => { const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] }); let e = ''; p.stderr.on('data', d => e += d); p.on('close', c => ok({ c, e })); });
const jobs = [];
fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
ALBUMS.forEach(([artist, album, year, genre, titles, [c0, c1, c2], bpm], ai) => {
  const dir = path.join(out, artist, album); fs.mkdirSync(dir, { recursive: true }); const cover = path.join(dir, 'cover.jpg');
  // cover art: a three-colour moving gradient, a vignette and film grain — different for every album
  jobs.push(() => sh('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `gradients=s=640x640:c0=${c0.replace('#', '0x')}:c1=${c1.replace('#', '0x')}:c2=${c2.replace('#', '0x')}:nb_colors=3:x0=${(ai * 97) % 640}:y0=${(ai * 53) % 640}:x1=${640 - (ai * 71) % 640}:y1=${640 - (ai * 29) % 640}:speed=0.0001:seed=${ai + 3}:d=1`, '-frames:v', '1', '-vf', `vignette=PI/4,noise=alls=10:allf=t,hue=h=${(ai * 17) % 40}:s=1.1`, '-q:v', '3', cover]));
  titles.forEach((title, ti) => {
    const root0 = FREQ[NOTES[(ai + ti) % 5]], spb = 60 / (bpm + ti * 2), f = root0 * (ti === 2 ? 1.5 : 1), kick = ai % 4 !== 0 || ti === 1;
    // a kick, a bass note, a slow pad chord and a little arpeggio — ~24 s of something that moves like music in a spectrum
    const expr = [
      kick ? `0.55*sin(2*PI*(48+110*exp(-28*mod(t,${spb})))*mod(t,${spb}))*exp(-7*mod(t,${spb}))` : '0',
      `0.22*sin(2*PI*${f}*t)*(0.6+0.4*sin(2*PI*t/${spb * 4}))`,
      `0.07*(sin(2*PI*${f * 2}*t)+sin(2*PI*${(f * 2 * 1.26).toFixed(2)}*t)+sin(2*PI*${(f * 2 * 1.5).toFixed(2)}*t))*(0.7+0.3*sin(2*PI*t/9))`,
      `0.10*sin(2*PI*${f * 4}*(1+0.25*floor(mod(t/${spb / 2},4)))*t)*exp(-5*mod(t,${spb / 2}))`,
      `0.04*sin(2*PI*${f * 8}*t)*exp(-14*mod(t+${spb / 2},${spb}))`,
    ].join('+');
    const file = path.join(dir, `${String(ti + 1).padStart(2, '0')} ${title}.flac`);
    jobs.push(() => sh('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `aevalsrc='${expr}':s=44100:d=${22 + ti * 3}:c=stereo`, '-i', cover, '-map', '0:a', '-map', '1:v', '-c:a', 'flac', '-c:v', 'mjpeg', '-disposition:v', 'attached_pic', '-af', 'aecho=0.6:0.4:240:0.25,alimiter=limit=0.9',
      '-metadata', `title=${title}`, '-metadata', `artist=${artist}`, '-metadata', `album=${album}`, '-metadata', `date=${year}`, '-metadata', `genre=${genre}`, '-metadata', `track=${ti + 1}/${titles.length}`, '-metadata', `BPM=${bpm + ti * 2}`, file]));
  });
});
// run the ffmpeg jobs 6 at a time (covers must exist before the tracks that embed them: they are queued first per album, so process in two waves)
const covers = jobs.filter((_, i) => i % 4 === 0), tracks = jobs.filter((_, i) => i % 4 !== 0), pool = async (list, n) => { let i = 0; const bad = []; await Promise.all(Array.from({ length: n }, async () => { while (i < list.length) { const r = await list[i++](); if (r.c) bad.push(r.e); } })); return bad; };
const errs = [...await pool(covers, 6), ...await pool(tracks, 6)]; if (errs.length) { console.error('ffmpeg problems:\n' + errs.slice(0, 3).join('\n')); process.exit(1); }
for (const [artist, album] of ALBUMS) fs.rmSync(path.join(out, artist, album, 'cover.jpg'), { force: true });

// an .nfo with a review, an artist bio — the details panel merges these with the tags
fs.writeFileSync(path.join(out, 'The Quarterlies/Funk Report/album.nfo'), '<album><title>Funk Report</title><artist>The Quarterlies</artist><year>2026</year><genre>Funk</genre><label>Basement Records</label><rating>9</rating><review>Recorded live in one take, then never fixed. The rhythm section sits a hair behind the beat and the horns sound like a quarterly earnings call that learned to dance.</review></album>');
fs.writeFileSync(path.join(out, 'The Quarterlies/artist.nfo'), '<artist><name>The Quarterlies</name><biography>Five accountants and a drummer who answered the same ad. Their rehearsal room doubles as a filing cabinet.</biography></artist>');

// a stem set (the bootleg stem format): the visualizer's synthetic fixture, tagged and with a cover
const stems = path.join(out, 'Sessions', 'Glass Garden (session)'); fs.mkdirSync(path.dirname(stems), { recursive: true });
spawnSync('node', [path.join(root, 'vendor/bootleg-vizualizer/tests/make-fixture.mjs'), stems], { stdio: 'ignore' });
if (fs.existsSync(path.join(stems, 'mix.flac'))) {
  const m = JSON.parse(fs.readFileSync(path.join(stems, 'manifest.json'), 'utf8')); m.name = 'Glass Garden'; m.format = 'bootleg-stem'; m.version = 1; fs.writeFileSync(path.join(stems, 'manifest.json'), JSON.stringify(m, null, 1));
  const art = path.join(out, 'sess.jpg'); spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'gradients=s=640x640:c0=0x0b1020:c1=0x2b6cff:c2=0xff5fd2:nb_colors=3:seed=9:d=1', '-frames:v', '1', '-vf', 'vignette=PI/4,noise=alls=8:allf=t', '-q:v', '3', art]);
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', path.join(stems, 'mix.flac'), '-i', art, '-map', '0:a', '-map', '1:v', '-c:a', 'copy', '-c:v', 'mjpeg', '-disposition:v', 'attached_pic', '-metadata', 'title=Glass Garden', '-metadata', 'artist=Glass Meridian', '-metadata', 'date=2026', path.join(stems, 'mix2.flac')]);
  fs.renameSync(path.join(stems, 'mix2.flac'), path.join(stems, 'mix.flac')); fs.rmSync(art, { force: true });
}
console.log(`demo library: ${out}  (${ALBUMS.length} albums, ${ALBUMS.reduce((n, a) => n + a[4].length, 0)} tracks, 1 stem set)`);
