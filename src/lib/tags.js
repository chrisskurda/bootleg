// Song tags and cover art, read in the browser (or Node) without any library.
//   ID3v2.3 / 2.4 and ID3v1 (mp3), FLAC (Vorbis comments + PICTURE + STREAMINFO duration), MP4/M4A (ilst atoms + mvhd duration).
// The reader only fetches the byte ranges it needs, so a 200 MB flac is never loaded whole.
//
//   readTags(reader) -> { title, artist, albumArtist, album, year, track, trackTotal, disc, genre, bpm, key, lyrics, comment, composer, duration, cover }
//   reader = { size, read(offset, length) -> Promise<Uint8Array> }        cover = { mime, data: Uint8Array } | null
//   bufferReader(uint8array) makes a reader over bytes in memory.

export const bufferReader = u8 => ({ size: u8.length, read: async (o, l) => u8.subarray(o, Math.min(u8.length, o + l)) });
export const blobReader = blob => ({ size: blob.size, read: async (o, l) => new Uint8Array(await blob.slice(o, Math.min(blob.size, o + l)).arrayBuffer()) });

const ascii = (u, a, b) => String.fromCharCode(...u.subarray(a, b));
const be32 = (u, o) => ((u[o] * 0x1000000) + (u[o + 1] << 16) + (u[o + 2] << 8) + u[o + 3]) >>> 0;
const le32 = (u, o) => (u[o] | (u[o + 1] << 8) | (u[o + 2] << 16) | (u[o + 3] << 24)) >>> 0;
const synchsafe = (u, o) => (u[o] << 21) | (u[o + 1] << 14) | (u[o + 2] << 7) | u[o + 3];
const unsync = u => { const o = []; for (let i = 0; i < u.length; i++) { o.push(u[i]); if (u[i] === 0xff && u[i + 1] === 0) i++; } return Uint8Array.from(o); };
const parseNum = s => { const m = /^\s*(\d+)\s*(?:\/\s*(\d+))?/.exec(String(s ?? '')); return m ? [+m[1], m[2] ? +m[2] : undefined] : [undefined, undefined]; };
const clean = s => String(s ?? '').replace(/\0+$/g, '').trim();
const first = (...v) => v.find(x => x !== undefined && x !== null && x !== '' && !(typeof x === 'number' && isNaN(x)));

function decodeText(enc, u) {
  if (enc === 0) return new TextDecoder('windows-1252').decode(u);
  if (enc === 1) { if (u[0] === 0xfe && u[1] === 0xff) return new TextDecoder('utf-16be').decode(u.subarray(2)); if (u[0] === 0xff && u[1] === 0xfe) return new TextDecoder('utf-16le').decode(u.subarray(2)); return new TextDecoder('utf-16le').decode(u); }
  if (enc === 2) return new TextDecoder('utf-16be').decode(u);
  return new TextDecoder('utf-8').decode(u);
}
// index just past the terminator of a text field that starts at `p` in encoding `enc`
function endOfText(u, p, enc) { if (enc === 1 || enc === 2) { for (let i = p; i + 1 < u.length; i += 2) if (u[i] === 0 && u[i + 1] === 0) return [i, i + 2]; return [u.length, u.length]; } for (let i = p; i < u.length; i++) if (u[i] === 0) return [i, i + 1]; return [u.length, u.length]; }

