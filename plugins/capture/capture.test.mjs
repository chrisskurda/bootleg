import { tracksFrom, addSplit, removeSplit, moveSplit, sideQuery, fillFrom, importInfo } from './capture-logic.js';
import { activate } from './index.js';
let bad = 0; const t = (n, ok, note = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${note ? '   ' + note : ''}`); if (!ok) bad++; };

const a = { start: 1.2, end: 600, splits: [200, 400] };
const tr = tracksFrom(a, 1); t('tracks from the analysis, numbered', tr.length === 3 && tr[0].start === 1.2 && tr[1].start === 200 && tr[2].end === 600 && tr.map(x => x.number).join() === '1,2,3');
t('side B numbering continues', tracksFrom(a, 6).map(x => x.number).join() === '6,7,8');
t('typed titles stay with their position when splits change', tracksFrom({ ...a, splits: [200, 400, 500] }, 1, [{ title: 'One' }, { title: 'Two' }])[1].title === 'Two');
t('splits: added in order, not on top of another or at the ends', addSplit([200, 400], 300, 1.2, 600).join() === '200,300,400' && addSplit([200], 201, 1.2, 600).length === 1 && addSplit([], 1.5, 1.2, 600).length === 0);
t('…removed, and moved without crossing a neighbour', removeSplit([200, 400], 0).join() === '400' && moveSplit([200, 400], 0, 500, 1.2, 600)[0] === 398);
const q = sideQuery({ album: 'LP', albumArtist: 'Band', year: '1977' }, tr); t('the lookup query carries the side\'s track lengths', q.kind === 'album' && q.album === 'LP' && Math.round(q.tracks[0].duration) === 199 && q.year === 1977);
// an LP of 6 tracks; side B is tracks 4-6
const lp = { artist: 'Band', tracks: [180, 220, 200, 199, 200, 200].map((d, i) => ({ number: i + 1, disc: 1, title: 'T' + (i + 1), duration: d, artist: 'Band' })) };
const sideB = tracksFrom({ start: 0, end: 599, splits: [199, 399] }, 1);
const f = fillFrom(sideB, lp); t('titles for side B come from where the lengths fit on the LP', f.offset === 3 && f.tracks.map(x => x.title).join() === 'T4,T5,T6' && f.tracks[0].number === 4, JSON.stringify(f.tracks.map(x => x.title)));
const info = importInfo([{ clicks: 3 }, { clicks: 0 }], { source: 'vinyl', deck: 'SL-1200', input: 'USB Codec', meta: { album: 'LP', albumArtist: 'Band' } }, '2026-11-26');
t('provenance and tag for the library', info.provenance.kind === 'vinyl-rip' && info.provenance.device === 'SL-1200 → USB Codec' && /3 clicks removed/.test(info.provenance.note) && info.tags[0] === 'vinyl-rip');

{ // the page's flow with a mocked native side
  const calls = [], set = new Map(); let imported = null;
  const api = { settings: { get: (k, d) => (set.has(k) ? set.get(k) : d), set: (k, v) => set.set(k, v) }, ui: { addView: () => () => {} }, dialog: { folder: async () => '/music' },
    metadata: { providers: [], lookup: async () => ({ candidates: [], errors: [] }) }, library: { roots: () => ['/music'], import: async (p, i) => { imported = { p, i }; } },
    native: {
      invoke: async (c, args) => { calls.push(c); return { backend_info: { backend: 'sim' }, devices: [{ id: 'sim:Deck', name: 'Simulated Deck', default: true, rates: [44100], channels: 2, defaultRate: 44100 }], recordings: [],
        analyze: { rate: 44100, channels: 2, seconds: 100, overview: [0.5], rmsDb: [], start: 1, end: 99, splits: [50], floorDb: -60, thresholdDb: -45 }, finish: true }[c]; },
      job: (c, args, on) => { calls.push(c + ':' + JSON.stringify(args).slice(0, 60)); if (c === 'record') { on({ type: 'event', data: { seconds: 1, peakDb: [-6, -7], rmsDb: [-20, -21], clipped: 0 } }); return { id: Promise.resolve(1), done: Promise.resolve({ path: '/rec/x.wav', rate: 44100, channels: 2, seconds: 100, clipped: 0, ended: 'finished' }), cancel() {} }; }
        return { id: Promise.resolve(2), done: Promise.resolve(args.request.tracks.map(x => ({ path: `/music/B/LP/0${x.number} ${x.title}.flac`, number: x.number, title: x.title, seconds: x.end - x.start, clicks: 2 }))), cancel() {} }; },
    } };
  const inst = activate(api); await inst._test.refresh(); inst._test.startRecording(); await new Promise(r => setTimeout(r, 20));
  t('record → levels → analysis → two tracks', inst._test.levels.peakDb[0] === -6 && inst._test.side?.tracks.length === 2 && calls.some(c => c.startsWith('record:{"device":"sim:Deck"')));
  inst._test.side.tracks[0].title = 'Opener'; await inst._test.saveTracks();
  t('save → files imported into the library with provenance', imported.p.length === 2 && imported.p[0].endsWith('01 Opener.flac') && imported.i.provenance.kind === 'vinyl-rip' && /4 clicks removed/.test(imported.i.provenance.note) && inst._test.saved.length === 2);
}
console.log(bad ? `\n${bad} FAILED` : '\nall capture tests pass'); process.exit(bad ? 1 : 0);
