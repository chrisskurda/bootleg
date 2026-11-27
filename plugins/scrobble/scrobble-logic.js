// Scrobbling, the parts that don't touch the page or the network: when a play counts, what a listen looks like for
// ListenBrainz and Last.fm, Last.fm's request signing, and the offline queue with retry. Tested in scrobble.test.mjs.

/// The usual rule (Last.fm's, which ListenBrainz follows): a track counts once it has been *heard* for half its length
/// or 4 minutes, whichever comes first, and only if it is longer than 30 seconds. Unknown length: 4 minutes.
export const MIN_TRACK = 30, MAX_NEEDED = 240;
export function needed(duration) {
  if (!(duration > 0)) return MAX_NEEDED;
  if (duration <= MIN_TRACK) return Infinity;
  return Math.min(duration / 2, MAX_NEEDED);
}

/// Counts the time actually heard of the current track: pauses, seeks and skips don't count. Feed it the player's state
/// every so often with `tick`; it returns the listen once (when it starts counting) and `null` otherwise.
export class PlayTracker {
  constructor({ now = () => Date.now() } = {}) { this.now = now; this.cur = null; }
  /// item: the playing track or null; pos: seconds into it; playing: bool. Returns { start: listen, counted: listen } events.
  tick(item, pos, playing) {
    const t = this.now() / 1000, out = {};
    if (!this.cur || this.cur.item !== item) {
      this.cur = item ? { item, startedAt: Math.round(t), heard: 0, lastPos: pos, lastT: t, counted: false, announced: false } : null;
    }
    const c = this.cur; if (!c) return out;
    if (playing) {
      const dPos = pos - c.lastPos, dT = t - c.lastT;
      if (dPos > 0 && dPos <= dT * 2 + 1) c.heard += dPos;      // a jump further than the wall clock allows is a seek, not listening
      if (pos + 1 < c.lastPos && pos < 2) { Object.assign(c, { startedAt: Math.round(t), heard: 0, counted: false, announced: false }); }   // the same track again from the top (repeat)
      if (!c.announced) { c.announced = true; out.start = listenOf(c.item, c.startedAt); }
      if (!c.counted && c.heard >= needed(c.item.duration)) { c.counted = true; out.counted = listenOf(c.item, c.startedAt); }
    }
    c.lastPos = pos; c.lastT = t;
    return out;
  }
}

/// What gets sent, from a library track. `null` when there isn't enough to identify the recording.
export function listenOf(t, listenedAt) {
  const artist = (t.artist || t.albumArtist || '').trim(), title = (t.title || '').trim();
  if (!artist || !title) return null;
  return {
    listenedAt, artist, title, album: (t.album || '').trim(), albumArtist: (t.albumArtist || '').trim(),
    duration: t.duration > 0 ? Math.round(t.duration) : 0, track: t.track || 0,
    recordingMbid: t.musicbrainzTrackId || t.mbRecordingId || '', releaseMbid: t.musicbrainzAlbumId || t.mbReleaseId || '', isrc: t.isrc || '',
  };
}

// ── ListenBrainz ────────────────────────────────────────────────────────────────────────────────────────────────────
export const LB = 'https://api.listenbrainz.org';
export function lbPayload(l, client = { name: 'bootleg', version: '' }) {
  const info = { media_player: 'bootleg', submission_client: client.name, submission_client_version: client.version || undefined, duration_ms: l.duration ? l.duration * 1000 : undefined, tracknumber: l.track || undefined, recording_mbid: l.recordingMbid || undefined, release_mbid: l.releaseMbid || undefined, isrc: l.isrc || undefined };
  for (const k of Object.keys(info)) if (info[k] === undefined) delete info[k];
  const tm = { artist_name: l.artist, track_name: l.title, additional_info: info }; if (l.album) tm.release_name = l.album;
  return { listened_at: l.listenedAt, track_metadata: tm };
}
/// One request body: `playing_now` (no timestamp), `single`, or `import` for a batch from the queue.
export function lbBody(type, listens, client) {
  const payload = listens.map(l => lbPayload(l, client)); if (type === 'playing_now') delete payload[0].listened_at;
  return { listen_type: type, payload };
}

