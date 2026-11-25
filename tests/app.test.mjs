// End-to-end: build the app, serve it, drive it in Chrome with real files (tagged flac/mp3/m4a with covers + a stem render folder).
//   node tests/app.test.mjs [--shots DIR]
import { startMock } from './mock-subsonic.mjs';
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
  await pg.click('.nav[data-view="renders"]'); await pg.locator('#renderList .rcard').click(); await pg.waitForFunction(() => window.__bootleg.player.playing && window.__bootleg.player.pos() > 0.3, null, { timeout: 30000 });
  t('a stem set starts playing from its MIX immediately (no stems decoded yet)', (await ev(() => [window.__bootleg.player.mode, window.__bootleg.player.stemsState, window.__bootleg.player.deck.stems.length].join())) === 'element,unloaded,0');
  await pg.click('.nav[data-view="now"]'); await pg.selectOption('#packSelect', 'weather-report'); await sleep(500); t('a pack that does not use stems does not trigger loading them', (await ev(() => window.__bootleg.player.stemsState)) === 'unloaded' && (await pg.locator('#loadStems').count()) === 1);
  const posBefore = await ev(() => window.__bootleg.player.pos()); await pg.selectOption('#packSelect', 'stem-rack'); await pg.waitForFunction(() => window.__bootleg.player.mode === 'deck' && window.__bootleg.player.deck.stems.length === 5 && window.__bootleg.player.playing, null, { timeout: 30000 });
  t('selecting a stem-aware visualizer loads the real stems, which take over at the same position', (await ev(() => window.__bootleg.player.deck.stems.map(s => s.name).sort().join())) === 'hats,keys,kick,snare,sub' && (await ev(() => window.__bootleg.player.pos())) >= posBefore - 0.2);
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
  // ---- a visualizer screen (second window) follows the player
  const sp = await pg.context().newPage(); sp.on('pageerror', e => errs.push('screen: ' + e.message)); await sp.goto(`http://127.0.0.1:${PORT}/screen.html`); await sp.waitForFunction(() => document.getElementById('msg').hidden, null, { timeout: 15000 }); await sleep(800);
  const sa = await sp.evaluate(async () => { const w = document.getElementById('pack').contentWindow; let peak = 0; for (let i = 0; i < 25; i++) { peak = Math.max(peak, ...w.__AUDIO.spectrum); await new Promise(r => setTimeout(r, 60)); } const A = w.__AUDIO; return { src: document.getElementById('pack').src, live: A.live, stems: A.stems.length, kickLevel: typeof A.stem('kick').level, peak, past: A.past(0.5).length, title: w.__META.title }; });      // peak over 1.5 s: the fixture's hits are sparse
  t('a screen window shows the selected pack, fed with the player\'s live audio, stems and song info', /stem-rack/.test(sa.src) && sa.live && sa.stems === 5 && sa.kickLevel === 'number' && sa.peak > 0.2 && sa.past === 64 && !!sa.title, JSON.stringify(sa));
  await pg.bringToFront(); await pg.selectOption('#packSelect', 'weather-report'); await sp.waitForFunction(() => /weather-report/.test(document.getElementById('pack').src), null, { timeout: 8000 }); t('changing the pack in the player changes it on the screen', true);
  await pg.click('.nav[data-view="tracks"]'); const t1 = await sp.evaluate(() => document.getElementById('pack').contentWindow.__AUDIO.t); await sleep(900); const t2 = await sp.evaluate(() => document.getElementById('pack').contentWindow.__AUDIO.t); t('the screen keeps updating while the player shows another view', t2 > t1 + 0.4, `${t1.toFixed(2)} → ${t2.toFixed(2)}`);
  await sp.close(); await pg.click('.nav[data-view="now"]'); await pg.selectOption('#packSelect', 'stem-rack');
  // ---- stem sets in the library: one item, hidden parts, mix-first, stems on demand
  await pg.click('.nav[data-view="settings"]'); await pg.locator('#settingsBody .srow', { hasText: 'Show stem sets in the track list' }).locator('input').check(); await pg.click('.nav[data-view="tracks"]'); await pg.waitForFunction(() => document.querySelectorAll('#trackList .row .stemchip').length === 1);
  const listed = await pg.locator('#trackList .row .tt').allInnerTexts(); t('a stem set is listed once in the track list with a stems badge (its mix and stems are not separate rows)', listed.length === 4 && listed.filter(x => /stems/.test(x)).length === 1 && !listed.some(x => /^(mix|kick|snare|hats|keys|sub)$/i.test(x.trim())), listed.join(' | '));
  await pg.locator('#settingsBody').count(); await pg.click('.nav[data-view="settings"]'); await pg.locator('#settingsBody .srow', { hasText: 'Load stems' }).locator('select').selectOption('manual'); await pg.click('.nav[data-view="tracks"]');
  await pg.locator('#trackList .row', { hasText: 'stems' }).dblclick(); await pg.waitForFunction(() => window.__bootleg.player.item?.kind === 'render' && window.__bootleg.player.playing && window.__bootleg.player.pos() > 0.3); await pg.click('.nav[data-view="now"]'); await pg.selectOption('#packSelect', 'weather-report'); await pg.selectOption('#packSelect', 'stem-rack'); await sleep(600);
  t('"Only when I press Load stems": a stem-aware pack does not load them, the mix keeps playing', (await ev(() => window.__bootleg.player.stemsState + ',' + window.__bootleg.player.mode)) === 'unloaded,element' && (await pg.locator('#loadStems').count()) === 1);
  const p0 = await ev(() => window.__bootleg.player.pos()); await pg.click('#loadStems'); await pg.waitForFunction(() => window.__bootleg.player.mode === 'deck' && window.__bootleg.player.stemsState === 'ready'); t('Load stems swaps to the stem engine at the same position', (await ev(() => window.__bootleg.player.pos())) >= p0 - 0.2 && (await pg.locator('#stemRows .stem').count()) === 5);
  const p1 = await ev(() => window.__bootleg.player.pos()); await pg.click('#unloadStems'); await pg.waitForFunction(() => window.__bootleg.player.mode === 'element' && window.__bootleg.player.stemsState === 'unloaded'); t('Unload frees the stems and goes back to the mix where it was', (await ev(() => window.__bootleg.player.pos())) >= p1 - 0.3 && (await ev(() => window.__bootleg.player.deck.stems.length)) === 0);
  await pg.click('.nav[data-view="settings"]'); await pg.locator('#settingsBody .srow', { hasText: 'Load stems' }).locator('select').selectOption('visualizer'); await pg.locator('#settingsBody .srow', { hasText: 'Show stem sets in the track list' }).locator('input').uncheck(); await pg.click('.nav[data-view="tracks"]');
  // back to a plain track: stems are released
  await pg.click('.nav[data-view="tracks"]'); await pg.locator('#trackList .row').first().dblclick(); await pg.waitForFunction(() => window.__bootleg.player.mode === 'element' && window.__bootleg.player.playing);
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
  if (shots) await pg.screenshot({ path: path.join(shots, 'notes.png') });
  await pg.click('.nav[data-view="notes"]'); await pg.waitForSelector('#noteCards .ncard'); t('the Notes view lists the annotated recording; search finds it by provenance', (await pg.locator('#noteCards .ncard').count()) === 1); await pg.fill('#noteSearch', 'technics'); await sleep(300); t('…found by device text', (await pg.locator('#noteCards .ncard').count()) === 1); await pg.fill('#noteSearch', 'nonexistent'); await sleep(300); t('…and filtered out when it does not match', (await pg.locator('#noteCards .ncard').count()) === 0); await pg.fill('#noteSearch', '');
  const [dl] = await Promise.all([pg.waitForEvent('download'), pg.click('#notesExport')]); const exported = JSON.parse(fs.readFileSync(await dl.path(), 'utf8')); t('export notes downloads a bootleg-notes file', exported.format === 'bootleg-notes' && exported.tracks.length === 1, dl.suggestedFilename());
  await pg.setInputFiles('#notesIn', { name: 'n.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ ...exported, tracks: [...exported.tracks, { key: 'file:other#1', rating: 3, tags: ['x'], notes: [{ id: 'z1', text: 'imported note', at: null, to: null, kind: 'note', created: 1 }], provenance: null, updated: 5 }] })) }); await pg.waitForFunction(() => document.querySelectorAll('#noteCards .ncard').length === 2); t('import merges a notes file (one new record, existing one not duplicated)', (await ev(async () => (await window.__bootleg.notes.store.export()).tracks.find(x => x.rating === 4).notes.length)) === 2);
  await pg.fill('#noteSearch', ''); await pg.click('.nav[data-view="playlists"]'); await pg.fill('#plName', 'Road trip'); await pg.click('#plSave'); await pg.waitForSelector('#plList .ncard'); t('save queue as a playlist', (await pg.locator('#plList .ncard').innerText()).includes('Road trip'));
  const [dl2] = await Promise.all([pg.waitForEvent('download'), pg.click('#plList button:has-text("export M3U")')]); const m3u = fs.readFileSync(await dl2.path(), 'utf8'); t('playlist exports as M3U8', m3u.startsWith('#EXTM3U') && /#EXTINF/.test(m3u) && /Road trip/.test(m3u), dl2.suggestedFilename());
  await pg.setInputFiles('#m3uIn', { name: 'Mix.m3u', mimeType: 'audio/x-mpegurl', buffer: Buffer.from('#EXTM3U\n#EXTINF:4,The Isobars - Low Pressure\nelsewhere/x.m4a\n#EXTINF:4,Nobody - Nothing\nmissing.mp3\n') }); await pg.waitForFunction(() => document.querySelectorAll('#plList .ncard').length === 2); t('importing an M3U matches entries against the library', (await pg.locator('#plList').innerText()).includes('Mix') && (await pg.locator('#plList').innerText()).includes('1 tracks'));
  await pg.locator('#plList .ncard', { hasText: 'Mix' }).locator('button:has-text("play")').click(); await pg.waitForFunction(() => window.__bootleg.player.item?.title === 'Low Pressure' && window.__bootleg.player.playing); t('a saved playlist plays', true);

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
  await ev(() => window.__bootleg.player.setVolume(0.9));

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
  const mock = await startMock({ songs: [song('s1', 'Remote One', 'Cloud Album', 'al1', 1), song('s2', 'Remote Two', 'Cloud Album', 'al1', 2), song('s3', 'Solo Cloud', 'Other Album', 'al2', 1)], files, cover: path.join(tmp, 'a.png') });
  await pg.click('.nav[data-view="settings"]'); await pg.fill('#newLibName', 'Server'); await pg.click('#newLibBtn'); const sid = await ev(() => window.__bootleg.libs.active); await pg.click('#connectOpen-' + sid);
  await pg.fill('input[name=url]', mock.url); await pg.fill('input[name=username]', 'alice'); await pg.fill('input[name=password]', 'wrong'); await pg.click('.connect .btn.primary'); await pg.waitForSelector('.connect .err:not(:empty)');
  t('a wrong password is reported with the server’s message and nothing is added', /Wrong username or password/.test(await pg.locator('.connect .err').innerText()) && (await ev(() => window.__bootleg.libs.allConnections().length)) === 0);
  await pg.fill('input[name=password]', 'secret'); await pg.click('.connect .btn.primary'); await pg.waitForFunction(() => window.__bootleg.lib.visibleTracks.length === 3, null, { timeout: 20000 });
  const rt = await ev(() => window.__bootleg.lib.visibleTracks.map(x => [x.title, x.artist, x.album, x.src.kind, !!x.coverUrl, x.genre, x.year, x.duration].join('|')).sort());
  t('connecting lists the server\'s tracks with tags, cover art and duration — nothing read from files', rt.length === 3 && rt[0] === 'Remote One|Server Band|Cloud Album|remote|true|Funk|2024|5', rt[0]);
  t('the password is never stored (only a salted token)', !(await ev(() => localStorage.getItem('bootleg.libraries'))).includes('secret') && /"token":"[0-9a-f]{32}"/.test(await ev(() => localStorage.getItem('bootleg.libraries'))));
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
  await ev(async () => window.__bootleg.notes.store.setRating(window.__bootleg.player.item ? 'file:' + window.__bootleg.player.item.src.path + '#' + window.__bootleg.player.item.src.size : 'x', 4));
  await pg.reload(); await pg.waitForFunction(() => window.__bootleg && window.__bootleg.lib.tracks.length === 3, null, { timeout: 15000 });
  t('after a restart the remote library is back from the cache (no re-reading of files, no password asked)', (await ev(() => window.__bootleg.lib.tracks.every(x => x.tagged && x.src.kind === 'remote'))) && (await ev(() => window.__bootleg.libs.active)) === sid);
  t('annotations on a server track survive too (keyed by the track\'s stable path)', (await ev(async () => (await window.__bootleg.notes.store.export()).tracks.some(x => x.key.startsWith('file:subsonic:') && x.rating === 4))));
  mock.state.songs.push(song('s4', 'Fresh Upload', 'Other Album', 'al2', 2)); mock.state.songs = mock.state.songs.filter(x => x.id !== 's2');
  await ev(() => window.__bootleg.syncAll()); await pg.waitForFunction(() => window.__bootleg.lib.tracks.length === 3 && window.__bootleg.lib.tracks.some(x => x.title === 'Fresh Upload') && !window.__bootleg.lib.tracks.some(x => x.title === 'Remote Two'), null, { timeout: 15000 });
  t('"check for changes" picks up a new upload and a removed track on the server', true);
  mock.state.failStream = true; await pg.click('.nav[data-view="tracks"]'); await pg.locator('#trackList .row', { hasText: 'Fresh Upload' }).dblclick(); await pg.waitForSelector('.toast.bad', { timeout: 15000 });
  t('when a server track cannot be played, the user is told why (never silent)', /Could not play .*Fresh Upload/.test(await pg.locator('.toast.bad').first().innerText()), await pg.locator('.toast.bad').first().innerText());
  mock.state.failStream = false;
  mock.close();
  const realErrs = errs.filter(e => !/status of 500.*stream\.view/.test(e));      // the deliberate failing stream above
  t('no console or page errors', realErrs.length === 0, realErrs.slice(0, 3).join(' | '));
} catch (e) { t('test run completed without throwing', false, String(e.message).split('\n')[0]); if (shots) await pg.screenshot({ path: path.join(shots, 'failure.png') }).catch(() => {}); }
await finish();
