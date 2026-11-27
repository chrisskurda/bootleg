import { needed, PlayTracker, listenOf, lbBody, lfmSign, lfmForm, lfmScrobbleParams, lfmErrorAction, Queue } from './scrobble-logic.js';
import { md5 } from './md5.js';
import { activate } from './index.js';
let bad = 0; const t = (n, ok, note = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${note ? '   ' + note : ''}`); if (!ok) bad++; };

t('a track counts after half its length, at most 4 minutes; 30 s or shorter never', needed(200) === 100 && needed(600) === 240 && needed(30) === Infinity && needed(0) === 240);

// the tracker, on a fake clock
{ let now = 1_000_000_000; const tr = new PlayTracker({ now: () => now }), A = { kind: 'track', title: 'Song', artist: 'Band', duration: 100 };
  let ev = tr.tick(A, 0, true); t('a track that starts playing is announced (now playing), with its start time', ev.start?.title === 'Song' && ev.start.listenedAt === 1_000_000 && !ev.counted);
  const play = (secs, from) => { let e = {}; for (let i = 1; i <= secs; i++) { now += 1000; const r = tr.tick(A, from + i, true); if (r.counted) e = r; } return e; };
  ev = play(30, 0); t('not counted after 30 s of a 100 s track', !ev.counted);
  now += 20000; tr.tick(A, 30, false); t('paused time does not count', tr.cur.heard === 30);
  now += 1000; tr.tick(A, 90, true); t('a seek forward does not count as listening', tr.cur.heard === 30);
  ev = play(10, 90); t('…the next 10 s heard (40 total) still do not', !ev.counted);
  now += 1000; tr.tick(A, 0, true); ev = play(50, 0); t('playing it again from the top starts a new listen, which counts at 50 s', ev.counted?.title === 'Song' && ev.counted.listenedAt > 1_000_000);
  ev = play(10, 50); t('…once only', !ev.counted);
  const B = { kind: 'track', title: 'Other', artist: 'Band', duration: 600 }; now += 1000; ev = tr.tick(B, 0, true); t('a new track starts its own count', ev.start?.title === 'Other' && tr.cur.heard === 0);
  t('no artist or title: nothing is sent', listenOf({ title: 'x' }, 1) === null && listenOf({ artist: '', albumArtist: 'AA', title: 'x' }, 1).artist === 'AA'); }

// ListenBrainz
{ const l = listenOf({ title: 'T', artist: 'A', album: 'Al', duration: 201.4, track: 3, musicbrainzTrackId: 'rec-1' }, 1700000000);
  const b = lbBody('single', [l], { name: 'bootleg', version: '0.1.0' }), p = b.payload[0];
  t('a ListenBrainz listen has the timestamp, names, length and ids', b.listen_type === 'single' && p.listened_at === 1700000000 && p.track_metadata.artist_name === 'A' && p.track_metadata.release_name === 'Al' && p.track_metadata.additional_info.duration_ms === 201000 && p.track_metadata.additional_info.recording_mbid === 'rec-1' && p.track_metadata.additional_info.submission_client === 'bootleg');
  t('"playing now" carries no timestamp', !('listened_at' in lbBody('playing_now', [l]).payload[0])); }

// Last.fm
{ t('Last.fm signatures: parameters sorted, format left out, secret appended', lfmSign({ method: 'auth.getToken', api_key: 'k', format: 'json' }, 's', md5) === md5('api_keykmethodauth.getTokens'));
  t('md5 matches a known vector', md5('The quick brown fox jumps over the lazy dog') === '9e107d9d372bb6826bd81d3542a419d6');
  const f = new URLSearchParams(lfmForm('track.scrobble', lfmScrobbleParams([listenOf({ title: 'Ünï', artist: 'A', duration: 200 }, 5)]), { key: 'k', secret: 's', sk: 'S' }, md5));
  t('a scrobble batch is indexed (artist[0] …) and signed with the session key', f.get('artist[0]') === 'A' && f.get('track[0]') === 'Ünï' && f.get('timestamp[0]') === '5' && f.get('sk') === 'S' && f.get('format') === 'json' && f.get('api_sig') === lfmSign(Object.fromEntries([...f].filter(([k]) => k !== 'api_sig')), 's', md5));
  t('Last.fm errors: bad session → sign in again; offline/rate limit → retry; others → drop', lfmErrorAction(9) === 'auth' && lfmErrorAction(29) === 'retry' && lfmErrorAction(11) === 'retry' && lfmErrorAction(6) === 'drop'); }

// the queue
{ let now = 0, saved = null; const q = new Queue({ save: x => { saved = x; }, now: () => now });
  q.add('lb', { title: 'a' }); q.add('lb', { title: 'b' }); q.add('lfm', { title: 'a' });
  t('listens queue per service and are saved', q.count('lb') === 2 && q.count() === 3 && saved.length === 3);
  const w1 = q.failed('lb'), w2 = q.failed('lb'); t('failures back off 1, 2 … minutes and block the service', w1 === 60000 && w2 === 120000 && !q.ready('lb') && q.ready('lfm'));
  for (let i = 0; i < 10; i++) q.failed('lb'); t('…at most an hour', q.blockedUntil.lb - now === 3600000);
  q.done(q.take('lb', 1)); t('sent listens leave the queue', q.count('lb') === 1 && q.take('lb', 5)[0].listen.title === 'b'); }

// the plugin end to end, against mocked services
{ let now = 1_700_000_000_000; const realNow = Date.now; Date.now = () => now;
  const sec = new Map([['listenbrainzToken', 'LBTOK'], ['lastfmKey', 'K'], ['lastfmSecret', 'SEC'], ['lastfmSession', 'SK']]), set = new Map(), calls = [];
  let lbDown = true;
  const fetchMock = async (url, init = {}) => {
    calls.push({ url, init }); const json = (o, status = 200) => ({ ok: status < 400, status, headers: new Map(), json: async () => o, text: async () => JSON.stringify(o) });
    if (url.endsWith('/1/validate-token')) return json({ valid: init.headers.Authorization === 'Token LBTOK', user_name: 'lbuser' });
    if (url.endsWith('/1/submit-listens')) return lbDown ? json({}, 503) : json({ status: 'ok' });
    if (url.startsWith('https://ws.audioscrobbler.com')) { const p = new URLSearchParams(init.body); return json(p.get('method') === 'track.scrobble' ? { scrobbles: { '@attr': { accepted: 1, ignored: 0 } } } : {}); }
    throw new Error('unexpected ' + url);
  };
  const player = { item: null, playing: false, _pos: 0, pos() { return this._pos; } };
  const api = { player, net: { fetch: fetchMock }, secrets: { get: async k => sec.get(k) ?? null, set: async (k, v) => sec.set(k, v), delete: async k => sec.delete(k) }, settings: { get: (k, d) => (set.has(k) ? set.get(k) : d), set: (k, v) => set.set(k, v) }, ui: { addView: () => () => {}, openExternal: async () => {} } };
  const inst = activate(api); await new Promise(r => setTimeout(r, 20));
  const { tick, flush, queue, services } = inst._test;
  t('it signs in with the stored secrets', services[0].user === 'lbuser' && services[0].on && services[1].on);
  player.item = { kind: 'track', title: 'Live Song', artist: 'Band', album: 'Live', duration: 120 }; player.playing = true;
  for (let i = 0; i <= 61; i++) { player._pos = i; tick(); now += 1000; } await new Promise(r => setTimeout(r, 20));
  const np = calls.filter(c => (c.init.body || '').includes('playing_now') || (c.init.body || '').includes('updateNowPlaying'));
  t('"now playing" went to both services as the track started', np.length === 2);
  t('once it counted, Last.fm got it and ListenBrainz (down) kept it in the queue', queue.count('lastfm') === 0 && queue.count('listenbrainz') === 1 && calls.some(c => (c.init.body || '').includes('method=track.scrobble')));
  t('the queue is in the plugin settings, so it survives a restart', set.get('queue').length === 1);
  lbDown = false; await flush(); t('while backing off it does not hammer the service', queue.count('listenbrainz') === 1);
  now += 61000; await flush(); t('after the wait it is sent', queue.count('listenbrainz') === 0 && set.get('queue').length === 0);
  player.item = { kind: 'render', title: 'Demo', artist: 'Me', duration: 100 }; for (let i = 0; i <= 60; i++) { player._pos = i; tick(); now += 1000; }
  t('stem sets are left out unless chosen', queue.count() === 0 && !calls.some(c => (c.init.body || '').includes('Demo')));
  t('status line', /ListenBrainz \(lbuser\)/.test(inst.status()));
  inst.stop(); Date.now = realNow; }

console.log(bad ? `\n${bad} FAILED` : '\nall scrobble tests pass'); process.exit(bad ? 1 : 0);
