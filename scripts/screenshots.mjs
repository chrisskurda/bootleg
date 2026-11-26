#!/usr/bin/env node
// README screenshots: builds the app, loads the synthetic demo library, seeds some ratings/notes and drives the UI.
//   node scripts/screenshots.mjs [outDir=docs/screenshots]        (needs Chrome and ffmpeg)
import { chromium } from 'playwright-core'; import { spawn, spawnSync } from 'node:child_process'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), out = path.resolve(process.argv[2] || 'docs/screenshots'), lib = path.join(root, 'cache/demo-library'), PORT = 8900 + Math.floor(Math.random() * 90);
if (!fs.existsSync(lib)) spawnSync('node', [path.join(root, 'scripts/make-demo-library.mjs'), lib], { stdio: 'inherit' });
spawnSync('node', [path.join(root, 'scripts/build.mjs')], { stdio: 'ignore', cwd: root }); fs.mkdirSync(out, { recursive: true });
const srv = spawn('node', ['scripts/serve.mjs', '--port', String(PORT)], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] }); await new Promise(ok => srv.stdout.on('data', d => /bootleg:/.test(d) && ok()));
const browser = await chromium.launch({ channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const pg = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 })).newPage(), sleep = ms => new Promise(r => setTimeout(r, ms)), ev = f => pg.evaluate(f);
const shot = async name => { await pg.screenshot({ path: path.join(out, name + '.jpg'), type: 'jpeg', quality: 90 }); console.log('shot', name); };
const tall = async h => { await pg.setViewportSize({ width: 1440, height: h }); await sleep(500); }, normal = () => tall(900);
await pg.goto(`http://127.0.0.1:${PORT}/`); await pg.waitForFunction(() => window.__bootleg && window.__bootleg.viz.packs.length > 30);
await pg.setInputFiles('#folderIn', lib); await pg.waitForFunction(() => window.__bootleg.lib.tracks.length === 36 && window.__bootleg.lib.renders.length === 1 && window.__bootleg.lib.tracks.every(t => t.tagged) && !document.getElementById('progress').offsetParent, null, { timeout: 60000 });
await sleep(800);

// ---- seed: ratings, tags, provenance, timeline notes, an album note — so the screenshots show a lived-in library
await ev(async () => {
  const B = window.__bootleg, S = B.notes.store, { trackKey } = await import('/lib/notes-ui.js'), { albumKey } = await import('/lib/album-details.js'), by = t => B.lib.tracks.find(x => x.title === t), k = t => trackKey(by(t));
  const rate = { 'Night Garden': 5, 'Low Tide': 4, 'Copper Light': 4.5, 'Open Floor': 5, 'Second Quarter': 4, 'Low Pressure': 3.5, 'Rewind City': 4.5, 'Chrome Hearts': 4, 'Grid Ref': 4, 'Woodsmoke': 5, 'Streetcar': 4.5, 'Swing Set': 3.5, 'Basement Tapes': 4 };
  for (const [t, r] of Object.entries(rate)) await S.setRating(k(t), r);
  await S.setTags(k('Night Garden'), ['late-night', 'favorites']); await S.setTags(k('Copper Light'), ['vinyl', 'favorites']); await S.setTags(k('Open Floor'), ['driving', 'favorites']);
  await S.setProvenance(k('Copper Light'), { kind: 'vinyl-rip', date: '2026-03-02', device: 'Technics SL-1200 → Audient iD14', venue: '', source: 'First pressing, side A', note: 'cleaned the stylus first' });
  const ng = k('Night Garden'); await S.addNote(ng, { text: 'The pad swells in here — lovely.', at: 6.2 }); await S.addNote(ng, { text: 'Favourite stretch. Turn it up.', at: 11, to: 17 }); await S.addNote(ng, { text: 'Heard this first at the lakehouse, late summer. Still takes me back.', kind: 'memory' });
  const ak = albumKey({ artist: 'The Quarterlies', album: 'Funk Report' }); await S.setRating(ak, 4.5); await S.setTags(ak, ['band-favorite']); await S.addNote(ak, { text: 'One take, never fixed — that is the whole point of this record.', kind: 'note' });
});
const play = t => pg.evaluate(async title => { const B = window.__bootleg, tr = B.lib.sortedTracks().find(x => x.title === title); await B.player.playList([tr], 0); }, t);

// 1. the track list (a stem set sits in the list as one item)
await pg.click('.nav[data-view="tracks"]'); await sleep(500); await shot('tracks');
// 2. albums: grid, cover flow, split with merged details and notes
await pg.click('.nav[data-view="albums"]'); await pg.click('#albumMode button[data-mode="grid"]'); await sleep(600); await shot('albums-grid');
await pg.click('#albumMode button[data-mode="flow"]'); await pg.waitForSelector('#albumFlow .fitem.center'); await pg.locator('#albumFlow .flow').focus(); for (let i = 0; i < 4; i++) { await pg.keyboard.press('ArrowRight'); await sleep(120); } await sleep(900); await shot('albums-flow');
await pg.click('#albumMode button[data-mode="split"]'); await pg.waitForSelector('#splitList .srow2'); await pg.locator('#splitList .srow2', { hasText: 'Funk Report' }).click(); await pg.waitForFunction(() => document.querySelector('#splitPane .big')?.textContent === 'Funk Report'); await sleep(900); await shot('albums-split');
await pg.click('#albumMode button[data-mode="grid"]');
// 3. now playing: a visualizer reacting to the music
await play('Night Garden'); await pg.click('.nav[data-view="now"]'); await pg.selectOption('#packSelect', 'horizon'); await sleep(4200); await shot('now-playing');
// 4. notes on the timeline + provenance, right under the visualizer (a taller window so both fit)
await tall(1200); await ev(() => { const l = document.querySelector('#lookParams'); l.style.display = 'none'; l.previousElementSibling.style.display = 'none'; document.querySelector('#view-now').scrollTop = 0; }); await sleep(600); await shot('notes'); await normal();
// 5. a stem set: mix-first, stems loaded for a stem-aware visualizer, with the live mixer
await tall(1100); await ev(() => { document.querySelector('#view-now').scrollTop = 0; document.getElementById('notesPanel').style.display = 'none'; }); await pg.evaluate(async () => { const B = window.__bootleg; await B.player.playList([B.lib.renders[0]], 0); }); await pg.selectOption('#packSelect', 'stem-rack');
await pg.waitForFunction(() => window.__bootleg.player.stemsState === 'ready', null, { timeout: 30000 }); await sleep(2500); await ev(() => { const s = document.querySelectorAll('#stemRows .stem'); if (s[3]) s[3].querySelector('.ms.m')?.click(); });
await sleep(900); await shot('stems');
await browser.close(); srv.kill();
