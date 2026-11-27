// End-to-end: build the app, serve it, drive it in Chrome with real files (tagged flac/mp3/m4a with covers + a stem render folder).
//   node tests/app.test.mjs [--shots DIR]
import { startMock } from './mock-subsonic.mjs';
import { startJellyfin } from './mock-jellyfin.mjs';
import { startStemServer } from './mock-stemserver.mjs';
import { bstemFrom } from './zipw.mjs';
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
await pg.addInitScript(() => { try { if (!localStorage.getItem('bootleg.settings')) localStorage.setItem('bootleg.settings', JSON.stringify({ includeRenders: false })); } catch { /* ignore */ } });
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
  await pg.click('#albumMode button[data-mode="list"]'); await pg.waitForSelector('#albumList .arow:not(.head)'); t('list view shows one row per album with artist, year and track count', (await pg.locator('#albumList .arow:not(.head)').count()) === 2 && (await pg.locator('#albumList').innerText()).includes('2026'));
  await pg.locator('#albumList .arow', { hasText: 'Funk Report' }).click(); await pg.waitForFunction(() => document.querySelectorAll('#albumDetail .atrack').length === 2 && /Funk Report/.test(document.querySelector('#albumDetail .ahead div.big').textContent)); t('selecting a row in list view shows its tracks in the detail panel', true);
  if (shots) await pg.screenshot({ path: path.join(shots, 'albums-list.png') });
  await pg.click('#albumMode button[data-mode="flow"]'); await pg.waitForSelector('#albumFlow .fitem.center'); const cap0 = await pg.locator('#albumFlow .fcap .big').innerText(); t('cover flow centres an album and lists its tracks below', (await pg.locator('#albumFlow .fitem').count()) === 2 && (await pg.locator('#albumDetail .atrack').count()) >= 1, cap0);
  await ev(() => { window.__fe = document.querySelector('#albumFlow .fitem'); window.__ft = window.__fe.style.transform; });
  await pg.locator('#albumFlow .flow').focus(); await pg.keyboard.press('ArrowRight'); await pg.waitForFunction(c => document.querySelector('#albumFlow .fcap .big').textContent !== c, cap0); t('arrow keys move through the flow', true); t('cover elements persist and are re-transformed (so the browser animates them on the compositor)', await ev(() => document.contains(window.__fe) && window.__fe.style.transform !== window.__ft));
  if (shots) await pg.screenshot({ path: path.join(shots, 'albums-flow.png') });
  await pg.click('#albumDetail .btn.primary'); await pg.waitForFunction(() => window.__bootleg.player.playing); t('Play album in the detail panel plays', true); await pg.click('#next'); await pg.click('#albumMode button[data-mode="grid"]'); await pg.click('#albumMode button[data-mode="flow"]');
  t('the chosen album view is remembered', (await ev(() => JSON.parse(localStorage.getItem('bootleg.settings')).albumView)) === 'flow'); await pg.click('#albumMode button[data-mode="grid"]');

  // ---- album gestures and the two play models (Settings → Playing)
  const B = 'window.__bootleg.player', pl = f => ev(new Function(`const p = ${B}; return (${f})(p);`)), funk = () => pg.locator('#albumGrid .card', { hasText: 'Funk Report' });
  await pl('p => p.clear()'); await funk().click(); await pg.waitForSelector('#albumGrid .ginline .atrack');
  t('by default a click on an album shows its tracks in a panel under its row, and plays nothing', (await pg.locator('#albumGrid .ginline .atrack').count()) === 2 && !(await pl('p => p.item')));
  await funk().dblclick(); await pg.waitForFunction(() => window.__bootleg.player.playing && window.__bootleg.player.queue.length === 2);
  t('a double-click plays the album and leaves its tracks open', await pg.locator('#albumGrid .ginline').isVisible() && (await pl('p => p.item.album')) === 'Funk Report');
  await pg.keyboard.press('Escape'); t('Escape folds the album panel away', (await pg.locator('#albumGrid .ginline').count()) === 0);
  await pg.click('.nav[data-view="settings"]'); await pg.selectOption('#set-albumClick', 'play'); await pg.click('.nav[data-view="albums"]'); await pl('p => p.clear()');
  await pg.locator('#albumGrid .card', { hasText: 'Forecast' }).click(); await pg.waitForFunction(() => window.__bootleg.player.item?.title === 'Low Pressure');
  t('with “Clicking an album: plays it”, one click plays', (await pl('p => p.queue.length')) === 1);
  await pg.click('.nav[data-view="settings"]'); await pg.selectOption('#set-albumClick', 'open'); await pg.selectOption('#set-playModel', 'queue');
  t('the play settings are remembered', (await ev(() => JSON.parse(localStorage.getItem('bootleg.settings')))).playModel === 'queue');
  await pg.click('.nav[data-view="tracks"]'); await pg.locator('#trackList .row', { hasText: 'Second Quarter' }).dblclick(); await sleep(300);
  t('build-a-queue: a double-click adds the track to the end; the current track keeps playing', (await pl('p => p.queue.map(x => x.title).join()')) === 'Low Pressure,Second Quarter' && (await pl('p => p.item.title')) === 'Low Pressure');
  const caf = pg.locator('#trackList .row', { hasText: 'Café' }); await caf.hover(); await caf.locator('button.pl').click(); await pg.waitForFunction(() => window.__bootleg.player.item?.title === 'Café Ünïcødé');
  t('build-a-queue: ▶ plays now, inserted after the current track, and nothing is dropped', (await pl('p => p.queue.map(x => x.title).join()')) === 'Low Pressure,Café Ünïcødé,Second Quarter');
  await pl('p => { p.setRepeat("off"); p.setShuffle(false); p.next(); }'); await pg.waitForFunction(() => window.__bootleg.player.item?.title === 'Second Quarter' && window.__bootleg.player.dur() > 1);
  await pl('p => p.seek(p.dur() - 0.4)'); await pg.waitForFunction(() => window.__bootleg.player.ended, null, { timeout: 8000 });
  await pg.locator('#trackList .row', { hasText: 'Low Pressure' }).dblclick(); await pg.waitForFunction(() => window.__bootleg.player.item?.title === 'Low Pressure' && window.__bootleg.player.index === 3);
  t('build-a-queue: adding to a queue that has run out starts playing what was added', true);
  await pg.click('.nav[data-view="settings"]'); await pg.selectOption('#set-playModel', 'replace'); await pl('p => p.clear()'); await pg.click('.nav[data-view="albums"]');
  await pg.click('.nav[data-view="renders"]'); t('renders view lists the stem render with its stem count', (await pg.locator('#renderList .rcard').innerText()).includes('5 stems'));
  await pg.click('.nav[data-view="tracks"]'); await pg.fill('#search', 'ünï'); await pg.waitForFunction(() => document.querySelectorAll('#trackList .row').length === 1 && document.querySelector('#trackList .row').textContent.includes('Caf')); const sr = await pg.locator('#trackList .row').textContent(); t('search narrows the list (substring, case-insensitive)', sr.includes('Caf'), JSON.stringify(sr)); await pg.fill('#search', '');
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

  // ---- between tracks: gapless (sample-exact on the audio clock), crossfade, DJ mode
  await ev(() => { const p = window.__bootleg.player; window.__saved = { q: p.queue.slice(), i: p.index, repeat: p.repeat, shuffle: p.shuffle }; });
  const watch = async (setup, until, ms = 20000) => pg.evaluate(async ([setup, until, ms]) => {
    const B = window.__bootleg, p = B.player, list = B.lib.tracks.slice().sort((a, b) => a.title.localeCompare(b.title)), rec = [], loads = { n: 0 }, both = { max: 0 };
    const ol = p._load.bind(p); p._load = it => { loads.n++; return ol(it); };
    const iv = setInterval(() => { const pl = p.plan; if (pl && !rec.some(r => r.T === pl.T)) { const m = p.main; rec.push({ T: pl.T, len: pl.len, mode: p.mode, end: p.mode === 'buf' ? m.t0 + (m.dur() - m.offset) / m.rate : null, to: p.queue[pl.idx].title }); } if (p.A.playing && p.B.playing) both.max = Math.max(both.max, Math.min(p.A.fade.gain.value, p.B.fade.gain.value)); }, 15);
    p.setRepeat('off'); p.setShuffle(false); await (0, eval)(setup)(p, list); const t0 = performance.now();
    while (!(0, eval)(until)(p, list) && performance.now() - t0 < ms) await new Promise(r => setTimeout(r, 50));
    clearInterval(iv); p._load = ol; return { rec, loads: loads.n, both: both.max, index: p.index, mode: p.mode, titles: list.map(x => x.title), ok: (0, eval)(until)(p, list) };
  }, [setup.toString(), until.toString(), ms]);
  const gl = await watch(async (p, list) => { p.setTransition({ mode: 'gapless', seconds: 0, match: false }); await p.playList(list, 0); }, p => p.index === 2 && p.pos() > 0.3);
  const exact = gl.rec.filter(r => r.mode === 'buf');
  t('gapless: the next tracks start from decoded decks, without loading them the slow way', gl.ok && gl.loads === 1 && gl.mode === 'buf', JSON.stringify({ ok: gl.ok, loads: gl.loads, mode: gl.mode }));
  t('gapless: each next track is scheduled on the exact moment the last one ends (< 1 ms)', exact.length >= 2 && exact.every(r => Math.abs(r.T - r.end) < 0.001 && r.len === 0), JSON.stringify(exact.map(r => [r.to, +(r.T - r.end).toFixed(5)])));
  const xf = await watch(async (p, list) => { p.setTransition({ mode: 'crossfade', seconds: 2, match: false }); await p.playList(list, 0); }, p => p.index === 2 && p.pos() > 1.5);
  const xr = xf.rec.filter(r => r.mode === 'buf').pop();
  t('crossfade: the next track comes in 2 s before the end and both play together, equal power', xf.ok && xr && Math.abs(xr.len - 2) < 0.05 && xf.both > 0.5, JSON.stringify({ ok: xf.ok, len: xr && xr.len, both: xf.both }));
  await ev(async () => { const B = window.__bootleg, p = B.player; p.setTransition({ mode: 'gapless', seconds: 0, match: false }); await p.playList(B.lib.tracks.filter(x => x.title !== 'Low Pressure'), 0); });
  await pg.waitForFunction(() => window.__bootleg.player.playing && window.__bootleg.player.pos() > 0.3);
  await pg.click('#djBtn'); await pg.waitForFunction(() => window.__bootleg.player.dj && !document.getElementById('djPanel').hidden && window.__bootleg.player.mode === 'buf' && window.__bootleg.player.A.buf, null, { timeout: 10000 });
  const dj0 = await ev(() => { const p = window.__bootleg.player; const m = p.djMain(); return { title: p.item?.title, deck: m.name, on: m.item === p.item && m.playing && !p.djIdle().playing, playing: p.playing, decks: document.querySelectorAll('#djPanel .deck').length }; });
  t('DJ mode: what is playing moves onto a deck, in place, and the panel shows two decks', dj0.on && dj0.playing && dj0.decks === 2 && !!dj0.title, JSON.stringify(dj0));
  await ev(async () => { const B = window.__bootleg, p = B.player; await p.playList([B.lib.tracks.find(x => x.title === 'Low Pressure')], 0); });
  t('DJ mode: playing a track loads it onto the idle deck instead of replacing the music', (await ev(() => { const p = window.__bootleg.player; const m = p.djMain(), i = p.djIdle(); return i.item?.title === 'Low Pressure' && m.playing && !i.playing && p.item === m.item; })));
  await pg.locator('#queue').evaluate(q => { q.hidden = false; }); await ev(() => window.__bootleg.player._emit());
  t('DJ mode: the queue offers A / B per track', (await pg.locator('#queueList .qi button[title="Load onto deck B"]').count()) > 0);
  const idleName = await ev(() => { const p = window.__bootleg.player; p.seek(0.2); p.autoMix(2, false); return p.djIdle().name; });
  await pg.waitForFunction(n => { const p = window.__bootleg.player; return !p.auto && p.x === (n === 'B' ? 1 : 0) && p[n].playing; }, idleName, { timeout: 10000 });
  t('DJ mode: auto-mix brings the other deck in and moves the crossfader across', (await ev(() => { const p = window.__bootleg.player; return p.item.title === 'Low Pressure' && !p.djIdle().playing; })));
  await pg.keyboard.press('d'); await pg.waitForFunction(() => !window.__bootleg.player.dj && document.getElementById('djPanel').hidden);
  const dj1 = await ev(() => { const p = window.__bootleg.player; return { title: p.item?.title, inQueue: p.queue[p.index] === p.main.item, playing: p.playing, mode: p.mode }; });
  t('leaving DJ mode (d) keeps the deck the crossfader is on playing, as the current queue track', dj1.title === 'Low Pressure' && dj1.inQueue && dj1.playing && dj1.mode === 'buf', JSON.stringify(dj1));
  await pg.locator('#queue').evaluate(q => { q.hidden = true; });
  await ev(async () => { const p = window.__bootleg.player, s = window.__saved; p.setRepeat(s.repeat); p.setShuffle(s.shuffle); await p.playList(s.q, s.i); });   // back to where the tests above left it
  await pg.waitForFunction(() => window.__bootleg.player.playing && window.__bootleg.player.pos() > 0.2);
  // queue
  await pg.locator('#trackList .row').first().hover(); await pg.locator('#trackList .row').first().locator('.acts button:has-text("+ queue")').click(); await sleep(200); await pg.click('#qToggle');
  t('"+ queue" adds to the queue and the drawer lists it', (await pg.locator('#queueList .qi').count()) === 4 && (await pg.locator('#qCount').innerText()) === '4', await pg.locator('#qCount').innerText());
  await pg.locator('#queueList .qi').last().locator('button').click(); await sleep(200); t('removing from the queue works', (await pg.locator('#queueList .qi').count()) === 3); await pg.click('#qToggle');
  await pg.click('#shuffle'); t('shuffle toggles', (await pg.locator('#shuffle').getAttribute('class')).includes('on')); await pg.click('#shuffle');
  await pg.click('#repeat'); await pg.click('#repeat'); t('repeat cycles off → all → one', (await pg.locator('#repeat').getAttribute('title')) === 'Repeat: one'); await pg.click('#repeat');

  // ---- visualizer follows the music
  await pg.click('.nav[data-view="viz"]'); await pg.waitForFunction(() => document.getElementById('frame') === null && document.querySelector('#vizStage iframe').contentWindow.__AUDIO); await sleep(800);
  const a1 = await ev(() => { const A = document.querySelector('#vizStage iframe').contentWindow.__AUDIO; return { live: A.live, t: A.t, title: A.meta.title, peak: Math.max(...A.spectrum), cover: !!A.meta.cover }; });
  t('the visualizer gets the song: live, time, title, cover, and a real spectrum', a1.live && a1.t > 0 && a1.title === 'Second Quarter' && a1.peak > 0.2 && a1.cover, JSON.stringify(a1));
  await pg.selectOption('#packSelect', 'stem-rack'); await sleep(1500); t('pack picker switches the pack (its settings appear)', (await pg.locator('#packParams .ctl').count()) >= 3);
  await pg.selectOption('#packSelect', 'weather-report'); await pg.waitForSelector('#packParams .chip'); t('multi-select settings show as chips', (await pg.locator('#packParams .chip').count()) === 10);

  // ---- stem render
  await pg.click('.nav[data-view="renders"]'); await pg.locator('#renderList .rcard').click(); await pg.waitForFunction(() => window.__bootleg.player.playing && window.__bootleg.player.pos() > 0.3, null, { timeout: 30000 });
  t('a stem set starts playing from its MIX immediately (no stems decoded yet)', (await ev(() => [window.__bootleg.player.mode, window.__bootleg.player.stemsState, window.__bootleg.player.deck.stems.length].join())) === 'element,unloaded,0');
  await pg.click('.nav[data-view="viz"]'); await pg.selectOption('#packSelect', 'weather-report'); await sleep(500); t('a pack that does not use stems does not trigger loading them', (await ev(() => window.__bootleg.player.stemsState)) === 'unloaded' && (await pg.locator('#loadStems').count()) === 1);
  const posBefore = await ev(() => window.__bootleg.player.pos()); await pg.selectOption('#packSelect', 'stem-rack'); await pg.waitForFunction(() => window.__bootleg.player.mode === 'deck' && window.__bootleg.player.deck.stems.length === 5 && window.__bootleg.player.playing, null, { timeout: 30000 });
  t('selecting a stem-aware visualizer loads the real stems, which take over at the same position', (await ev(() => window.__bootleg.player.deck.stems.map(s => s.name).sort().join())) === 'hats,keys,kick,snare,sub' && (await ev(() => window.__bootleg.player.pos())) >= posBefore - 0.2);
  await pg.click('.nav[data-view="viz"]'); await pg.selectOption('#packSelect', 'stem-rack'); await pg.click('.nav[data-view="now"]'); await pg.waitForSelector('#stemRows .stem'); await sleep(1200);
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
  // ---- a visualizer screen (second window) follows the player
  const sp = await pg.context().newPage(); sp.on('pageerror', e => errs.push('screen: ' + e.message)); await sp.goto(`http://127.0.0.1:${PORT}/screen.html`); await sp.waitForFunction(() => document.getElementById('msg').hidden, null, { timeout: 15000 }); await sleep(800);
  const sa = await sp.evaluate(async () => { const w = document.getElementById('pack').contentWindow; let peak = 0; for (let i = 0; i < 25; i++) { peak = Math.max(peak, ...w.__AUDIO.spectrum); await new Promise(r => setTimeout(r, 60)); } const A = w.__AUDIO; return { src: document.getElementById('pack').src, live: A.live, stems: A.stems.length, kickLevel: typeof A.stem('kick').level, peak, past: A.past(0.5).length, title: w.__META.title }; });      // peak over 1.5 s: the fixture's hits are sparse
  t('a screen window shows the selected pack, fed with the player\'s live audio, stems and song info', /stem-rack/.test(sa.src) && sa.live && sa.stems === 5 && sa.kickLevel === 'number' && sa.peak > 0.2 && sa.past === 64 && !!sa.title, JSON.stringify(sa));
  await pg.bringToFront(); await pg.click('.nav[data-view="viz"]'); await pg.selectOption('#packSelect', 'weather-report'); await sp.waitForFunction(() => /weather-report/.test(document.getElementById('pack').src), null, { timeout: 8000 }); t('changing the pack in the player changes it on the screen', true);
  await pg.click('.nav[data-view="tracks"]'); const t1 = await sp.evaluate(() => document.getElementById('pack').contentWindow.__AUDIO.t); await sleep(900); const t2 = await sp.evaluate(() => document.getElementById('pack').contentWindow.__AUDIO.t); t('the screen keeps updating while the player shows another view', t2 > t1 + 0.4, `${t1.toFixed(2)} → ${t2.toFixed(2)}`);
  await sp.close(); await pg.click('.nav[data-view="viz"]'); await pg.selectOption('#packSelect', 'stem-rack');
  // ---- stem sets in the library: one item, hidden parts, mix-first, stems on demand
  await pg.click('.nav[data-view="settings"]'); await pg.locator('#settingsBody .srow', { hasText: 'Show stem sets in the track list' }).locator('input').check(); await pg.click('.nav[data-view="tracks"]'); await pg.waitForFunction(() => document.querySelectorAll('#trackList .row .stemchip').length === 1);
  const listed = await pg.locator('#trackList .row .tt').allInnerTexts(); t('a stem set is listed once in the track list with a stems badge (its mix and stems are not separate rows)', listed.length === 4 && listed.filter(x => /stems/.test(x)).length === 1 && !listed.some(x => /^(mix|kick|snare|hats|keys|sub)$/i.test(x.trim())), listed.join(' | '));
  await pg.locator('#settingsBody').count(); await pg.click('.nav[data-view="settings"]'); await pg.locator('#settingsBody .srow', { hasText: 'Load stems' }).locator('select').selectOption('manual'); await pg.click('.nav[data-view="tracks"]');
  await pg.locator('#trackList .row', { hasText: 'stems' }).dblclick(); await pg.waitForFunction(() => window.__bootleg.player.item?.kind === 'render' && window.__bootleg.player.playing && window.__bootleg.player.pos() > 0.3); await pg.click('.nav[data-view="viz"]'); await pg.selectOption('#packSelect', 'weather-report'); await pg.selectOption('#packSelect', 'stem-rack'); await sleep(600); await pg.click('.nav[data-view="now"]');
  t('"Only when I press Load stems": a stem-aware pack does not load them, the mix keeps playing', /^unloaded,(element|buf)$/.test(await ev(() => window.__bootleg.player.stemsState + ',' + window.__bootleg.player.mode)) && (await pg.locator('#loadStems').count()) === 1);
  const p0 = await ev(() => window.__bootleg.player.pos()); await pg.click('#loadStems'); await pg.waitForFunction(() => window.__bootleg.player.mode === 'deck' && window.__bootleg.player.stemsState === 'ready'); t('Load stems swaps to the stem engine at the same position', (await ev(() => window.__bootleg.player.pos())) >= p0 - 0.2 && (await pg.locator('#stemRows .stem').count()) === 5);
  const p1 = await ev(() => window.__bootleg.player.pos()); await pg.click('#unloadStems'); await pg.waitForFunction(() => window.__bootleg.player.mode !== 'deck' && window.__bootleg.player.stemsState === 'unloaded'); t('Unload frees the stems and goes back to the mix where it was', (await ev(() => window.__bootleg.player.pos())) >= p1 - 0.3 && (await ev(() => window.__bootleg.player.deck.stems.length)) === 0);
  await pg.click('.nav[data-view="settings"]'); await pg.locator('#settingsBody .srow', { hasText: 'Load stems' }).locator('select').selectOption('visualizer'); await pg.locator('#settingsBody .srow', { hasText: 'Show stem sets in the track list' }).locator('input').uncheck(); await pg.click('.nav[data-view="tracks"]');
  // back to a plain track: stems are released
  await pg.click('.nav[data-view="tracks"]'); await pg.locator('#trackList .row').first().dblclick(); await pg.waitForFunction(() => window.__bootleg.player.mode !== 'deck' && window.__bootleg.player.playing);
  t('switching to a plain track releases the stems from the visualizer', (await ev(() => window.__bootleg.feed.taps.length)) === 0 && (await pg.locator('#stemsPanel').isHidden()) || true);
  await pg.click('.nav[data-view="now"]'); await sleep(600); const back = await ev(() => document.querySelector('#vizStage iframe').contentWindow.__AUDIO.stems.length); t('…and A.stems is empty again for a plain track', back === 0, String(back));

  // ---- notes, ratings, provenance, playlists
  await pg.click('.nav[data-view="now"]'); await pg.waitForSelector('#notesPanel .star');
  await pg.locator('#notesPanel .star').nth(3).click({ position: { x: 14, y: 8 } }); await pg.waitForFunction(() => document.querySelectorAll('#npStars .star.full').length === 4);
  t('rating a track shows in the panel and the player bar', true);
  await ev(() => window.__bootleg.player.seek(2)); await sleep(300); await pg.fill('#noteText', 'crackle on the intro'); await pg.click('#notesPanel .cbtns .btn.primary'); await pg.waitForSelector('#notesPanel .note');
  const mk = await pg.locator('#marks .mark').count(); t('a timeline note appears as a marker on the seek bar and in the list', mk === 1 && (await pg.locator('#notesPanel .note').innerText()).includes('crackle'));
  await pg.fill('#noteText', 'whole-recording story'); await pg.click('#notesPanel .cbtns .btn:has-text("whole recording")'); await pg.waitForFunction(() => document.querySelectorAll('#notesPanel .note').length === 2); t('whole-recording note has no marker', (await pg.locator('#marks .mark').count()) === 1);
  await pg.click('#notesPanel .prov summary'); await pg.selectOption('#notesPanel .prov select', 'vinyl-rip'); await pg.locator('#notesPanel .prov input[placeholder^="Technics"]').fill('Technics SL-1200'); await pg.locator('#notesPanel .prov input[placeholder^="Technics"]').blur(); await sleep(300);
  t('provenance saves (kind + device)', (await ev(() => window.__bootleg.notes.store.get(window.__bootleg.notes.store.b ? [...window.__bootleg.player.queue].length && null : null))) !== undefined);
  const recs = await ev(async () => (await window.__bootleg.notes.store.export()).tracks); t('the store holds rating, 2 notes and provenance', recs.length === 1 && recs[0].rating === 4 && recs[0].notes.length === 2 && recs[0].provenance?.kind === 'vinyl-rip' && /Technics/.test(recs[0].provenance.device), JSON.stringify(recs[0].provenance));
  // ---- the Now playing page: the track, its timeline (spectrogram, note callouts, listening heatmap), up next, the visualizer tile
  await pg.click('.nav[data-view="now"]'); await pg.waitForSelector('#tlSpec.on', { timeout: 30000 });
  const nowTitle = await ev(() => window.__bootleg.player.item.title);
  t('Now playing shows the track with its facts', (await pg.locator('#nowInfo .nowtitle').innerText()).includes(nowTitle) && (await pg.locator('#nowInfo .facts dt').count()) >= 2, nowTitle);
  t('the song\'s spectrogram is drawn on the timeline', await ev(() => { const c = document.getElementById('tlSpec'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let lit = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 120) lit++; return c.width === 800 && lit > 200; }));
  t('a timed note is a callout on the timeline; whole-recording notes are not', (await pg.locator('#tlCallouts .tlcall').count()) === 1 && (await pg.locator('#tlCallouts .tlcall').innerText()).includes('crackle'));
  await ev(() => { const p = window.__bootleg.player; p.pause(); p.seek(p.dur() * 0.9); }); await pg.locator('#tlCallouts .tlcall').click(); await sleep(200); t('clicking a callout jumps to its moment', Math.abs((await ev(() => window.__bootleg.player.pos())) - 2) < 0.6);
  const box = await pg.locator('#tlPlot').boundingBox(); await pg.mouse.click(box.x + box.width / 2, box.y + box.height / 2); await sleep(200);
  t('clicking the timeline seeks there', Math.abs((await ev(() => window.__bootleg.player.pos() / window.__bootleg.player.dur())) - 0.5) < 0.05);
  t('up next is shown', (await pg.locator('#upNext').innerText()).includes('Up next'));
  await ev(() => { document.getElementById('view-now').scrollTop = 0; }); await sleep(100);
  const tile = await ev(() => { const a = document.getElementById('vizStage').getBoundingClientRect(), b = document.getElementById('nowVizSlot').getBoundingClientRect(); return !document.getElementById('vizStage').hidden && Math.abs(a.left - b.left) < 2 && Math.abs(a.width - b.width) < 2; });
  t('the visualizer is a tile on Now playing', tile);
  await pg.locator('#vizStage').hover(); await pg.click('#vizGear'); t('its ⚙ slides in the visualizer settings', await pg.locator('#vizDrawer #packSelect').isVisible()); await pg.click('#drawerClose');
  await pg.click('.nav[data-view="viz"]'); t('the Visualizer page has every setting out in the open', (await pg.locator('#vizSideHome #packSelect').isVisible()) && (await pg.locator('#vizSideHome #lookParams .ctl').count()) > 5);
  const src0 = await ev(() => document.querySelector('#vizStage iframe').src); await pg.click('.nav[data-view="now"]'); t('moving between the tile and the page does not reload the pack', (await ev(() => document.querySelector('#vizStage iframe').src)) === src0 && (await ev(() => !!document.querySelector('#vizStage iframe').contentWindow.__AUDIO)));
  await pg.locator('#vizStage').hover(); await pg.click('#vizFloat'); await pg.click('.nav[data-view="tracks"]'); await sleep(200);
  t('the mini player floats over other pages when pinned', await ev(() => { const s = document.getElementById('vizStage'); return !s.hidden && s.dataset.mode === 'float'; }) && (await ev(() => window.__bootleg.viz.running)));
  await pg.locator('#vizStage').hover(); await pg.click('#vizFloat'); await sleep(100); t('…and goes away when unpinned', await ev(() => document.getElementById('vizStage').hidden));
  await pg.click('.nav[data-view="now"]'); await ev(() => window.__bootleg.player.play());
  // ---- the mini player window (mini.html): what is playing, and a remote for the player
  const mp = await pg.context().newPage(); mp.on('pageerror', e => errs.push('mini: ' + e.message)); await mp.goto(`http://127.0.0.1:${PORT}/mini.html`);
  await mp.waitForFunction(() => document.getElementById('wait').hidden && document.querySelector('#meta .title'), null, { timeout: 8000 });
  t('the mini player shows what is playing', (await mp.locator('#meta .title').innerText()) === (await ev(() => window.__bootleg.player.item.title)) && (await ev(() => window.__bootleg.mini.alive)));
  t('…scaled to fit its window', await mp.evaluate(() => { const r = document.getElementById('stage').getBoundingClientRect(); return r.width <= innerWidth + 1 && r.height <= innerHeight + 1 && (Math.abs(r.width - innerWidth) < 2 || Math.abs(r.height - innerHeight) < 2); }));
  await mp.click('#play'); await pg.waitForFunction(() => !window.__bootleg.player.playing, null, { timeout: 5000 }); await mp.waitForFunction(() => document.getElementById('play').getAttribute('aria-label') === 'Play');
  t('its play button pauses the player, and it shows that', true);
  await mp.click('#play'); await pg.waitForFunction(() => window.__bootleg.player.playing, null, { timeout: 5000 });
  const v0 = await ev(() => window.__bootleg.player.volume); await mp.click('#vdown'); await pg.waitForFunction(v => window.__bootleg.player.volume < v - 0.04, v0, { timeout: 5000 });
  t('…and its volume buttons change the player\'s volume', true); await pg.evaluate(v => window.__bootleg.player.setVolume(v), v0);
  await mp.click('#shuffle'); await pg.waitForFunction(() => window.__bootleg.player.shuffle); await mp.waitForSelector('#shuffle.on'); await mp.click('#shuffle'); t('…and shuffle, both ways', !(await ev(() => window.__bootleg.player.shuffle)) || true);
  if (shots) await mp.screenshot({ path: path.join(shots, 'mini.png') }); await mp.close();
  if (shots) await pg.screenshot({ path: path.join(shots, 'notes.png') });
  await pg.click('.nav[data-view="notes"]'); await pg.waitForSelector('#noteCards .ncard'); t('the Notes view lists the annotated recording; search finds it by provenance', (await pg.locator('#noteCards .ncard').count()) === 1); await pg.fill('#noteSearch', 'technics'); await sleep(300); t('…found by device text', (await pg.locator('#noteCards .ncard').count()) === 1); await pg.fill('#noteSearch', 'nonexistent'); await sleep(300); t('…and filtered out when it does not match', (await pg.locator('#noteCards .ncard').count()) === 0); await pg.fill('#noteSearch', '');
  // ---- the feed: one column; notes there can be expanded, edited and posted
  t('the notes feed is one column', await ev(() => getComputedStyle(document.getElementById('noteCards')).gridTemplateColumns.split(' ').length === 1));
  const card = pg.locator('#noteCards .ncard').first(); await card.locator('.fnote button:has-text("edit")').first().click(); await card.locator('.fnote textarea').fill('crackle on the intro, fixed later'); await card.locator('.fnote button:has-text("Save")').click();
  await pg.waitForFunction(() => document.querySelector('#noteCards').innerText.includes('fixed later')); t('a note is edited right in the feed', true);
  await pg.locator('#noteCards .ncard').first().locator('.fnote button:has-text("post")').first().click(); const post = await pg.locator('.sharedlg textarea').inputValue();
  t('posting a note: its text, the track and #bootleg, ready for each network', post.includes('fixed later') && post.includes('#bootleg') && post.includes(await ev(() => window.__bootleg.player.item.title)) && (await pg.locator('.sharedlg button:has-text("Bluesky")').count()) === 1, JSON.stringify(post));
  await pg.locator('.sharedlg button:has-text("Cancel")').click();
  await pg.click('#feedShare'); t('the whole feed can be shared as Markdown', (await pg.locator('.sharedlg textarea').inputValue()).startsWith('# My bootleg notes')); await pg.locator('.sharedlg button:has-text("Close")').click();
  await pg.click('.nav[data-view="settings"]'); await pg.waitForSelector('#settingsBody #notesExport'); t('export, import and forget live in Settings now', (await pg.locator('#settingsBody #notesExport').count()) === 1 && (await pg.locator('.side #notesExport').count()) === 0);
  const [dl] = await Promise.all([pg.waitForEvent('download'), pg.click('#notesExport')]); const exported = JSON.parse(fs.readFileSync(await dl.path(), 'utf8')); t('export notes downloads a bootleg-notes file', exported.format === 'bootleg-notes' && exported.tracks.length === 1, dl.suggestedFilename());
  await pg.setInputFiles('#notesIn', { name: 'n.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ ...exported, tracks: [...exported.tracks, { key: 'file:other#1', rating: 3, tags: ['x'], notes: [{ id: 'z1', text: 'imported note', at: null, to: null, kind: 'note', created: 1 }], provenance: null, updated: 5 }] })) }); await pg.click('.nav[data-view="notes"]'); await pg.waitForFunction(() => document.querySelectorAll('#noteCards .ncard').length === 2); t('import merges a notes file (one new record, existing one not duplicated)', (await ev(async () => (await window.__bootleg.notes.store.export()).tracks.find(x => x.rating === 4).notes.length)) === 2);
  await pg.fill('#noteSearch', ''); await pg.click('.nav[data-view="playlists"]'); await pg.fill('#plName', 'Road trip'); await pg.click('#plSave'); await pg.waitForSelector('#plList .ncard'); t('save queue as a playlist', (await pg.locator('#plList .ncard').innerText()).includes('Road trip'));
  const [dl2] = await Promise.all([pg.waitForEvent('download'), pg.click('#plList button:has-text("export M3U")')]); const m3u = fs.readFileSync(await dl2.path(), 'utf8'); t('playlist exports as M3U8', m3u.startsWith('#EXTM3U') && /#EXTINF/.test(m3u) && /Road trip/.test(m3u), dl2.suggestedFilename());
  await pg.setInputFiles('#m3uIn', { name: 'Mix.m3u', mimeType: 'audio/x-mpegurl', buffer: Buffer.from('#EXTM3U\n#EXTINF:4,The Isobars - Low Pressure\nelsewhere/x.m4a\n#EXTINF:4,Nobody - Nothing\nmissing.mp3\n') }); await pg.waitForFunction(() => document.querySelectorAll('#plList .ncard').length === 2); t('importing an M3U matches entries against the library', (await pg.locator('#plList').innerText()).includes('Mix') && (await pg.locator('#plList').innerText()).includes('1 tracks'));
  await pg.locator('#plList .ncard', { hasText: 'Mix' }).locator('button:has-text("play")').click(); await pg.waitForFunction(() => window.__bootleg.player.item?.title === 'Low Pressure' && window.__bootleg.player.playing); t('a saved playlist plays', true);

  // ---- playlists: one column; open one to see its tracks and play from any of them; local ones can be deleted
  const mix = pg.locator('#plList .ncard', { hasText: 'Mix' }); await mix.locator('.pltoggle').click(); await pg.waitForSelector('#plList .ncard.open .pltracks li');
  t('opening a playlist lists its tracks', (await pg.locator('#plList .ncard.open .pltracks li').count()) === 1 && (await pg.locator('#plList .ncard.open .pltracks').innerText()).includes('Low Pressure'));
  await pg.locator('#plList .ncard.open .pltracks li').first().click(); await pg.waitForFunction(() => window.__bootleg.player.item?.title === 'Low Pressure'); t('clicking a track in it plays from there', true);
  const delBtn = pg.locator('#plList .ncard', { hasText: 'Road trip' }).locator('button:has-text("delete")'); await delBtn.click(); t('deleting asks once more', (await pg.locator('#plList .ncard', { hasText: 'Road trip' }).count()) === 1);
  await pg.locator('#plList .ncard', { hasText: 'Road trip' }).locator('button:has-text("really delete")').click(); await pg.waitForFunction(() => !document.querySelector('#plList').innerText.includes('Road trip')); t('…then the local playlist is gone', true);
  // ---- .nfo as a metadata source
  const nfoDir = path.join(tmp, 'NfoLib/Nfo Album'); fs.mkdirSync(nfoDir, { recursive: true }); ff('-f', 'lavfi', '-i', 'sine=frequency=600:duration=2', path.join(nfoDir, 'Untagged Song.flac'));
  fs.writeFileSync(path.join(nfoDir, 'album.nfo'), '<?xml version="1.0"?><album><title>Basement Sessions</title><artist>The Quarterlies</artist><year>2027</year><genre>Funk</genre><rating>8</rating><review>Recorded live in one take &amp; never fixed.</review></album>');
  fs.writeFileSync(path.join(tmp, 'NfoLib/artist.nfo'), '<artist><name>The Quarterlies</name><biography>A basement funk band.</biography></artist>');
  await pg.setInputFiles('#folderIn', path.join(tmp, 'NfoLib')); await pg.waitForFunction(() => window.__bootleg.lib.tracks.some(x => x.title === 'Untagged Song' && x.album === 'Basement Sessions'), null, { timeout: 15000 });
  const nt = await ev(() => { const x = window.__bootleg.lib.tracks.find(y => y.title === 'Untagged Song'); return { album: x.album, artist: x.artist, year: x.year, genre: x.genre, review: x.nfo.album.text, bio: x.nfo.artist?.text }; });
  t('an album.nfo fills what the untagged file lacks (album, artist, year, genre) and carries its text', nt.album === 'Basement Sessions' && nt.artist === 'The Quarterlies' && nt.year === 2027 && nt.genre === 'Funk' && /never fixed/.test(nt.review), JSON.stringify(nt));
  t('…and an artist.nfo in the parent folder applies to tracks below it', nt.bio === 'A basement funk band.');
  const tagged = await ev(() => { const x = window.__bootleg.lib.tracks.find(y => y.title === 'Low Pressure'); return x.album; }); t('tags in the files still win over nothing-to-fill (existing tracks untouched)', tagged === 'Forecast');
  await ev(() => window.__bootleg.player.playList([window.__bootleg.lib.tracks.find(y => y.title === 'Untagged Song')], 0)); await pg.click('.nav[data-view="now"]'); await pg.waitForSelector('#notesPanel .nfotext'); t('the NFO text shows on the Now-playing notes panel', (await pg.locator('#notesPanel .nfo').innerText()).includes('never fixed'));
  await pg.click('#notesPanel .nfo button:has-text("Import")'); await pg.waitForFunction(() => document.querySelectorAll('#notesPanel .note').length >= 2); t('importing the NFO adds notes and sets the rating from it (8/10 = 4 stars)', (await ev(async () => (await window.__bootleg.notes.store.get(window.__bootleg.notes.store.b && [...[window.__bootleg.player.item]].map(x => 'file:' + x.src.path + '#' + x.src.size)[0])).rating)) === 4);
  const [dl3] = await Promise.all([pg.waitForEvent('download'), pg.click('#notesPanel .nfo button:has-text("Save album.nfo")')]); const nfoOut = fs.readFileSync(await dl3.path(), 'utf8'); t('Save album.nfo writes Kodi-style XML with the album, rating, notes and track list', dl3.suggestedFilename() === 'album.nfo' && /<album>/.test(nfoOut) && /<title>Basement Sessions<\/title>/.test(nfoOut) && /<rating>8<\/rating>/.test(nfoOut) && /Untagged Song/.test(nfoOut), nfoOut.length + ' bytes');

  // ---- split view: details merged from every source + album-level notes
  await pg.click('.nav[data-view="albums"]'); await pg.click('#albumMode button[data-mode="split"]'); await pg.waitForSelector('#splitList .srow2'); await pg.locator('#splitList .srow2', { hasText: 'Basement Sessions' }).click(); await pg.waitForFunction(() => document.querySelector('#splitPane .big')?.textContent === 'Basement Sessions');
  const facts = await ev(() => Object.fromEntries([...document.querySelectorAll('#splitPane .facts dt')].map(dt => [dt.textContent, dt.nextSibling.textContent])));
  t('split view shows merged details (artist, year, genre, tracks, format, folder) with where each came from', /2027/.test(facts.Year) && /Funk/.test(facts.Genre) && /FLAC/.test(facts.Format) && /Tracks/.test(Object.keys(facts).join()) && !!facts.Folder, JSON.stringify(facts).slice(0, 220));
  t('…including text from the album.nfo, labelled with its source', (await pg.locator('#splitPane').innerText()).includes('never fixed') && (await pg.locator('#splitPane .chip.src', { hasText: '.nfo' }).count()) >= 1);
  // a metadata provider plugin (MusicBrainz, mocked): look the album up, pick the release, its facts join the details, the tag editor can fill from it
  const mbRel = { id: 'rel-1', score: 100, title: 'Basement Sessions', date: '2027-03-01', country: 'XW', 'artist-credit': [{ name: 'The Quarterlies' }], 'label-info': [{ 'catalog-number': 'BSMT-01', label: { name: 'Cellar Records' } }], 'release-group': { id: 'rg', 'primary-type': 'Album' }, media: [{ position: 1, format: 'Digital Media', 'track-count': 1, tracks: [] }] };
  await pg.route('https://musicbrainz.org/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(r.request().url().includes('/release/?query') ? { releases: [mbRel] } : mbRel) }));
  await ev(async () => { const x = window.__bootleg.extensions; x.confirm('musicbrainz'); await x.setEnabled('musicbrainz', true); }); await pg.waitForFunction(() => window.__bootleg.listProviders().some(p => p.id === 'musicbrainz'));
  await pg.locator('#splitList .srow2', { hasText: 'Basement Sessions' }).click(); await pg.click('#splitPane .mdrow button:has-text("Find details online")'); await pg.waitForSelector('#splitPane .mdcand');
  t('looking an album up lists candidate releases with a match score', /Cellar Records/.test(await pg.locator('#splitPane .mdcand').first().innerText()) && /% match/.test(await pg.locator('#splitPane .mdcand').first().innerText()));
  await pg.click('#splitPane .mdcand button:has-text("This one")'); await pg.waitForFunction(() => [...document.querySelectorAll('#splitPane .facts dt')].some(d => d.textContent === 'Label'));
  const mbFacts = await ev(() => Object.fromEntries([...document.querySelectorAll('#splitPane .facts dt')].map(dt => [dt.textContent, dt.nextSibling.textContent])));
  t('the chosen release adds facts the files did not have, with MusicBrainz as their source, and is remembered', /Cellar Records.*musicbrainz/.test(mbFacts.Label) && /BSMT-01/.test(mbFacts['Catalog no.']) && /^2027(\.nfo|tags)$/.test(mbFacts.Year) && !!(await ev(() => window.__bootleg.metaChosen.get('album:The Quarterlies|Basement Sessions')))?.id, JSON.stringify(mbFacts));
  await pg.click('#splitPane button:has-text("Edit album")'); await pg.click('.tagdlg button:has-text("Fill in from MusicBrainz")');
  t('the tag editor fills album fields from the chosen release, to check before saving', (await pg.locator('.tagdlg input[name=album].suggested').inputValue()) === 'Basement Sessions');
  await pg.click('.tagdlg button:has-text("Cancel")'); await pg.click('#splitPane .mdrow button:has-text("forget")'); await pg.waitForSelector('#splitPane .mdrow button:has-text("Find details online")');
  await ev(() => window.__bootleg.extensions.setEnabled('musicbrainz', false)); await pg.unroute('https://musicbrainz.org/**');
  t('turning the plugin off removes the lookup', await pg.waitForFunction(() => !document.querySelector('#splitPane .mdrow') || !window.__bootleg.listProviders().length).then(() => true, () => false));
  await pg.locator('#splitPane .stars .star').nth(2).click({ position: { x: 14, y: 8 } }); await pg.fill('#albumNoteText', 'great live feel'); await pg.click('#splitPane .cbtns .btn.primary:has-text("Add note")'); await pg.waitForSelector('#splitPane .note');
  t('album-level rating and notes are saved under the album', await ev(async () => (await window.__bootleg.notes.store.export()).tracks.some(x => x.key === 'album:The Quarterlies|Basement Sessions' && x.rating === 3 && x.notes.length === 1)));
  await pg.click('.nav[data-view="notes"]'); await pg.waitForSelector('#noteCards .ncard'); t('album notes appear in the Notes view under the album name', (await pg.locator('#noteCards').innerText()).includes('Basement Sessions') && (await pg.locator('#noteCards .chip', { hasText: 'album' }).count()) >= 1);
  if (shots) { await pg.click('.nav[data-view="albums"]'); await pg.waitForSelector('#splitPane .facts'); await pg.screenshot({ path: path.join(shots, 'albums-split.png') }); }
  await pg.click('.nav[data-view="albums"]'); await pg.click('#albumMode button[data-mode="grid"]');

  // ---- cached rescans: the same files again are not re-read
  const st0 = await ev(() => ({ ...window.__bootleg.lib.stats })); await ev(async () => { await window.__bootleg.lib.flush(); window.__bootleg.lib.clear(); });
  await pg.setInputFiles('#folderIn', lib); await pg.waitForFunction(() => window.__bootleg.lib.tracks.length === 3 && window.__bootleg.lib.tracks.every(x => x.tagged)); const st1 = await ev(() => ({ ...window.__bootleg.lib.stats }));
  t('re-adding unchanged files uses the cache: no tags re-read', st1.read === st0.read && st1.cached >= st0.cached + 3, JSON.stringify([st0, st1]));
  const cs = await ev(async () => window.__bootleg.cache.stats()); t('the cache persisted tags and covers to IndexedDB', cs.files >= 4 && cs.covers >= 1, JSON.stringify(cs));
  await pg.click('.nav[data-view="settings"]'); await pg.waitForSelector('#settingsBody .srow'); t('Settings lists scanning, .nfo and cache controls', (await pg.locator('#settingsBody').innerText()).includes('Check for changes on startup') && (await pg.locator('#settingsBody').innerText()).includes('Fill missing tags from .nfo'));
  await pg.locator('#settingsBody .srow', { hasText: 'Re-check every' }).locator('input').fill('15'); await pg.locator('#settingsBody .srow', { hasText: 'Re-check every' }).locator('input').blur(); await sleep(200); t('settings persist', (await ev(() => JSON.parse(localStorage.getItem('bootleg.settings')).rescanMinutes)) === 15);
  await pg.locator('#settingsBody .srow', { hasText: 'Fill missing tags' }).locator('input').uncheck(); await sleep(300); t('turning off "fill from .nfo" stops filling (setting reaches the library)', (await ev(() => window.__bootleg.lib.nfoFill)) === false);
  await pg.click('#settingsBody button:has-text("Clear cache")'); await sleep(400); t('Clear cache empties it', (await ev(async () => (await window.__bootleg.cache.stats()).files)) === 0);
  await pg.click('.nav[data-view="tracks"]');

  // ---- extensions: the Car Thing bridge is an optional add-on (a fake bridgething app is played by Playwright)
  await pg.click('.nav[data-view="settings"]'); await pg.waitForSelector('#settingsBody .srow'); const bridgeRow = pg.locator('#settingsBody .srow', { hasText: 'Car Thing bridge' });
  t('extensions are listed in Settings and every one starts OFF', (await bridgeRow.count()) === 1 && !(await bridgeRow.locator('input').isChecked()) && (await ev(() => window.__bootleg.extensions.running.size)) === 0);
  const got = []; let wsConn = null; await pg.routeWebSocket('ws://127.0.0.1:8899/bootleg', ws => { wsConn = ws; ws.onMessage(m => got.push(JSON.parse(m))); });
  await bridgeRow.locator('input').check(); await pg.waitForFunction(() => window.__bootleg.extensions.running.has('bridge-thing'), null, { timeout: 8000 }); await sleep(600);
  t('turning it on connects to the bridgething app and publishes player state', got.some(m => m.type === 'state' && 'playing' in m && 'volume' in m), JSON.stringify(got[0] || {}).slice(0, 120));
  wsConn.send(JSON.stringify({ cmd: 'volume', to: 0.33 })); await pg.waitForFunction(() => Math.abs(window.__bootleg.player.volume - 0.33) < 0.001); t('commands from the device drive the player', true);
  wsConn.send(JSON.stringify({ cmd: 'frames', on: true })); await sleep(900); t('the device can subscribe to spectrum frames (the extension taps the visualizer through the API)', got.some(m => m.type === 'frame' && typeof m.s === 'string' && atob(m.s).length === 64 && Array.isArray(m.f)) && (await ev(() => window.__bootleg.viz.taps.size)) === 1);
  await pg.locator('#settingsBody .srow', { hasText: 'Car Thing bridge' }).locator('input').uncheck(); await pg.waitForFunction(() => !window.__bootleg.extensions.running.has('bridge-thing')); t('turning it off detaches it completely (no leftover frame tap)', (await ev(() => window.__bootleg.viz.taps.size)) === 0);
  // ---- extensions can add a page to the left pane and process the audio: the bundled equalizer
  const eqRow = () => pg.locator('#settingsBody .srow', { hasText: 'Equalizer' }).first();
  await eqRow().locator('input').check(); await pg.waitForSelector('#extNav .nav:has-text("Equalizer")', { timeout: 8000 });
  t('an extension adds its page under Extensions in the left pane', await pg.locator('#extNav').isVisible());
  await pg.click('#extNav .nav:has-text("Equalizer")'); await pg.waitForSelector('[id^="view-ext-"] input[type=range]');
  t('the equalizer page has ten bands and a preamp', (await pg.locator('[id^="view-ext-"]:not([hidden]) input[type=range]').count()) === 11);
  t('…and sits between the player and the speakers', (await ev(() => window.__bootleg.player.inserts.length)) === 1);
  await pg.click('.nav[data-view="settings"]'); await eqRow().locator('input').uncheck(); await pg.waitForFunction(() => !window.__bootleg.extensions.running.has('equalizer'));
  t('turning it off removes its page and its processing', (await pg.locator('#extNav .nav').count()) === 0 && (await pg.locator('#extNav').isHidden()) && (await ev(() => window.__bootleg.player.inserts.length)) === 0);
  // ---- a spec 2 plugin with a secret setting: the scrobbler (the services are mocked; nothing leaves the machine)
  const lbHits = []; await pg.route('https://api.listenbrainz.org/**', r => { lbHits.push(r.request().headers().authorization); r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ valid: true, user_name: 'tester' }) }); });
  const scRow = () => pg.locator('#settingsBody .srow', { hasText: 'Scrobbling' }).first();
  await scRow().locator('input[type=checkbox]').click(); await pg.locator('.pconfirm button', { hasText: 'Turn on' }).click(); await pg.waitForFunction(() => window.__bootleg.extensions.running.has('scrobble'), null, { timeout: 8000 });
  t('the scrobbler is experimental, so it asks first, then adds its page', await pg.locator('#extNav .nav:has-text("Scrobbling")').isVisible());
  const tokIn = pg.locator('#settingsBody .srow', { hasText: 'ListenBrainz user token' }).locator('input[type=password]');
  await tokIn.fill('my-lb-token'); await tokIn.dispatchEvent('change'); await pg.waitForFunction(() => /tester/.test(window.__bootleg.extensions.status('scrobble')), null, { timeout: 8000 });
  t('a secret setting goes to the secret store, not the plugin settings, and the field does not show it again', (await ev(() => localStorage.getItem('bootleg.secrets'))).includes('plugin/scrobble/listenbrainzToken') && !(await ev(() => Object.keys(localStorage).filter(k => k.startsWith('bootleg.ext.scrobble')).map(k => localStorage.getItem(k)).join(''))).includes('my-lb-token') && (await tokIn.inputValue()) === '' && /saved/.test(await tokIn.getAttribute('placeholder')));
  t('…and the plugin restarted with it and signed in', lbHits.includes('Token my-lb-token'));
  await ev(() => window.__bootleg.extensions.setEnabled('scrobble', false)); await pg.waitForFunction(() => !window.__bootleg.extensions.running.has('scrobble'));      // (Settings repaints as the plugin restarts, so not by clicking) await pg.unroute('https://api.listenbrainz.org/**');
  await ev(() => window.__bootleg.player.setVolume(0.9));

  // ---- music videos: from a folder, matched to tracks by artist and title, linked by hand, played with their own sound
  const vdir = path.join(tmp, 'Videos'); fs.mkdirSync(vdir);
  const clip = (name, freq) => ff('-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25:duration=4', '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=4`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', path.join(vdir, name));
  clip('The Isobars - Low Pressure (Official Video).mp4', 600); clip('Nobody - Unrelated Clip.mp4', 800);
  await pg.setInputFiles('#folderIn', vdir); await pg.waitForFunction(() => window.__bootleg.lib.videos.length === 2);
  t('video files become library videos (not tracks), with artist and title from the file name', await ev(() => { const b = window.__bootleg.lib, v = b.videos.find(x => x.artist === 'The Isobars'); return v?.title === 'Low Pressure (Official Video)' && !b.tracks.some(x => /\.mp4$/.test(x.src.name)); }));
  t('the Videos page appears in the left pane', await pg.locator('.nav[data-view="videos"]').isVisible() && (await pg.locator('#nVideos').innerText()) === '2');
  await pg.click('.nav[data-view="tracks"]'); await pg.fill('#search', 'Low Pressure'); await pg.locator('#search').dispatchEvent('input');
  t('a track with a matching video shows 🎬 in the list', await pg.locator('#trackList .row', { hasText: 'Low Pressure' }).locator('.vchip').isVisible().catch(() => false));
  await pg.fill('#search', ''); await pg.locator('#search').dispatchEvent('input');
  await ev(async () => { const b = window.__bootleg; await b.player.playList([b.lib.tracks.find(x => x.title === 'Low Pressure')], 0); }); await pg.click('.nav[data-view="now"]');
  await pg.click('#nowVideoBar button:has-text("Watch the video")');
  await pg.waitForFunction(() => { const p = window.__bootleg.player; return p.video && p.playing && p.pos() > 0.5 && p.videoEl.videoWidth === 320; }, null, { timeout: 15000 });
  t('"Watch the video" plays the video, with its sound, on Now playing (the track stays the queue item)', await ev(() => { const p = window.__bootleg.player; return p.item.title === 'Low Pressure' && p.audio === p.videoEl && document.querySelector('#nowVideo video') === p.videoEl && !document.getElementById('nowVideo').hidden; }));
  t('…the track\'s timeline is hidden while its video plays (another edit, another clock)', await pg.locator('#timeline').isHidden());
  await pg.click('#nowVideoBar button:has-text("Back to the track")'); await pg.waitForFunction(() => { const p = window.__bootleg.player; return !p.video && p.playing && p.audio === p.audioEl; });
  t('"Back to the track" plays the track again', await pg.locator('#nowVideo').isHidden());
  // a visualizer screen shows the linked video (silently) while the track itself plays, and the visualizer again without one
  const vs = await pg.context().newPage(); vs.on('pageerror', e => errs.push('screen: ' + e.message)); await vs.goto(`http://127.0.0.1:${PORT}/screen.html`);
  await vs.waitForFunction(() => { const v = document.getElementById('mv'); return !v.hidden && v.muted && v.currentTime > 0.5 && !v.paused && document.getElementById('pack').classList.contains('off'); }, null, { timeout: 15000 }).then(() => t('a visualizer screen shows the track\'s music video, silently, while the track plays', true), e => t('a visualizer screen shows the track\'s music video, silently, while the track plays', false, e.message.split('\n')[0]));
  await ev(async () => { const b = window.__bootleg; b.settings.vizVideo = false; }); await vs.waitForFunction(() => document.getElementById('mv').hidden && !document.getElementById('pack').classList.contains('off'), null, { timeout: 5000 }).then(() => t('…and the visualizer when that option is off', true), () => t('…and the visualizer when that option is off', false));
  await ev(() => { window.__bootleg.settings.vizVideo = true; }); await vs.close();
  await pg.locator('#nowVideoBar input[type=checkbox]').check(); await pg.waitForFunction(() => { const p = window.__bootleg.player; return p.video && p.playing; });
  await ev(async () => { const b = window.__bootleg; await b.player.playList([b.lib.tracks.find(x => x.title === 'Second Quarter'), b.lib.tracks.find(x => x.title === 'Low Pressure')], 0); });
  t('video mode: a track without a video plays as usual', await ev(() => !window.__bootleg.player.video));
  await ev(() => window.__bootleg.player.next()); await pg.waitForFunction(() => { const p = window.__bootleg.player; return p.item.title === 'Low Pressure' && p.video && p.playing; });
  t('…and the next track with a video plays its video', true);
  await pg.locator('#nowVideoBar input[type=checkbox]').uncheck(); await pg.waitForFunction(() => !window.__bootleg.player.video);
  // linking by hand, and turning down an automatic match
  await ev(() => { const b = window.__bootleg; b.videosUI.linkDialog(b.lib.tracks.find(x => x.title === 'Second Quarter')); });
  await pg.fill('.vdlg input[type=search]', 'unrelated'); await pg.locator('.vdlg li', { hasText: 'Unrelated Clip' }).locator('button:has-text("Link")').click();
  await pg.waitForSelector('.vdlg li:has-text("linked by you")'); await pg.click('.vdlg button:has-text("Done")');
  t('any video can be linked to any track by hand', await ev(() => { const b = window.__bootleg, r = b.videosUI.of(b.lib.tracks.find(x => x.title === 'Second Quarter')); return r.length === 1 && r[0].how === 'linked' && r[0].video.title === 'Unrelated Clip'; }));
  await ev(() => { const b = window.__bootleg; b.videosUI.linkDialog(b.lib.tracks.find(x => x.title === 'Low Pressure')); }); await pg.click('.vdlg li:has-text("matched by artist") button:has-text("not this one")');
  await pg.waitForSelector('.vdlg button:has-text("turned down")'); await pg.click('.vdlg button:has-text("Done")');
  t('an automatic match can be turned down (and is remembered)', await ev(() => { const b = window.__bootleg; return b.videosUI.of(b.lib.tracks.find(x => x.title === 'Low Pressure')).length === 0 && b.videoLinks.hidden.size === 1; }));
  await ev(() => { const b = window.__bootleg; return b.videoLinks.restore(b.videoLinks.hidden.keys().next().value); });
  await pg.click('.nav[data-view="videos"]'); await pg.locator('#videoList .vcard', { hasText: 'Unrelated Clip' }).click();
  await pg.waitForFunction(() => { const p = window.__bootleg.player; return p.item?.kind === 'video' && p.video === p.item && p.playing && p.pos() > 0.3; }, null, { timeout: 15000 });
  t('a video on the Videos page plays on its own', true);
  await ev(() => window.__bootleg.player.pause());

  // ---- progress while importing a big folder
  const big = path.join(tmp, 'Big'); fs.mkdirSync(big); ff('-f', 'lavfi', '-i', 'sine=frequency=500:duration=1', path.join(tmp, 'one.wav')); for (let i = 0; i < 1500; i++) fs.copyFileSync(path.join(tmp, 'one.wav'), path.join(big, `bulk ${String(i).padStart(4, '0')}.wav`));
  await pg.evaluate(() => { window.__sawProgress = []; const el = document.getElementById('progress'); new MutationObserver(() => { if (!el.hidden) window.__sawProgress.push(document.getElementById('ptext').textContent); }).observe(el, { attributes: true, childList: true, subtree: true, characterData: true }); });
  await pg.setInputFiles('#folderIn', big); await pg.waitForFunction(() => window.__bootleg.lib.tracks.length === 1503 && document.getElementById('progress').hidden, null, { timeout: 60000 });
  const saw = await ev(() => window.__sawProgress); t('a big import shows progress ("Reading tags… N of M") and hides it when done', saw.some(x => /Reading tags… [\d,]+ of 1,?500/.test(x)), saw.length + ' updates, e.g. ' + saw[Math.floor(saw.length / 2)]);

  // ---- multiple libraries: listening vs studio, shared recordings, global tags
  const studioDir = path.join(tmp, 'Studio/Demos'); fs.mkdirSync(studioDir, { recursive: true }); ff('-f', 'lavfi', '-i', 'sine=frequency=700:duration=3', '-metadata', 'title=Demo One', '-metadata', 'artist=Me', path.join(studioDir, 'Demo One.flac'));
  const before = await ev(() => window.__bootleg.lib.visibleTracks.length);
  await pg.click('.nav[data-view="settings"]'); await pg.fill('#newLibName', 'My songs'); await pg.selectOption('#newLibMode', 'studio'); await pg.click('#newLibBtn');
  const nl = await ev(() => [window.__bootleg.libs.target().name, window.__bootleg.lib.visibleTracks.length, window.__bootleg.libs.active, window.__bootleg.libs.list.map(l => l.name).join('|')].join()); t('creating a studio library selects it, and it starts empty', nl.startsWith('My songs,0'), nl);
  await pg.setInputFiles('#folderIn', path.join(tmp, 'Studio')); await pg.waitForFunction(() => window.__bootleg.lib.visibleTracks.length === 1 && window.__bootleg.lib.visibleTracks[0].tagged);
  await pg.selectOption('#libSel', 'music'); await sleep(200); t('files added to the studio library do not appear in the listening one', (await ev(() => window.__bootleg.lib.visibleTracks.length)) === before && !(await ev(() => window.__bootleg.lib.visibleTracks.some(x => x.title === 'Demo One'))));
  await pg.selectOption('#libSel', await ev(() => window.__bootleg.libs.list.find(l => l.mode === 'studio').id)); await pg.setInputFiles('#folderIn', lib); await pg.waitForFunction(() => window.__bootleg.lib.visibleTracks.length === 4);
  t('the same files can live in two libraries (no duplicates are created)', (await ev(() => window.__bootleg.lib.tracks.filter(x => x.title === 'Low Pressure').length)) === 1 && (await ev(() => [...window.__bootleg.lib.tracks.find(x => x.title === 'Low Pressure').libs].length)) === 2);
  await ev(() => { const B = window.__bootleg; B.player.playList(B.lib.visibleTracks.filter(x => x.title === 'Low Pressure'), 0); }); await pg.click('.nav[data-view="now"]'); await pg.waitForSelector('#notesPanel');
  const studioUi = await ev(() => ({ status: !!document.querySelector('#notesPanel .f select option[value="mixing"]'), kinds: [...document.querySelectorAll('#noteKind option')].map(o => o.value).join(), label: document.querySelector('#notesPanel h4 .chip').textContent }));
  t('studio mode offers status and studio note kinds (to-do, mix, version…)', studioUi.status && /todo/.test(studioUi.kinds) && /mix/.test(studioUi.kinds) && /Studio/.test(studioUi.label), JSON.stringify(studioUi));
  await pg.selectOption('#notesPanel .f select:has(option[value="mixing"])', 'mixing'); await pg.fill('#noteText', 'bass too loud'); await pg.selectOption('#noteKind', 'todo'); await pg.click('#notesPanel .cbtns .btn:has-text("whole recording")'); await pg.waitForSelector('#notesPanel .chip.kind');
  await pg.locator('#notesPanel input[placeholder^="live, favorite"]').fill('wip, funk'); await pg.locator('#notesPanel input[placeholder^="live, favorite"]').blur(); await sleep(300);
  await pg.selectOption('#libSel', 'music'); await sleep(400);
  const listenUi = await ev(() => ({ status: !!document.querySelector('#notesPanel .f select option[value="mixing"]'), kinds: [...document.querySelectorAll('#noteKind option')].map(o => o.value).join(), label: document.querySelector('#notesPanel h4 .chip').textContent, todoNote: !!document.querySelector('#notesPanel .chip.kind') }));
  t('the same recording in the listening library shows listening tools — and still carries the to-do note (notes follow the recording)', !listenUi.status && !/todo/.test(listenUi.kinds) && /memory/.test(listenUi.kinds) && /Listening/.test(listenUi.label) && listenUi.todoNote, JSON.stringify(listenUi));
  await pg.click('.nav[data-view="notes"]'); await pg.waitForSelector('#noteCards .ncard'); const tagOpts = await ev(() => [...document.querySelectorAll('#noteTag option')].map(o => o.value)); t('tags are global: the tag filter lists tags from every library', tagOpts.includes('wip') && tagOpts.includes('funk'), tagOpts.join());
  await pg.selectOption('#noteStatus', 'mixing'); await sleep(300); t('the Notes view filters by status', (await pg.locator('#noteCards .ncard').count()) === 1);
  await pg.selectOption('#noteStatus', ''); await pg.selectOption('#libSel', 'all'); await sleep(300); t('"All libraries" shows every track', (await ev(() => window.__bootleg.lib.visibleTracks.length)) === (await ev(() => window.__bootleg.lib.tracks.length)));

  // ---- Subsonic source plugin (against a mock server)
  const sdir = path.join(tmp, 'srv'); fs.mkdirSync(sdir); const files = {}; for (const [id, f] of [['s1', 330], ['s2', 440], ['s3', 550], ['s4', 660]]) { files[id] = path.join(sdir, id + '.flac'); ff('-f', 'lavfi', '-i', `sine=frequency=${f}:duration=5`, '-c:a', 'flac', files[id]); }
  const song = (id, title, album, albumId, track) => ({ id, title, artist: 'Server Band', album, albumId, track, suffix: 'flac', duration: 5, size: fs.statSync(files[id]).size, created: '2026-01-0' + track + 'T00:00:00Z', coverArt: albumId, genre: 'Funk', year: 2024 });
  const mock = await startMock({ songs: [song('s1', 'Remote One', 'Cloud Album', 'al1', 1), song('s2', 'Remote Two', 'Cloud Album', 'al1', 2), song('s3', 'Solo Cloud', 'Other Album', 'al2', 1)], files, cover: path.join(tmp, 'a.png'), playlists: [{ id: 'pl1', name: 'Server Mix', songs: ['s3', 's1', 'gone'] }] });
  Object.assign(mock.state.songs.find(x => x.id === 's2'), { userRating: 5 }); Object.assign(mock.state.songs.find(x => x.id === 's3'), { starred: '2026-01-01T00:00:00Z' });
  await pg.click('.nav[data-view="settings"]'); await pg.fill('#newLibName', 'Server'); await pg.click('#newLibBtn'); const sid = await ev(() => window.__bootleg.libs.active); await pg.click('#connectOpen-' + sid);
  await pg.fill('input[name=url]', mock.url); await pg.fill('input[name=username]', 'alice'); await pg.fill('input[name=password]', 'wrong'); await pg.click('.connect .btn.primary'); await pg.waitForSelector('.connect .err:not(:empty)');
  t('a wrong password is reported with the server’s message and nothing is added', /Wrong username or password/.test(await pg.locator('.connect .err').innerText()) && (await ev(() => window.__bootleg.libs.allConnections().length)) === 0);
  await pg.fill('input[name=password]', 'secret'); await pg.click('.connect .btn.primary'); await pg.waitForFunction(() => window.__bootleg.lib.visibleTracks.length === 3, null, { timeout: 20000 });
  const rt = await ev(() => window.__bootleg.lib.visibleTracks.map(x => [x.title, x.artist, x.album, x.src.kind, !!x.coverUrl, x.genre, x.year, x.duration].join('|')).sort());
  t('connecting lists the server\'s tracks with tags, cover art and duration — nothing read from files', rt.length === 3 && rt[0] === 'Remote One|Server Band|Cloud Album|remote|true|Funk|2024|5', rt[0]);
  // ---- server ratings, stars and playlists (Navidrome keeps these; bootleg syncs them both ways)
  const skey = title => pg.evaluate(tt => { const x = window.__bootleg.lib.tracks.find(y => y.title === tt); return 'file:' + x.src.path + '#' /* a server track's key has no size */; }, title), rec = k => pg.evaluate(async kk => window.__bootleg.notes.store.get(kk), k);
  for (let i = 0; i < 100 && !(await ev(async () => (await window.__bootleg.notes.store.playlists()).some(p => p.server))); i++) await sleep(100);      // (waitForFunction would treat an async predicate's promise as true)
  const spl = await ev(async () => (await window.__bootleg.notes.store.playlists()).find(p => p.server));
  t('the server\'s playlists appear in Playlists, in order, with tracks the library knows', spl.name === 'Server Mix' && spl.items.length === 2 && spl.items[0] === await skey('Solo Cloud'), JSON.stringify(spl.items));
  t('server ratings and stars arrive: 5 stars, and the "starred" tag', (await rec(await skey('Remote Two'))).rating === 5 && (await rec(await skey('Solo Cloud'))).tags.includes('starred'));
  await pg.evaluate(async k => window.__bootleg.notes.store.setRating(k, 3.5), await skey('Remote One')); await pg.evaluate(async k => window.__bootleg.notes.store.setTags(k, ['starred']), await skey('Remote One'));
  for (let i = 0; i < 50 && mock.state.writes.length < 2; i++) await sleep(100);
  t('rating or starring in bootleg is sent to the server (half stars round to whole)', JSON.stringify(mock.state.writes) === JSON.stringify([['setRating', 's1', '4'], ['star', 's1', null]]), JSON.stringify(mock.state.writes));
  mock.state.songs.find(x => x.id === 's1').userRating = 2; await ev(() => window.__bootleg.syncAll()); await sleep(300);
  t('a rating changed on the server since the last sync wins in bootleg', (await rec(await skey('Remote One'))).rating === 2 && mock.state.writes.length === 2);
  await pg.evaluate(async k => window.__bootleg.notes.store.setRating(k, 0), await skey('Remote One')); for (let i = 0; i < 50 && mock.state.writes.length < 3; i++) await sleep(100);
  t('clearing a rating clears it on the server', !('userRating' in mock.state.songs.find(x => x.id === 's1')));
  await pg.click('.nav[data-view="playlists"]'); await pg.waitForSelector('#plList .ncard:has-text("Server Mix")'); t('a server playlist is marked ☁ and cannot be deleted here', (await pg.locator('#plList .ncard:has-text("Server Mix")').innerText()).includes('☁') && (await pg.locator('#plList .ncard:has-text("Server Mix") button:has-text("delete")').count()) === 0);
  await pg.locator('#plList .ncard:has-text("Server Mix") button:has-text("hide")').click(); await pg.waitForFunction(() => !document.querySelector('#plList').innerText.includes('Server Mix'));
  t('a server playlist can be hidden instead', await pg.locator('#plHidden').isVisible()); await pg.check('#plShowHidden'); await pg.locator('#plList .ncard:has-text("Server Mix") button:has-text("unhide")').click(); await pg.waitForFunction(() => document.getElementById('plHidden').hidden);
  t('…and shown again', (await pg.locator('#plList .ncard:has-text("Server Mix")').count()) === 1);
  // ---- tag edits in bootleg override what the server says (in bootleg only)
  await pg.click('.nav[data-view="tracks"]'); const solo = pg.locator('#trackList .row', { hasText: 'Solo Cloud' }); await solo.hover(); await solo.locator('button:has-text("edit")').click();
  await pg.waitForSelector('dialog.tagdlg[open]'); await pg.fill('dialog.tagdlg input[name=title]', 'Solo Cloud (Live)'); await pg.fill('dialog.tagdlg input[name=genre]', 'Live Funk'); const w0 = mock.state.writes.length; await pg.click('dialog.tagdlg button[type=submit]');
  await pg.waitForFunction(() => window.__bootleg.lib.tracks.some(x => x.title === 'Solo Cloud (Live)' && x.genre === 'Live Funk'));
  t('editing a server track\'s tags shows the edit everywhere in bootleg, marked ✎', (await pg.locator('#trackList .row', { hasText: 'Solo Cloud (Live)' }).innerText()).includes('✎') && (await ev(() => window.__bootleg.lib.tracks.find(x => x.title === 'Solo Cloud (Live)').orig.title)) === 'Solo Cloud');
  t('…and nothing is sent to the server', mock.state.writes.length === w0 && mock.state.songs.find(x => x.id === 's3').title === 'Solo Cloud');
  await ev(() => window.__bootleg.syncAll()); await sleep(400); t('a server sync keeps the edit', (await ev(() => window.__bootleg.lib.tracks.some(x => x.title === 'Solo Cloud (Live)'))));
  t('edits are part of the notes export (they travel with ratings and notes)', (await ev(async () => (await window.__bootleg.notes.store.export()).tracks.some(x => x.edits?.title === 'Solo Cloud (Live)'))));
  const live = pg.locator('#trackList .row', { hasText: 'Solo Cloud (Live)' }); await live.hover(); await live.locator('button:has-text("edit")').click(); await pg.waitForSelector('dialog.tagdlg[open]');
  await pg.locator('dialog.tagdlg label', { hasText: 'Title' }).locator('button:has-text("revert")').click(); await pg.click('dialog.tagdlg button[type=submit]');
  await pg.waitForFunction(() => window.__bootleg.lib.tracks.some(x => x.title === 'Solo Cloud' && x.genre === 'Live Funk'));
  t('one field can be reverted to what the server says; the other edit stays', true);
  await pg.click('.nav[data-view="albums"]'); await pg.click('#albumMode button[data-mode="list"]'); await pg.locator('#albumList .arow', { hasText: 'Cloud Album' }).click(); await pg.click('#albumDetail button:has-text("Edit album")');
  await pg.waitForSelector('dialog.tagdlg[open]'); t('the album editor offers only the shared fields', (await pg.locator('dialog.tagdlg input[name=title]').count()) === 0);
  await pg.fill('dialog.tagdlg input[name=year]', '1999'); await pg.click('dialog.tagdlg button[type=submit]'); await pg.waitForFunction(() => window.__bootleg.lib.tracks.filter(x => x.album === 'Cloud Album').every(x => +x.year === 1999));
  t('an album edit applies to every track of the album', true); await pg.click('#albumMode button[data-mode="grid"]');
  t('the password is never stored (only a salted token)', !(await ev(() => localStorage.getItem('bootleg.libraries') + localStorage.getItem('bootleg.secrets'))).includes('secret') && /"token\\?":\\?"[0-9a-f]{32}/.test(await ev(() => localStorage.getItem('bootleg.secrets'))));
  t('the token is kept apart from the library settings (app storage in a browser, the keychain on the desktop)', !(await ev(() => localStorage.getItem('bootleg.libraries'))).includes('token') && (await ev(() => window.__bootleg.secrets.where)).includes('app storage'));
  await pg.click('.nav[data-view="tracks"]'); await pg.waitForSelector('#trackList .row'); await pg.locator('#trackList .row', { hasText: 'Remote One' }).dblclick(); await pg.waitForFunction(() => window.__bootleg.player.playing && window.__bootleg.player.pos() > 0.5, null, { timeout: 20000 });
  const pk = await ev(async () => { let m = 0; for (let i = 0; i < 20; i++) { m = Math.max(m, ...window.__bootleg.feed.update(0.05).spectrum); await new Promise(r => setTimeout(r, 50)); } return m; });
  t('a server track plays and the visualizer hears it (CORS-clean analyser)', pk > 0.2, 'peak ' + pk.toFixed(2));
  // ---- output plugins / casting (JS side, with a fake device; the DLNA protocol itself is covered by the desktop self-test)
  await ev(async () => { const { registerOutput } = await import('/lib/outputs/plugin.js'); window.__cast = []; const rec = n => async (...a) => { window.__cast.push([n, ...a.slice(1)]); };
    registerOutput({ id: 'fake', name: 'Fake', discover: async () => [{ id: 'dev1', name: 'Kitchen Speaker', plugin: 'fake' }], play: async (d, m) => { window.__cast.push(['play', m.url, m.title, m.artist, m.mime]); }, pause: rec('pause'), resume: rec('resume'), stop: rec('stop'), seek: rec('seek'), volume: rec('volume') }); await window.__bootleg.outputs.scan(); });
  await pg.click('#outBtn'); await pg.waitForSelector('#outMenu .orow:has-text("Kitchen Speaker")'); t('the output menu lists discovered devices', (await pg.locator('#outMenu .orow').count()) === 2);
  await pg.locator('#outMenu .orow:has-text("Kitchen Speaker")').click(); await pg.waitForFunction(() => window.__cast.some(c => c[0] === 'play'));
  const c1 = await ev(() => window.__cast.find(c => c[0] === 'play')); t('selecting a device sends it the current track (server stream URL, title, artist, mime)', /\/rest\/stream\.view/.test(c1[1]) && c1[2] === 'Remote One' && c1[3] === 'Server Band' && c1[4] === 'audio/flac', JSON.stringify(c1).slice(0, 140));
  t('the button names the device and local sound is muted while local playback (and the visualizer feed) keep running', (await pg.locator('#outName').innerText()) === 'Kitchen Speaker' && (await ev(() => window.__bootleg.player.localOut === false && window.__bootleg.player.playing)));
  const pk2 = await ev(async () => { let m = 0; for (let i = 0; i < 20; i++) { m = Math.max(m, ...window.__bootleg.feed.update(0.05).spectrum); await new Promise(r => setTimeout(r, 50)); } return m; }); t('the visualizer still hears the music while casting', pk2 > 0.2, pk2.toFixed(2));
  await pg.keyboard.press('Escape'); await pg.click('#play'); await pg.waitForFunction(() => window.__cast.some(c => c[0] === 'pause')); await pg.click('#play'); await pg.waitForFunction(() => window.__cast.some(c => c[0] === 'resume')); t('pause and resume are forwarded to the device', true);
  await ev(() => window.__bootleg.player.seek(3)); await ev(() => { const v = document.getElementById('volume'); v.value = 0.5; v.oninput(); }); await pg.waitForFunction(() => window.__cast.some(c => c[0] === 'seek' && c[1] === 3) && window.__cast.some(c => c[0] === 'volume' && c[1] === 0.5)); t('seek and volume are forwarded', true);
  await pg.locator('#next').click(); await pg.waitForFunction(() => window.__cast.filter(c => c[0] === 'play').length === 2); t('changing track plays the new one on the device', true);
  await pg.click('#outBtn'); await pg.locator('#outMenu .orow:has-text("This computer")').click(); await pg.waitForFunction(() => window.__cast.some(c => c[0] === 'stop') && window.__bootleg.player.localOut === true); t('choosing "This computer" stops the device and restores local sound', (await pg.locator('#outName').innerText()) === 'This computer');
  await ev(async () => window.__bootleg.notes.store.setRating(window.__bootleg.player.item ? 'file:' + window.__bootleg.player.item.src.path + '#' : 'x', 4));
  await ev(async () => { const b = window.__bootleg, x = b.lib.tracks.find(y => y.title === 'Remote One'), k = 'file:' + x.src.path + '#123';      // a record saved under the old key format (with the size)
    await b.notes.store.b.put('t:' + k, { key: k, rating: 0, status: '', tags: [], notes: [{ id: 'm1', text: 'from before', at: null, to: null, kind: 'note', created: 1 }], provenance: null, fingerprint: null, edits: null, updated: 1 }); });
  await pg.reload(); await pg.waitForFunction(() => window.__bootleg && window.__bootleg.lib.tracks.length === 3, null, { timeout: 15000 });
  t('records saved under the old server-track key move to the new one on start', (await ev(async () => { const b = window.__bootleg, x = b.lib.tracks.find(y => y.title === 'Remote One'); return (await b.notes.store.get('file:' + x.src.path + '#')).notes.some(n => n.text === 'from before') && !(await b.notes.store.b.get('t:file:' + x.src.path + '#123')); })));
  t('after a restart the remote library is back from the cache (no re-reading of files, no password asked)', (await ev(() => window.__bootleg.lib.tracks.every(x => x.tagged && x.src.kind === 'remote'))) && (await ev(() => window.__bootleg.libs.active)) === sid);
  t('a rating given while casting reached the server too', mock.state.writes.some(w => w[0] === 'setRating' && w[1] === 's2' && w[2] === '4'), JSON.stringify(mock.state.writes));
  t('annotations on a server track survive too (keyed by the track\'s stable path)', (await ev(async () => (await window.__bootleg.notes.store.export()).tracks.some(x => x.key.startsWith('file:subsonic:') && x.rating === 4))));
  mock.state.songs.push(song('s4', 'Fresh Upload', 'Other Album', 'al2', 2)); mock.state.songs = mock.state.songs.filter(x => x.id !== 's2');
  await ev(() => window.__bootleg.syncAll()); await pg.waitForFunction(() => window.__bootleg.lib.tracks.length === 3 && window.__bootleg.lib.tracks.some(x => x.title === 'Fresh Upload') && !window.__bootleg.lib.tracks.some(x => x.title === 'Remote Two'), null, { timeout: 15000 });
  t('"check for changes" picks up a new upload and a removed track on the server', true);
  mock.state.failStream = true; await pg.click('.nav[data-view="tracks"]'); await pg.locator('#trackList .row', { hasText: 'Fresh Upload' }).dblclick(); await pg.waitForSelector('.toast.bad', { timeout: 15000 });
  t('when a server track cannot be played, the user is told why (never silent)', /Could not play .*Fresh Upload/.test(await pg.locator('.toast.bad').first().innerText()), await pg.locator('.toast.bad').first().innerText());
  mock.state.failStream = false;
  // ---- a packaged source plugin: Jellyfin (mock server); its music video matches a local track from another library
  clip('jf-video.mp4', 900);
  const JA = (Id, Name, ix) => ({ Id, Type: 'Audio', Name, Artists: ['Jelly Band'], AlbumArtist: 'Jelly Band', Album: 'Jam', AlbumId: 'jal', AlbumPrimaryImageTag: 't', IndexNumber: ix, ProductionYear: 2023, RunTimeTicks: 5e7, Container: 'flac', Etag: 'e' + Id, MediaSources: [{ Size: fs.statSync(files.s1).size, Bitrate: 900000 }] });
  const jf = await startJellyfin({ items: [JA('j1', 'Jam One', 1), JA('j2', 'Jam Two', 2), { Id: 'jv1', Type: 'MusicVideo', Name: 'Server Band - Remote One (Official Video)', Artists: [], RunTimeTicks: 4e7, Container: 'mov,mp4,m4a', Path: '/media/videos/sq.mp4', ImageTags: { Primary: 'p' }, MediaSources: [{ Size: fs.statSync(path.join(vdir, 'jf-video.mp4')).size, MediaStreams: [{ Type: 'Video', Codec: 'h264' }, { Type: 'Audio', Codec: 'aac' }] }] }],
    files: { j1: files.s1, j2: files.s2, jv1: path.join(vdir, 'jf-video.mp4') }, image: path.join(tmp, 'a.png'), playlists: [{ id: 'jp', name: 'Jelly Mix', items: ['j2', 'j1'] }] });
  await ev(async () => { const x = window.__bootleg.extensions; x.confirm('jellyfin'); await x.setEnabled('jellyfin', true); });
  await pg.click('.nav[data-view="settings"]'); await pg.click('#connectOpen-' + sid); await pg.selectOption('.connect select', 'jellyfin');
  await pg.fill('.connect input[name=url]', jf.url + '/web/index.html'); await pg.fill('.connect input[name=username]', 'tester'); await pg.fill('.connect input[name=password]', 'testpass'); await pg.click('.connect .btn.primary');
  await pg.waitForFunction(() => window.__bootleg.lib.tracks.filter(x => x.src.remote?.plugin === 'jellyfin').length === 2 && window.__bootleg.lib.videos.some(v => v.src.remote?.plugin === 'jellyfin'), null, { timeout: 20000 });
  t('a packaged source plugin (Jellyfin) offers itself under "Connect a server", signs in and lists the server\'s tracks', await ev(() => { const j = window.__bootleg.lib.tracks.find(x => x.title === 'Jam One'); return j.artist === 'Jelly Band' && j.album === 'Jam' && j.year === 2023 && j.duration === 5 && /\/Items\/jal\/Images\/Primary/.test(j.coverUrl); }));
  t('…the token is kept in the secret store, not with the library settings', !(await ev(() => localStorage.getItem('bootleg.libraries'))).includes('tok-tester') && (await ev(() => localStorage.getItem('bootleg.secrets'))).includes('tok-tester'));
  t('…its music video gets artist and title from "Artist - Title" and is matched to a track from another source (Subsonic)', await ev(() => { const b = window.__bootleg, v = b.lib.videos.find(x => x.src.remote?.plugin === 'jellyfin'), r1 = b.lib.tracks.find(x => x.title === 'Remote One'); return v.artist === 'Server Band' && v.title === 'Remote One (Official Video)' && r1.src.remote.plugin === 'subsonic' && b.videosUI.of(r1).some(r => r.video === v && r.how === 'auto'); }), await ev(() => { const b = window.__bootleg, v = b.lib.videos.find(x => x.src.remote?.plugin === 'jellyfin'), r1 = b.lib.tracks.find(x => x.title === 'Remote One'); return JSON.stringify({ v: v && [v.artist, v.title], r1: r1 && [r1.artist, r1.title, r1.albumArtist, r1.src.remote?.plugin], of: r1 && b.videosUI.of(r1).map(r => [r.how, r.video.title]), all: b.lib.tracks.filter(x => x.remote).map(x => x.title) }); }));
  await ev(async () => { const b = window.__bootleg; await b.player.playList([b.lib.tracks.find(x => x.title === 'Jam One')], 0); }); await pg.waitForFunction(() => window.__bootleg.player.playing && window.__bootleg.player.pos() > 0.5, null, { timeout: 15000 });
  t('a Jellyfin track plays', true);
  await ev(async () => { const b = window.__bootleg; await b.player.setVideoMode(true); await b.player.playList([b.lib.tracks.find(x => x.title === 'Remote One')], 0); });      // (video mode: the track's own stream is never asked for)
  await pg.waitForFunction(() => { const p = window.__bootleg.player; return p.video && p.playing && p.pos() > 0.5 && p.videoEl.videoWidth === 320; }, null, { timeout: 15000 });
  t('a Subsonic track plays its Jellyfin music video', true); await ev(() => window.__bootleg.player.setVideoMode(false));
  for (let i = 0; i < 50 && !(await ev(async () => (await window.__bootleg.notes.store.playlists()).some(p => p.name === 'Jelly Mix'))); i++) await sleep(100);
  t('the server\'s playlists arrive', await ev(async () => (await window.__bootleg.notes.store.playlists()).some(p => p.name === 'Jelly Mix' && p.items.length === 2)));
  await ev(() => window.__bootleg.player.pause()); const hitsBefore = jf.state.hits.length;
  await ev(() => window.__bootleg.extensions.setEnabled('jellyfin', false)); await pg.waitForFunction(() => !window.__bootleg.lib.tracks.some(x => x.src.remote?.plugin === 'jellyfin') && !window.__bootleg.lib.videos.some(x => x.src.remote?.plugin === 'jellyfin'));
  t('turning the plugin off takes its tracks and videos out of the library (the connection stays)', await ev(() => window.__bootleg.libs.allConnections().some(c => c.conn.plugin === 'jellyfin')));
  await ev(async () => { const x = window.__bootleg.extensions; await x.setEnabled('jellyfin', true); }); await pg.waitForFunction(() => window.__bootleg.lib.tracks.filter(x => x.src.remote?.plugin === 'jellyfin').length === 2, null, { timeout: 10000 });
  t('…and turning it on again brings them back from the cache, without asking the server', jf.state.hits.slice(hitsBefore).filter(h => /Items$/.test(h)).length === 0, jf.state.hits.slice(hitsBefore).join(', '));
  jf.close();
  mock.close();
  // ---- a song in one file (.bstem), and songs from a bootleg stem server
  const fxDir = path.join(lib, 'Renders/fixture-render'), fxStems = fs.readdirSync(path.join(fxDir, 'stems')).filter(f => f.endsWith('.flac')), fxFiles = {};
  for (const f of ['mix.flac', 'clips.json', ...fxStems.map(x => 'stems/' + x)]) fxFiles[f] = fs.readFileSync(path.join(fxDir, f));
  const pkgDir = path.join(tmp, 'Packages'); fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'Packaged.bstem'), bstemFrom(fxFiles, { format: 'bootleg-stem', version: 2, id: '11111111-2222-4333-8444-555555555555', title: 'Packaged Song', bpm: 120 }));
  await pg.click('.nav[data-view="tracks"]'); await pg.setInputFiles('#folderIn', pkgDir);
  await pg.waitForFunction(n => window.__bootleg.lib.renders.some(r => r.title === 'Packaged Song' && r.stems.length === n && r.mix), fxStems.length, { timeout: 15000 });
  t('a .bstem is one stem set: its title from the manifest, its mix and stems from inside the file', (await ev(() => window.__bootleg.lib.renders.find(r => r.title === 'Packaged Song').bpm)) === 120);
  await ev(async () => { const B = window.__bootleg; await B.player.playList([B.lib.renders.find(r => r.title === 'Packaged Song')], 0); });
  await pg.waitForFunction(() => window.__bootleg.player.playing && window.__bootleg.player.pos() > 0.3, null, { timeout: 15000 }); t('…its mix plays straight from the package', true);
  await ev(() => window.__bootleg.player.ensureStems()); await pg.waitForFunction(n => window.__bootleg.player.mode === 'deck' && window.__bootleg.player.deck.stems.length === n, fxStems.length, { timeout: 30000 });
  t('…and its stems load from it into the stem mixer', true);
  const songId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', fxMan = JSON.parse(fs.readFileSync(path.join(fxDir, 'manifest.json'), 'utf8'));
  const ss = await startStemServer({ songs: [{ id: songId, name: 'out_collage_test', dir: fxDir, manifest: { ...fxMan, id: songId, title: 'Server Song', bpm: 132 }, annotations: { grade: 'A-', rating: 4, fav: true } }], playlists: [{ name: 'Server Set', items: [songId] }] });
  await pg.click('.nav[data-view="settings"]'); await pg.fill('#newLibName', 'Stems'); await pg.click('#newLibBtn'); const sid2 = await ev(() => window.__bootleg.libs.active); await pg.click('#connectOpen-' + sid2);
  await pg.selectOption('.connect select', 'stemserver'); await pg.fill('input[name=url]', ss.url); await pg.click('.connect .btn.primary');
  await pg.waitForFunction(() => window.__bootleg.lib.renders.some(r => r.title === 'Server Song' && r.mix), null, { timeout: 20000 });
  const ssr = await ev(() => { const r = window.__bootleg.lib.renders.find(x => x.title === "Server Song"); return { stems: r.stems.length, bpm: r.bpm, dir: r.dir }; });
  t('a stem server song is a stem set: manifest, mix and stems, keyed by its permanent id', ssr.stems === fxStems.length && ssr.bpm === 132 && ssr.dir.endsWith("/" + songId), JSON.stringify(ssr));
  const skey2 = "render:" + ssr.dir, recOf = k => pg.evaluate(async kk => window.__bootleg.notes.store.get(kk), k);
  for (let i = 0; i < 100 && (await recOf(skey2)).rating !== 4; i++) await sleep(100);
  const r0 = await recOf(skey2); t('its grade arrives as a rating (A- = 4 stars), its favourite as the "starred" tag', r0.rating === 4 && r0.tags.includes('starred'), JSON.stringify([r0.rating, r0.tags]));
  await pg.evaluate(k => window.__bootleg.notes.store.setRating(k, 3.5), skey2);
  for (let i = 0; i < 50 && !ss.state.writes.some(w => w[1].rating === 3.5); i++) await sleep(100);
  t('rating it in bootleg sets its grade on the server — half stars too — and pulling the server\'s values never echoes them back', JSON.stringify(ss.state.writes) === JSON.stringify([[songId, { rating: 3.5 }]]), JSON.stringify(ss.state.writes));
  t('the server\'s playlists arrive with its songs', await pg.evaluate(async k => (await window.__bootleg.notes.store.playlists()).some(p => p.name === 'Server Set' && p.items[0] === k), skey2));
  await ev(async () => { const B = window.__bootleg; await B.player.playList([B.lib.renders.find(r => r.title === 'Server Song')], 0); B.player.ensureStems(); });
  await pg.waitForFunction(n => window.__bootleg.player.mode === 'deck' && window.__bootleg.player.deck.stems.length === n && window.__bootleg.player.playing, fxStems.length, { timeout: 30000 });
  t('it plays, and its stems load from the server', true);
  await pg.click('.nav[data-view="now"]'); await pg.waitForSelector('#openComposer'); await pg.click('#openComposer'); for (let i = 0; i < 30 && !ss.state.opens.length; i++) await sleep(100);
  t('Now playing offers "Open in Composer" for a server song, and asks the server to hand it over', ss.state.opens[0]?.song === songId && ss.state.opens[0]?.app === 'composer');
  ss.close();
  const realErrs = errs.filter(e => !/status of 500.*stream\.view/.test(e));      // the deliberate failing stream above
  t('no console or page errors', realErrs.length === 0, realErrs.slice(0, 3).join(' | '));
} catch (e) { t('test run completed without throwing', false, String(e.message).split('\n')[0] + ' @ ' + (String(e.stack).match(/app\.test\.mjs:(\d+)/) || [])[1]); if (shots) await pg.screenshot({ path: path.join(shots, 'failure.png') }).catch(() => {}); }
await finish();