// ------------------------------------------------------------------ ID3v2
async function readID3v2(r) {
  const h = await r.read(0, 10); if (h.length < 10 || ascii(h, 0, 3) !== 'ID3') return null;
  const ver = h[3], flags = h[5], size = synchsafe(h, 6); if (ver < 3 || ver > 4) return null;   // 2.2 (3-letter frames) is rare; not read
  let body = await r.read(10, Math.min(size, 16 << 20)); if (ver === 3 && (flags & 0x80)) body = unsync(body);
  let p = 0; if (flags & 0x40) p = ver === 4 ? synchsafe(body, 0) : 4 + be32(body, 0);   // extended header
  const t = {}, pics = [];
  while (p + 10 <= body.length) {
    const id = ascii(body, p, p + 4); if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const fsz = ver === 4 ? synchsafe(body, p + 4) : be32(body, p + 4), f1 = body[p + 9]; p += 10; if (fsz <= 0 || p + fsz > body.length) break;
    let d = body.subarray(p, p + fsz); p += fsz;
    if (ver === 4) { if (f1 & 0x01) d = d.subarray(4); if (f1 & 0x02) d = unsync(d); }
    if (id[0] === 'T' && id !== 'TXXX') { const v = decodeText(d[0], d.subarray(1)).split('\0').map(clean).filter(Boolean); if (v.length) t[id] = v.join(' / '); }
    else if (id === 'TXXX') { const e = d[0], [a, b] = endOfText(d, 1, e), key = clean(decodeText(e, d.subarray(1, a))).toUpperCase(), val = clean(decodeText(e, d.subarray(b))); if (key && val) t['TXXX:' + key] = val; }
    else if (id === 'USLT') { const e = d[0], [, b] = endOfText(d, 4, e); t.USLT = clean(decodeText(e, d.subarray(b))); }
    else if (id === 'COMM') { const e = d[0], [, b] = endOfText(d, 4, e); t.COMM = clean(decodeText(e, d.subarray(b))); }
    else if (id === 'APIC') { const e = d[0]; let i = 1; while (i < d.length && d[i] !== 0) i++; const mime = ascii(d, 1, i) || 'image/jpeg', type = d[i + 1], [, b] = endOfText(d, i + 2, e); pics.push({ type, mime: /^image\//.test(mime) ? mime : 'image/' + mime.toLowerCase(), data: d.subarray(b).slice() }); }
  }
  const pic = pics.find(x => x.type === 3) || pics[0], [trk, trkTotal] = parseNum(t.TRCK), [disc] = parseNum(t.TPOS);
  // BPM and key: many taggers (and ffmpeg) write them as TXXX frames instead of TBPM / TKEY, so both forms are read
  return { title: t.TIT2, artist: t.TPE1, albumArtist: t.TPE2, album: t.TALB, year: (t.TDRC || t.TYER || '').slice(0, 4), track: trk, trackTotal: trkTotal, disc, genre: t.TCON, bpm: parseFloat(t.TBPM || t['TXXX:BPM']) || undefined, key: t.TKEY || t['TXXX:INITIALKEY'] || t['TXXX:KEY'], lyrics: t.USLT, comment: t.COMM, composer: t.TCOM, cover: pic ? { mime: pic.mime, data: pic.data } : null };
}
async function readID3v1(r) {
  if (r.size < 128) return null; const u = await r.read(r.size - 128, 128); if (ascii(u, 0, 3) !== 'TAG') return null;
  const f = (a, b) => clean(new TextDecoder('windows-1252').decode(u.subarray(a, b)));
  return { title: f(3, 33), artist: f(33, 63), album: f(63, 93), year: f(93, 97), track: u[125] === 0 && u[126] ? u[126] : undefined, cover: null };
}

// ------------------------------------------------------------------ FLAC / Vorbis comments
function vorbisComments(u) {
  const o = {}; let p = 4 + le32(u, 0), n = le32(u, p); p += 4;
  for (let i = 0; i < n && p + 4 <= u.length; i++) { const l = le32(u, p); p += 4; const s = new TextDecoder('utf-8').decode(u.subarray(p, p + l)); p += l; const k = s.indexOf('='); if (k > 0) (o[s.slice(0, k).toUpperCase()] ||= []).push(s.slice(k + 1)); }
  return o;
}
function flacPicture(u) {
  let p = 0; const type = be32(u, p); p += 4; const ml = be32(u, p); p += 4; const mime = ascii(u, p, p + ml); p += ml; const dl = be32(u, p); p += 4 + dl; p += 16; const n = be32(u, p); p += 4;
  return { type, mime: mime || 'image/jpeg', data: u.subarray(p, p + n).slice() };
}
function fromVorbis(v, pics, duration) {
  const one = k => first(...(v[k] || [])), [trk, trkTotal] = parseNum(one('TRACKNUMBER')), [disc] = parseNum(one('DISCNUMBER')), pic = pics.find(x => x.type === 3) || pics[0];
  return { title: one('TITLE'), artist: (v.ARTIST || []).join(' / ') || undefined, albumArtist: one('ALBUMARTIST'), album: one('ALBUM'), year: (one('DATE') || one('YEAR') || '').slice(0, 4), track: trk, trackTotal: first(parseNum(one('TRACKTOTAL') || one('TOTALTRACKS'))[0], trkTotal),
    disc, genre: one('GENRE'), bpm: parseFloat(one('BPM')) || undefined, key: one('INITIALKEY') || one('KEY'), lyrics: one('LYRICS') || one('UNSYNCEDLYRICS'), comment: one('COMMENT') || one('DESCRIPTION'), composer: one('COMPOSER'), duration, cover: pic ? { mime: pic.mime, data: pic.data } : null };
}
async function readFlac(r) {
  if (ascii(await r.read(0, 4), 0, 4) !== 'fLaC') return null;
  let off = 4, duration, vc = {}; const pics = [];
  for (let n = 0; n < 64 && off + 4 <= r.size; n++) {
    const h = await r.read(off, 4), last = h[0] & 0x80, type = h[0] & 0x7f, len = (h[1] << 16) | (h[2] << 8) | h[3]; off += 4;
    if (type === 0) { const d = await r.read(off, 34), sr = (d[10] << 12) | (d[11] << 4) | (d[12] >> 4), total = (d[13] & 0xf) * 2 ** 32 + be32(d, 14); if (sr) duration = total / sr; }
    else if (type === 4 && len < (4 << 20)) vc = vorbisComments(await r.read(off, len));
    else if (type === 6 && len < (24 << 20)) pics.push(flacPicture(await r.read(off, len)));
    off += len; if (last) break;
  }
  return fromVorbis(vc, pics, duration);
}

// ------------------------------------------------------------------ MP4 / M4A
function* atoms(u, start, end) {
  let p = start; while (p + 8 <= end) { let size = be32(u, p), hs = 8; const type = ascii(u, p + 4, p + 8); if (size === 1) { size = be32(u, p + 8) * 2 ** 32 + be32(u, p + 12); hs = 16; } else if (size === 0) size = end - p; if (size < hs || p + size > end) return; yield { type, start: p + hs, end: p + size }; p += size; }
}
const find = (u, a, b, type) => { for (const x of atoms(u, a, b)) if (x.type === type) return x; return null; };
async function readMp4(r) {
  const h = await r.read(0, 12); if (ascii(h, 4, 8) !== 'ftyp') return null;
  let off = 0, moov = null; while (off + 8 <= r.size) { const hd = await r.read(off, 16); let size = be32(hd, 0); const type = ascii(hd, 4, 8); if (size === 1) size = be32(hd, 8) * 2 ** 32 + be32(hd, 12); else if (size === 0) size = r.size - off; if (type === 'moov') { moov = { off, size }; break; } if (size < 8) break; off += size; }
  if (!moov) return {}; const u = await r.read(moov.off + 8, Math.min(moov.size - 8, 48 << 20)), end = u.length;
  let duration; const mv = find(u, 0, end, 'mvhd'); if (mv) { const v = u[mv.start], ts = be32(u, mv.start + (v === 1 ? 20 : 12)), d = v === 1 ? be32(u, mv.start + 24) * 2 ** 32 + be32(u, mv.start + 28) : be32(u, mv.start + 16); if (ts) duration = d / ts; }
  const t = {}; let cover = null; const ud = find(u, 0, end, 'udta'), mt = ud && find(u, ud.start, ud.end, 'meta'), il = mt && find(u, mt.start + 4, mt.end, 'ilst');
  if (il) for (const it of atoms(u, il.start, il.end)) {
    const d = find(u, it.start, it.end, 'data'); if (!d) continue; const flag = be32(u, d.start) & 0xffffff, pay = u.subarray(d.start + 8, d.end);
    if (it.type === 'covr') { cover = { mime: flag === 14 ? 'image/png' : 'image/jpeg', data: pay.slice() }; continue; }
    const key = it.type.replace(/©/g, '(c)'); t[key] = flag === 1 || flag === 0 && it.type !== 'trkn' && it.type !== 'disk' && it.type !== 'tmpo' ? new TextDecoder('utf-8').decode(pay) : pay;
  }
  const txt = k => (typeof t[k] === 'string' ? clean(t[k]) : undefined), trkn = t.trkn instanceof Uint8Array ? [(t.trkn[2] << 8) | t.trkn[3], (t.trkn[4] << 8) | t.trkn[5] || undefined] : [], disk = t.disk instanceof Uint8Array ? (t.disk[2] << 8) | t.disk[3] : undefined, tmpo = t.tmpo instanceof Uint8Array ? (t.tmpo[0] << 8) | t.tmpo[1] : undefined;
  return { title: txt('(c)nam'), artist: txt('(c)ART'), albumArtist: txt('aART'), album: txt('(c)alb'), year: (txt('(c)day') || '').slice(0, 4), track: trkn[0] || undefined, trackTotal: trkn[1], disc: disk || undefined, genre: txt('(c)gen'), bpm: tmpo || undefined,
    lyrics: txt('(c)lyr'), comment: txt('(c)cmt'), composer: txt('(c)wrt'), duration, cover };
}

// ------------------------------------------------------------------ entry point
export async function readTags(reader) {
  const head = await reader.read(0, 12); let r = null;
  try {
    if (ascii(head, 0, 3) === 'ID3') r = await readID3v2(reader);
    else if (ascii(head, 0, 4) === 'fLaC') r = await readFlac(reader);
    else if (head.length >= 8 && ascii(head, 4, 8) === 'ftyp') r = await readMp4(reader);
    if (!r) r = await readID3v1(reader);      // an mp3 without ID3v2 may still carry the old trailing tag
  } catch { r = null; }                        // a damaged tag must never break scanning a library
  return Object.fromEntries(Object.entries(r || {}).filter(([, v]) => v !== undefined && v !== ''));
}
