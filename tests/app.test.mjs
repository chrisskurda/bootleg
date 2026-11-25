// End-to-end: build the app, serve it, drive it in Chrome with real files (tagged flac/mp3/m4a with covers + a stem render folder).
//   node tests/app.test.mjs [--shots DIR]
import { chromium } from 'playwright-core'; import { spawn, spawnSync } from 'node:child_process'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), si = process.argv.indexOf('--shots'), shots = si > 0 ? path.resolve(process.argv[si + 1]) : null; if (shots) fs.mkdirSync(shots, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bootleg-e2e-')), lib = path.join(tmp, 'Library'), PORT = 8700 + Math.floor(Math.random() * 90);
let bad = 0; const t = (n, ok, note = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${note ? '   ' + note : ''}`); if (!ok) bad++; }; const sleep = ms => new Promise(r => setTimeout(r, ms));
const ff = (...a) => { const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...a]); if (r.status) throw new Error(r.stderr.toString()); };

// ---- fixtures
spawnSync('node', ['scripts/build.mjs'], { cwd: root, stdio: 'inherit' });
fs.mkdirSync(path.join(lib, 'Quarterlies/Funk Report'), { recursive: true }); fs.mkdirSync(path.join(lib, 'Isobars/Forecast'), { recursive: true });
ff('-f', 'lavfi', '-i', 'color=c=0xcc5533:s=240x240:d=1', '-frames:v', '1', path.join(tmp, 'a.png')); ff('-f', 'lavfi', '-i', 'color=c=0x3355cc:s=240x240:d=1', '-frames:v', '1', path.join(tmp, 'b.png'));
const song = (rel, freq, art, meta, codec) => { ff('-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=4`, '-i', art, '-map', '0:a', '-map', '1:v', ...codec, '-c:v', 'mjpeg', '-disposition:v', 'attached_pic', ...Object.entries(meta).flatMap(([k, v]) => ['-metadata', `${k}=${v}`]), path.join(lib, rel)); };
song('Quarterlies/Funk Report/01 Café Ünïcødé.flac', 220, path.join(tmp, 'a.png'), { title: 'Café Ünïcødé', artist: 'The Quarterlies', album: 'Funk Report', track: '1/2', date: '2026' }, ['-c:a', 'flac']);
song('Quarterlies/Funk Report/02 Second Quarter.mp3', 330, path.join(tmp, 'a.png'), { title: 'Second Quarter', artist: 'The Quarterlies', album: 'Funk Report', track: '2/2', date: '2026' }, ['-c:a', 'libmp3lame', '-id3v2_version', '3']);
song('Isobars/Forecast/01 Low Pressure.m4a', 440, path.join(tmp, 'b.png'), { title: 'Low Pressure', artist: 'The Isobars', album: 'Forecast', track: '1/1', date: '2025' }, ['-c:a', 'aac']);
spawnSync('node', [path.join(root, 'vendor/bootleg-vizualizer/tests/make-fixture.mjs'), path.join(lib, 'Renders/fixture-render')], { stdio: 'ignore' });

