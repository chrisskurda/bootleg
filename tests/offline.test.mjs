import { ruleTracks, sourcesOf, canKeep, jobFor, wantedBy, planOffline, bestCopies, isKept, addRule, removeRule, moveRule, hasRule, ruleLabel } from '../src/lib/offline.js';
import { subsonic } from '../src/lib/sources/subsonic.js';
let bad = 0; const t = (n, ok, note = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${note ? '   ' + note : ''}`); if (!ok) bad++; };

// a Subsonic connection, a stem server that does not allow offline copies, and a local file on a share
const plugins = { subsonic, locked: { id: 'locked', streamUrl: () => 'x' } }, getPlugin = id => plugins[id] || null;
const sessionOf = r => r.plugin === 'subsonic' ? { config: { username: 'u', token: 't', salt: 's' }, base: 'https://music' } : {};
const rem = (id, extra = {}) => ({ kind: 'remote', name: `${id}.flac`, path: `subsonic:c1/${id}`, size: 30e6, remote: { plugin: 'subsonic', conn: 'c1', item: { id, suffix: 'flac', size: 30e6, duration: 200, changed: 5, ...extra } } });
const tr = (id, src, more = {}) => ({ id, kind: 'track', title: id, src, ...more });
const a = tr('a', rem('a')), b = tr('b', rem('b')), c = tr('c', rem('c')), nas = tr('n', { kind: 'tauri', path: '/Volumes/NAS/x.flac', size: 20e6, mtime: 9 });
const lockedT = tr('l', { kind: 'remote', path: 'locked:c/1', remote: { plugin: 'locked', conn: 'c', item: { id: '1' } } });
const render = { id: 'r', kind: 'render', dir: '/r', mix: { kind: 'tauri', path: '/r/mix.flac', size: 9 }, manifestSrc: { kind: 'tauri', path: '/r/manifest.json', size: 1 }, stems: [{ name: 'kick', src: { kind: 'tauri', path: '/r/stems/kick.flac', size: 5 } }] };
const key = x => x.kind === 'render' ? 'render:' + x.dir : 'file:' + x.src.path + '#';
const byKey = new Map([a, b, c, nas, lockedT, render].map(x => [key(x), x]));
const ctx = { byKey, playlists: [{ id: 'p1', name: 'TestPlaylist', items: [key(a), key(b), key(lockedT), 'file:gone#'] }], albums: new Map([['X\u0000Y', { tracks: [c, nas] }]]), records: [{ key: key(c), rating: 5, tags: [] }, { key: key(nas), rating: 3, tags: ['starred'] }] };

t('playlist rule → its tracks that are in the library', ruleTracks({ type: 'playlist', id: 'p1' }, ctx).map(x => x.id).join() === 'a,b,l');
t('album, track, rating and starred rules', ruleTracks({ type: 'album', key: 'X\u0000Y' }, ctx).length === 2 && ruleTracks({ type: 'track', key: key(b) }, ctx)[0] === b && ruleTracks({ type: 'rating', min: 4 }, ctx)[0] === c && ruleTracks({ type: 'starred' }, ctx)[0] === nas);
t('stem set: mix + details, stems only when asked', sourcesOf(render).length === 2 && sourcesOf(render, { stems: true }).length === 3);
t('only plugins that allow offline copies (and local files) can be kept', canKeep(a.src, getPlugin) && canKeep(nas.src, getPlugin) && !canKeep(lockedT.src, getPlugin));

const jo = jobFor(a.src, 'original', { getPlugin, sessionOf }), jh = jobFor(a.src, 'high', { getPlugin, sessionOf }), jf = jobFor(nas.src, 'saver', { getPlugin, sessionOf });
t('original: the server\'s download, kept as the file it is', jo.id === 'subsonic:c1/a|original' && /download\.view/.test(jo.url) && jo.ext === 'flac' && jo.size === 30e6);
t('high: converted by the server, sized from the duration', jh.id === 'subsonic:c1/a|high' && /format=mp3&maxBitRate=320/.test(jh.url) && jh.ext === 'mp3' && jh.size === 200 * 320 * 125);
t('local files are copied as they are, whatever quality is asked', jf.id === '/Volumes/NAS/x.flac|original' && jf.path === nas.src.path && !jf.url);

const rules = [{ type: 'playlist', id: 'p1', name: 'TestPlaylist' }, { type: 'album', key: 'X\u0000Y', name: 'Y' }];
const w = wantedBy(rules, ctx, { getPlugin });
t('wanted: priority order, each source once, locked plugin left out', w.map(x => x.track.id).join() === 'a,b,c,n', w.map(x => x.track.id).join());

const wanted = w.map(x => ({ job: jobFor(x.src, 'original', { getPlugin, sessionOf }), rule: x.rule }));
const p = planOffline({ wanted, entries: [], maxBytes: 70e6 });
t('space limit: the last rules lose first', p.fetch.map(j => j.key).join() === 'subsonic:c1/a,subsonic:c1/b' && p.over.length === 2 && p.bytes === 60e6, JSON.stringify(p.fetch.map(j => j.key)));
const entries = [
  { id: 'subsonic:c1/a|original', key: 'subsonic:c1/a', quality: 'original', size: 30e6, fp: '30000000:5', played: 0, path: '/o/a.flac' },
  { id: 'subsonic:c1/old|original', key: 'subsonic:c1/old', quality: 'original', size: 10e6, fp: 'x', played: 100, path: '/o/old.flac' },
  { id: 'subsonic:c1/older|original', key: 'subsonic:c1/older', quality: 'original', size: 10e6, fp: 'x', played: 50, path: '/o/older.flac' },
  { id: 'subsonic:c1/unplayed|original', key: 'subsonic:c1/unplayed', quality: 'original', size: 1, fp: 'x', played: 0, path: '/o/u.flac' },
  { id: 'card|original', key: 'card', quality: 'original', size: 5e6, fp: 'x', played: 0, path: '/o/card.flac' },
];
const p2 = planOffline({ wanted, entries, maxBytes: 1e12, held: new Set(['card|original']), auto: true, autoBytes: 15e6 });
t('kept copies with the same fingerprint are not fetched again', !p2.fetch.some(j => j.id === 'subsonic:c1/a|original') && p2.keep.has('subsonic:c1/a|original'));
t('also keep what I play: most recent first, up to its own limit', p2.keep.has('subsonic:c1/old|original') && !p2.keep.has('subsonic:c1/older|original') && p2.autoBytes === 10e6);
t('nothing asks for it → removed; kept for a card → stays', p2.remove.includes('subsonic:c1/unplayed|original') && p2.remove.includes('subsonic:c1/older|original') && p2.keep.has('card|original'));
t('auto off: played tracks go too', planOffline({ wanted: [], entries, maxBytes: 1e12 }).remove.length === entries.length);
const changed = planOffline({ wanted: [{ job: { ...wanted[0].job, fp: 'new' }, rule: rules[0] }], entries, maxBytes: 1e12 });
t('a track that changed on the server is fetched again', changed.fetch.length === 1);

const copies = bestCopies([{ key: 'k', quality: 'saver', path: '/s' }, { key: 'k', quality: 'original', path: '/o' }, { key: 'k', quality: 'high', path: '/h' }]);
t('playback uses the best kept copy', copies.get('k').path === '/o');
t('isKept: every file an item needs is kept', isKept(a, new Map([['subsonic:c1/a', {}]])) && !isKept(render, new Map([['/r/mix.flac', {}]])));

let r = addRule([], rules[0]); r = addRule(r, rules[1]); r = addRule(r, rules[0]);
t('rules: adding again moves it to the end; move and remove', r.map(x => x.type).join() === 'album,playlist' && moveRule(r, rules[0], -1)[0].type === 'playlist' && removeRule(r, rules[1]).length === 1 && hasRule(r, { type: 'album', key: 'X\u0000Y' }));
t('labels', ruleLabel(rules[0]) === 'Playlist “TestPlaylist”' && ruleLabel({ type: 'rating', min: 4 }).includes('4★'));

console.log(bad ? `\n${bad} offline test(s) FAILED` : '\nall offline tests passed'); process.exit(bad ? 1 : 0);