// ── Last.fm ─────────────────────────────────────────────────────────────────────────────────────────────────────────
export const LFM = 'https://ws.audioscrobbler.com/2.0/';
/// api_sig: md5 of every parameter (except format/callback) sorted by name as name+value, then the shared secret.
export function lfmSign(params, secret, md5) {
  const s = Object.keys(params).filter(k => k !== 'format' && k !== 'callback').sort().map(k => k + params[k]).join('');
  return md5(s + secret);      // md5.js hashes the UTF-8 bytes, which is what Last.fm signs
}
export function lfmScrobbleParams(listens) {
  const p = {};
  listens.forEach((l, i) => {
    p[`artist[${i}]`] = l.artist; p[`track[${i}]`] = l.title; p[`timestamp[${i}]`] = String(l.listenedAt);
    if (l.album) p[`album[${i}]`] = l.album; if (l.albumArtist && l.albumArtist !== l.artist) p[`albumArtist[${i}]`] = l.albumArtist;
    if (l.duration) p[`duration[${i}]`] = String(l.duration); if (l.track) p[`trackNumber[${i}]`] = String(l.track); if (l.recordingMbid) p[`mbid[${i}]`] = l.recordingMbid;
  });
  return p;
}
export function lfmNowPlayingParams(l) {
  const p = { artist: l.artist, track: l.title }; if (l.album) p.album = l.album; if (l.duration) p.duration = String(l.duration); if (l.track) p.trackNumber = String(l.track); return p;
}
/// Form body for a signed call: method + api_key + sk (when given) + params, then api_sig and format=json.
export function lfmForm(method, params, { key, secret, sk }, md5) {
  const p = { ...params, method, api_key: key }; if (sk) p.sk = sk;
  p.api_sig = lfmSign(p, secret, md5); p.format = 'json';
  return new URLSearchParams(p).toString();
}
/// Last.fm error codes → what to do: 'auth' (sign in again), 'retry', or 'drop' (the listen itself was refused).
export function lfmErrorAction(code) {
  if ([4, 9, 10, 14, 26].includes(code)) return 'auth';           // auth failed / invalid session / invalid key / not authorised / suspended key
  if ([8, 11, 16, 29].includes(code)) return 'retry';             // operation failed / offline / temporarily unavailable / rate limited
  return 'drop';
}

// ── The queue ───────────────────────────────────────────────────────────────────────────────────────────────────────
/// Counted listens waiting to be sent, per service, kept across restarts (`load`/`save` are the plugin's settings).
/// A failed send waits 1, 2, 4 … minutes (at most an hour) before the next try; refused listens are dropped and logged.
export const MAX_QUEUE = 5000;
export class Queue {
  constructor({ load = () => [], save = () => {}, now = () => Date.now() } = {}) { this.items = load() || []; this.save = save; this.now = now; this.blockedUntil = {}; this.tries = {}; }
  add(service, listen) { if (!listen) return; this.items.push({ service, listen }); if (this.items.length > MAX_QUEUE) this.items.splice(0, this.items.length - MAX_QUEUE); this.save(this.items); }
  count(service) { return this.items.filter(x => !service || x.service === service).length; }
  ready(service) { return !(this.blockedUntil[service] > this.now()); }
  /// The oldest `n` waiting for `service`.
  take(service, n) { return this.items.filter(x => x.service === service).slice(0, n); }
  done(entries) { const s = new Set(entries); this.items = this.items.filter(x => !s.has(x)); this.save(this.items); }
  failed(service) { const n = (this.tries[service] || 0) + 1; this.tries[service] = n; const wait = Math.min(60, 2 ** (n - 1)) * 60000; this.blockedUntil[service] = this.now() + wait; return wait; }
  ok(service) { this.tries[service] = 0; this.blockedUntil[service] = 0; }
  waitUntil(service, ms) { this.blockedUntil[service] = this.now() + ms; }
}