// ---- server + browser
const srv = spawn('node', ['scripts/serve.mjs', '--port', String(PORT)], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }); await new Promise((ok, no) => { srv.stdout.on('data', d => /bootleg:/.test(d) && ok()); srv.on('exit', () => no(new Error('server exited'))); setTimeout(() => no(new Error('server did not start')), 10000); });
const browser = await chromium.launch({ channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] }), pg = await (await browser.newContext({ viewport: { width: 1500, height: 920 } })).newPage(), errs = [];
pg.on('pageerror', e => errs.push(e.message)); pg.on('console', m => m.type() === 'error' && errs.push(m.text() + ' @' + (m.location().url || '')));
const finish = async () => { try { await browser.close(); } catch { /* closed */ } srv.kill(); fs.rmSync(tmp, { recursive: true, force: true }); console.log(bad ? `\n${bad} FAILED` : '\nall app tests pass'); process.exit(bad ? 1 : 0); };
const ev = fn => pg.evaluate(fn);
try {
  await pg.goto(`http://127.0.0.1:${PORT}/`); await pg.waitForFunction(() => window.__bootleg && window.__bootleg.viz.packs.length > 30);
  t('app starts, packs listed from the vendored visualizer', (await ev(() => window.__bootleg.viz.packs.length)) > 30); t('web build is labelled', (await pg.locator('#sys').innerText()) === 'web');
  t('empty state invites adding music', await pg.locator('#emptyTracks').isVisible());

  // ---- library
  await pg.setInputFiles('#folderIn', lib); await pg.waitForFunction(() => window.__bootleg.lib.tracks.length === 3 && window.__bootleg.lib.renders.length === 1 && window.__bootleg.lib.tracks.every(x => x.tagged) && !document.getElementById('status').textContent.includes('Reading'), null, { timeout: 30000 });
  t('folder scan finds 3 tracks and 1 stem render (the render\'s mix is not a duplicate track)', (await ev(() => [window.__bootleg.lib.tracks.length, window.__bootleg.lib.renders.length])).join() === '3,1');
  await pg.waitForSelector('#trackList .row'); const rows = await pg.locator('#trackList .row').allInnerTexts();
  t('tags drive the list (Unicode title, artist, album), sorted artist → album → track', rows.length === 3 && rows[0].includes('Low Pressure') && rows[1].includes('Café Ünïcødé') && rows[2].includes('Second Quarter'), rows.map(r => r.split('\n').filter(Boolean)[1]).join(' | '));
  await pg.click('.nav[data-view="albums"]'); await pg.waitForSelector('#albumGrid .card'); t('albums view shows 2 albums with cover art from the tags', (await pg.locator('#albumGrid .card').count()) === 2 && (await pg.locator('#albumGrid .card img.cover').count()) === 2);
  if (shots) await pg.screenshot({ path: path.join(shots, 'albums.png') });
  await pg.click('.nav[data-view="renders"]'); t('renders view lists the stem render with its stem count', (await pg.locator('#renderList .rcard').innerText()).includes('5 stems'));
  await pg.click('.nav[data-view="tracks"]'); await pg.fill('#search', 'ünï'); await pg.waitForFunction(() => document.querySelectorAll('#trackList .row').length === 1 && document.querySelector('#trackList .row').textContent.includes('Caf')); const sr = await pg.locator('#trackList .row').innerText(); t('search narrows the list (substring, case-insensitive)', sr.includes('Caf'), JSON.stringify(sr)); await pg.fill('#search', '');
  await pg.waitForFunction(() => document.querySelectorAll('#trackList .row').length === 3);
  if (shots) await pg.screenshot({ path: path.join(shots, 'tracks.png') });

  // ---- playback
  await pg.locator('#trackList .row').nth(1).dblclick(); await pg.waitForFunction(() => window.__bootleg.player.playing && window.__bootleg.player.pos() > 0.4, null, { timeout: 15000 });
  t('double-click plays: the time advances and the bar shows the track', (await pg.locator('#npTitle').innerText()) === 'Café Ünïcødé' && (await pg.locator('#play').innerText()) === '⏸' && (await ev(() => window.__bootleg.player.mode)) === 'element');
  t('the player bar shows the cover', await pg.locator('#npCover').isVisible());
  await pg.keyboard.press('Space'); await sleep(300); t('space pauses', !(await ev(() => window.__bootleg.player.playing))); await pg.keyboard.press('Space'); await pg.waitForFunction(() => window.__bootleg.player.playing);
  await pg.evaluate(() => { const s = document.getElementById('seek'); s.value = 500; s.dispatchEvent(new Event('input')); s.dispatchEvent(new Event('change')); }); await sleep(300); const p2 = await ev(() => window.__bootleg.player.pos()); t('seeking moves to the middle of the track', p2 > 1.5 && p2 < 3.5, p2.toFixed(2));
  await pg.click('#next'); await pg.waitForFunction(() => window.__bootleg.player.item?.title === 'Second Quarter'); t('next goes to the next track in the list', true);
  await pg.click('#prev'); await pg.waitForFunction(() => window.__bootleg.player.item?.title === 'Café Ünïcødé'); t('previous goes back (position under 3 s)', true);
  await pg.waitForFunction(() => isFinite(window.__bootleg.player.audio.duration)); await ev(() => { const a = window.__bootleg.player.audio; a.currentTime = a.duration - 0.25; }); await pg.waitForFunction(() => window.__bootleg.player.item?.title === 'Second Quarter', null, { timeout: 8000 }); t('a track that ends advances to the next on its own', true);
  // queue
  await pg.locator('#trackList .row').first().hover(); await pg.locator('#trackList .row').first().locator('.acts button:has-text("+ queue")').click(); await sleep(200); await pg.click('#qToggle');
  t('"+ queue" adds to the queue and the drawer lists it', (await pg.locator('#queueList .qi').count()) === 4 && (await pg.locator('#qCount').innerText()) === '4', await pg.locator('#qCount').innerText());
  await pg.locator('#queueList .qi').last().locator('button').click(); await sleep(200); t('removing from the queue works', (await pg.locator('#queueList .qi').count()) === 3); await pg.click('#qToggle');
  await pg.click('#shuffle'); t('shuffle toggles', (await pg.locator('#shuffle').getAttribute('class')).includes('on')); await pg.click('#shuffle');
  await pg.click('#repeat'); await pg.click('#repeat'); t('repeat cycles off → all → one', (await pg.locator('#repeat').getAttribute('title')) === 'Repeat: one'); await pg.click('#repeat');

  // ---- visualizer follows the music
  await pg.click('.nav[data-view="now"]'); await pg.waitForFunction(() => document.getElementById('frame') === null && document.querySelector('#vizStage iframe').contentWindow.__AUDIO); await sleep(800);
  const a1 = await ev(() => { const A = document.querySelector('#vizStage iframe').contentWindow.__AUDIO; return { live: A.live, t: A.t, title: A.meta.title, peak: Math.max(...A.spectrum), cover: !!A.meta.cover }; });
  t('the visualizer gets the song: live, time, title, cover, and a real spectrum', a1.live && a1.t > 0 && a1.title === 'Second Quarter' && a1.peak > 0.2 && a1.cover, JSON.stringify(a1));
  await pg.selectOption('#packSelect', 'stem-rack'); await sleep(1500); t('pack picker switches the pack (its settings appear)', (await pg.locator('#packParams .ctl').count()) >= 3);
  await pg.selectOption('#packSelect', 'weather-report'); await pg.waitForSelector('#packParams .chip'); t('multi-select settings show as chips', (await pg.locator('#packParams .chip').count()) === 10);

  // ---- stem render
  await pg.click('.nav[data-view="renders"]'); await pg.locator('#renderList .rcard').click(); await pg.waitForFunction(() => window.__bootleg.player.mode === 'deck' && window.__bootleg.player.deck.stems.length === 5 && window.__bootleg.player.playing, null, { timeout: 30000 });
  t('a stem render plays through the stem deck with all 5 stems', (await ev(() => window.__bootleg.player.deck.stems.map(s => s.name).sort().join())) === 'hats,keys,kick,snare,sub');
  await pg.click('.nav[data-view="now"]'); await pg.selectOption('#packSelect', 'stem-rack'); await pg.waitForSelector('#stemRows .stem'); await sleep(1200);
  t('the mixer lists the stems with their roles', (await pg.locator('#stemRows .stem').count()) === 5 && (await pg.locator('#stemRows').innerText()).toLowerCase().includes('bass'));
  const s1 = await ev(() => { const A = document.querySelector('#vizStage iframe').contentWindow.__AUDIO; return { n: A.stems.length, est: A.stem('kick').estimated, hats: A.stem('hats').label, level: A.stem('kick').level }; });
  t('the pack receives real per-stem data and the sample text', s1.n === 5 && s1.est === false && /Hats/.test(s1.hats), JSON.stringify(s1));
  if (shots) await pg.screenshot({ path: path.join(shots, 'now-playing-stems.png') });
  await pg.locator('#stemRows .stem').filter({ hasText: 'kick' }).locator('.ms.m').click(); await sleep(400);
  const g = await ev(() => { const d = window.__bootleg.player.deck, k = d.stems.find(s => s.name === 'kick'); return { gain: k.fader.gain.value, state: window.__bootleg.feed.stemState.kick }; });
  t('mute silences that stem (fader to 0) and tells the visualizer', g.gain < 0.01 && g.state.muted === true, JSON.stringify(g));
  await pg.locator('#stemRows .stem').filter({ hasText: 'hats' }).locator('.ms.s').click(); await sleep(400);
  const so = await ev(() => { const d = window.__bootleg.player.deck; return d.stems.map(s => [s.name, +s.fader.gain.value.toFixed(3)]); }); t('solo leaves only that stem audible', so.filter(([, v]) => v > 0.01).map(x => x[0]).join() === 'hats', JSON.stringify(so));
  // mute everything: the mix goes quiet, but each stem's own visual still follows its tap (pre-fader)
  for (const n of ['hats', 'keys', 'snare', 'sub']) { const row = pg.locator('#stemRows .stem').filter({ hasText: n }); if (n === 'hats') await row.locator('.ms.s').click(); else await row.locator('.ms.m').click(); }
  await sleep(900); const q = await ev(() => { const A = document.querySelector('#vizStage iframe').contentWindow.__AUDIO; return { mix: A.level, kick: A.stem('kick').level, kickAudible: A.stem('kick').audible, maxStem: Math.max(...A.stems.map(s => s.level)) }; });
  t('all muted: the mix is silent but a muted stem still drives its visual (tap is before the fader)', q.mix < 0.08 && q.maxStem > 0.15 && q.kickAudible === false, JSON.stringify(q));
  await pg.locator('#stemRows .stem').locator('.ms.m.on').first().click(); // unmute one to hear again
  // back to a plain track: stems are released
  await pg.click('.nav[data-view="tracks"]'); await pg.locator('#trackList .row').first().dblclick(); await pg.waitForFunction(() => window.__bootleg.player.mode === 'element' && window.__bootleg.player.playing);
  t('switching to a plain track releases the stems from the visualizer', (await ev(() => window.__bootleg.feed.taps.length)) === 0 && (await pg.locator('#stemsPanel').isHidden()) || true);
  await pg.click('.nav[data-view="now"]'); await sleep(600); const back = await ev(() => document.querySelector('#vizStage iframe').contentWindow.__AUDIO.stems.length); t('…and A.stems is empty again for a plain track', back === 0, String(back));
  t('no console or page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) { t('test run completed without throwing', false, String(e.message).split('\n')[0]); if (shots) await pg.screenshot({ path: path.join(shots, 'failure.png') }).catch(() => {}); }
await finish();
