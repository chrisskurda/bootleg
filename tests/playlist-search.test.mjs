import { searchPlaylists, summaryOf } from '../src/lib/playlist-search.js';
let bad = 0; const t = (n, ok, note = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${note ? '   ' + note : ''}`); if (!ok) bad++; };
const tr = (title, artist, album = '', extra = {}) => ({ title, artist, album, duration: 100, ...extra });
const T = { a: tr('Sunflower', 'Low', 'Things We Lost'), b: tr('Dinosaur Act', 'Low', 'Things We Lost'), c: tr('Lost Highway', 'Hank Williams'), d: tr('Café del Mar', 'Energy 52'), e: tr('Untitled', 'Duster', 'Stratosphere') };
const pls = [
  { id: '1', name: 'Road trip', items: ['a', 'c', 'd'], updated: 3 },
  { id: '2', name: 'Lost & found', items: ['e'], updated: 1 },
  { id: '3', name: 'Random 2024 mix', items: ['a', 'b', 'e', 'x'], updated: 2, server: { conn: 'nav' } },
];
const resolve = p => p.items.map(k => T[k]).filter(Boolean);
const names = r => r.map(x => x.p.name).join(' | ');

t('no query: everything, by name', names(searchPlaylists(pls, '', resolve)) === 'Lost & found | Random 2024 mix | Road trip');
t('sort by size and by recent change', names(searchPlaylists(pls, '', resolve, { sort: 'size' })).startsWith('Random') && names(searchPlaylists(pls, '', resolve, { sort: 'recent' })).startsWith('Road'));
const lost = searchPlaylists(pls, 'lost', resolve);
t('name matches first, then the most matching tracks', names(lost) === 'Lost & found | Random 2024 mix | Road trip', names(lost));
t('content matches list the tracks that matched', lost[1].hits.length === 2 && lost[2].hits.includes(T.c) && lost[0].nameHit);
t('every word must match (across title, artist, album)', names(searchPlaylists(pls, 'low sunflower', resolve)) === 'Random 2024 mix | Road trip');
t('accents and case are ignored', searchPlaylists(pls, 'CAFE', resolve)[0]?.p.id === '1');
t('mine / server filters', names(searchPlaylists(pls, '', resolve, { source: 'server' })) === 'Random 2024 mix' && searchPlaylists(pls, '', resolve, { source: 'mine' }).length === 2);
t('no match, nothing', searchPlaylists(pls, 'zzz', resolve).length === 0);
const s = summaryOf(resolve(pls[2]));
t('summary: most frequent artists first, count, length', s.artists === 'Low, Duster' && s.count === 3 && s.duration === 300, JSON.stringify(s));
t('summary shortens long artist lists', summaryOf(Object.values(T), 2).artists === 'Low, Duster, +2 more', summaryOf(Object.values(T), 2).artists);
console.log(bad ? `\n${bad} playlist search test(s) FAILED` : '\nall playlist search tests passed'); process.exit(bad ? 1 : 0);
