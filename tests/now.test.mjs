// Now playing: the song's spectrogram, how note callouts are laid out, what plays next, and the listening heatmap.
import { spectrogram } from '../src/lib/spectro.js';
import { layoutCallouts, upNext } from '../src/lib/now-view.js';
import { ListenHeat, MapKV, SpectroCache, BINS } from '../src/lib/listen-heat.js';
let bad = 0; const t = (n, ok, note = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${note ? '   ' + note : ''}`); if (!ok) bad++; };

// spectrogram: 2 s of a 220 Hz tone, then 2 s of a 4 kHz tone, at 22050 Hz
const rate = 22050, n = rate * 4, x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = Math.sin(2 * Math.PI * (i < n / 2 ? 220 : 4000) * i / rate) * 0.5;
const s = await spectrogram(x, rate, { cols: 40, rows: 64, yieldEvery: 0 });
const loudest = c => { let b = 0; for (let r = 1; r < s.rows; r++) if (s.data[c * s.rows + r] > s.data[c * s.rows + b]) b = r; return b; };
const hz = r => 30 * Math.pow(rate / 2 / 30, (r + 0.5) / s.rows);
t('the spectrogram has one byte per cell', s.data.length === 40 * 64 && s.cols === 40 && s.rows === 64);
t('first half: the loudest band is around 220 Hz', Math.abs(Math.log2(hz(loudest(5)) / 220)) < 0.4, hz(loudest(5)).toFixed(0) + ' Hz');
t('second half: the loudest band is around 4 kHz', Math.abs(Math.log2(hz(loudest(35)) / 4000)) < 0.4, hz(loudest(35)).toFixed(0) + ' Hz');
t('the loudest cell is 255, quiet cells are dark', Math.max(...s.data) === 255 && s.data[5 * s.rows + 60] < 80);
const silent = await spectrogram(new Float32Array(rate), rate, { cols: 10, rows: 16, yieldEvery: 0 }); t('silence does not crash (and is uniform)', new Set(silent.data).size === 1);

// callouts never overlap; one that fits in no lane keeps only its pin
const items = [0, 5, 10, 15, 300].map(x => ({ x, label: 'a fairly long note label' }));
const L = layoutCallouts(items, 600, 3), placed = L.filter(c => c.lane >= 0);
const overlaps = placed.some(a => placed.some(b => a !== b && a.lane === b.lane && a.left < b.left + b.w && b.left < a.left + a.w));
t('callouts are spread over lanes without overlapping', !overlaps && placed.length === 4 && L.filter(c => c.lane < 0).length === 1, JSON.stringify(L.map(c => c.lane)));
t('a callout near the right edge stays inside the timeline', layoutCallouts([{ x: 595, label: 'end' }], 600)[0].left + layoutCallouts([{ x: 595, label: 'end' }], 600)[0].w <= 600);

// up next follows play order and repeat
const q = ['a', 'b', 'c', 'd'].map(title => ({ title }));
const pl = (index, order, repeat = 'off') => ({ queue: q, index, order, repeat });
t('up next: the tracks after the current one, in play order', upNext(pl(1, [0, 1, 2, 3])).map(x => x.t.title).join() === 'c,d');
t('…shuffled order is followed', upNext(pl(2, [2, 0, 3, 1])).map(x => x.t.title).join() === 'a,d,b');
t('…and wraps around with repeat all', upNext(pl(3, [0, 1, 2, 3], 'all'), 2).map(x => x.t.title).join() === 'a,b');
t('…nothing after the last track without repeat', upNext(pl(3, [0, 1, 2, 3])).length === 0);

// listening heatmap
const kv = new MapKV(), heat = new ListenHeat(kv); await heat.load('k1');
for (let p = 0; p <= 30; p += 0.25) heat.tick(p, 120, true);                // heard 0–30 s of a 120 s song
heat.tick(90, 120, true); heat.tick(90.5, 120, true);                         // a seek to 90 s: the jump itself does not count
heat.tick(91, 120, false);                                                   // paused: nothing counts
const lv = heat.levels(120);
t('heard parts warm up, skipped parts stay cold', lv.length === BINS && lv[10] > 0 && lv[60] === 0 && lv.slice(0, 29).every(v => v > 0), lv.slice(0, 32).map(v => v.toFixed(2)).join(' '));
t('a seek does not paint the skipped stretch', lv.slice(31, 90).every(v => v === 0) && lv[90] > 0);
for (let r = 0; r < 4; r++) for (let p = 0; p <= 30; p += 0.25) heat.tick(p, 120, true);
t('replays make a part hotter, up to a cap', heat.levels(120)[10] === 1);
await heat.load('k2'); t('switching tracks saves the old one and starts the new one cold', heat.levels(120).every(v => v === 0) && (await kv.get('heat', 'k1'))?.length === BINS);
await heat.load('k1'); t('…and coming back restores it', heat.levels(120)[10] === 1);

// spectrogram cache keeps at most `keep`
const sc = new SpectroCache(kv, 3); const orig = Math.random; Math.random = () => 0;
for (let i = 0; i < 6; i++) { await sc.put('s' + i, { cols: 1, rows: 1, data: new Uint8Array(1) }); await new Promise(r => setTimeout(r, 2)); }
Math.random = orig; t('the spectrogram cache drops the oldest', (await kv.keys('spectro')).sort().join() === 's3,s4,s5', (await kv.keys('spectro')).join());
console.log(bad ? `\n${bad} FAILED` : '\nall now-playing tests pass'); process.exit(bad ? 1 : 0);
