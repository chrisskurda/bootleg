// Performance benchmark with a big synthetic library (pre-tagged sources, no files):  node tests/perf.mjs [tracks=20000] [--cpu 4]
// --cpu N throttles the CPU N× to imitate a weaker machine. Prints timings; exits non-zero if the budgets below are blown.
import { chromium } from 'playwright-core'; import { spawn, spawnSync } from 'node:child_process';
const N = +(process.argv.find(a => /^\d+$/.test(a)) || 20000), ci = process.argv.indexOf('--cpu'), CPU = ci > 0 ? +process.argv[ci + 1] : 1, PORT = 8800 + Math.floor(Math.random() * 90);
spawnSync('node', ['scripts/build.mjs'], { stdio: 'ignore' });
const srv = spawn('node', ['scripts/serve.mjs', '--port', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] }); await new Promise(ok => srv.stdout.on('data', d => /bootleg:/.test(d) && ok()));
const browser = await chromium.launch({ channel: 'chrome' }), pg = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
if (CPU > 1) { const c = await pg.context().newCDPSession(pg); await c.send('Emulation.setCPUThrottlingRate', { rate: CPU }); }
await pg.goto(`http://127.0.0.1:${PORT}/`); await pg.waitForFunction(() => window.__bootleg && window.__bootleg.viz.packs.length > 30);
await pg.evaluate(() => { window.__long = []; new PerformanceObserver(l => { for (const e of l.getEntries()) window.__long.push(e.duration); }).observe({ entryTypes: ['longtask'] }); });
const r = await pg.evaluate(async N => {
  const B = window.__bootleg, out = {}, t = (k, f) => { const a = performance.now(); const v = f(); out[k] = Math.round(performance.now() - a); return v; };
  const srcs = Array.from({ length: N }, (_, i) => ({ kind: 'remote', name: `T${i}.flac`, path: `bench:x/a${i % 500}/Album ${i % 2000}/t${i}.flac`, size: 1000 + i, mtime: 1, url: () => '', reader: null, text: async () => '',
    meta: { title: `Track ${i} ${['Alpha', 'Beta', 'Gamma', 'Delta'][i % 4]}`, artist: `Artist ${i % 500}`, album: `Album ${i % 2000}`, albumArtist: '', year: 2000 + i % 25, track: i % 12 + 1, disc: 1, genre: 'Rock', duration: 150 + i % 200, coverUrl: null, remote: 'bench' } }));
  t('add', () => B.lib.add(srcs, 'music'));
  const t0 = performance.now(); await new Promise(r => { const w = () => (document.querySelectorAll('#trackList .row').length ? r() : setTimeout(w, 5)); w(); }); out.firstRows = Math.round(performance.now() - t0);
  out.rowsInDom = document.querySelectorAll('#trackList .row').length; out.domNodes = document.getElementsByTagName('*').length;
  t('sortedTracks', () => B.lib.sortedTracks()); t('sortedTracks again', () => B.lib.sortedTracks()); t('albums', () => B.lib.albums()); t('albums again', () => B.lib.albums()); t('search', () => B.lib.search(B.lib.sortedTracks(), 'alpha artist 4'));
  const a = performance.now(); document.querySelector('.nav[data-view="albums"]').click(); await new Promise(r => requestAnimationFrame(() => setTimeout(r, 0))); out.albumsView = Math.round(performance.now() - a); out.albumDom = document.getElementsByTagName('*').length;
  const b = performance.now(); document.querySelector('.nav[data-view="tracks"]').click(); await new Promise(r => requestAnimationFrame(() => setTimeout(r, 0))); out.backToTracks = Math.round(performance.now() - b);
  const s = document.getElementById('search'), c = performance.now(); s.value = 'beta artist 12'; s.dispatchEvent(new Event('input')); await new Promise(r => requestAnimationFrame(() => setTimeout(r, 0))); out.searchTyped = Math.round(performance.now() - c);
  const list = document.getElementById('trackList'), sc = list.closest('#main') || list.parentElement, d = performance.now(); sc.scrollTop = 5000; await new Promise(r => requestAnimationFrame(() => setTimeout(r, 30))); out.scroll = Math.round(performance.now() - d);
  out.longTasksOver100ms = window.__long.filter(x => x > 100).length; out.longestTask = Math.round(Math.max(0, ...window.__long)); out.totalLongMs = Math.round(window.__long.reduce((x, y) => x + y, 0));
  return out;
}, N);
console.log(`tracks=${N} cpu×${CPU}`); console.table(r);
await browser.close(); srv.kill();
const budget = { sortedTracksAgain: 5, albumsAgain: 5, firstRows: 1500, albumsView: 1500, longestTask: 800 }, bad = [];
if ((r['sortedTracks again'] ?? 0) > budget.sortedTracksAgain) bad.push('repeated sort not cached'); if ((r['albums again'] ?? 0) > budget.albumsAgain) bad.push('repeated albums() not cached'); if (r.rowsInDom > 400) bad.push('track list is not virtualized'); if (r.longestTask > budget.longestTask * CPU) bad.push('a task blocked the UI for ' + r.longestTask + ' ms');
if (bad.length) { console.error('PERF BUDGET FAILED:', bad.join('; ')); process.exit(1); } console.log('within budget');
