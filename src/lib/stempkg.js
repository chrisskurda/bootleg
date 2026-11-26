// .bstem / .bsong packages (contracts/song_format.md in bootleg-stemserver): a song in one zip. Audio entries are stored
// uncompressed, so they are read straight out of the file — by range on the desktop, by slicing a File in the browser —
// and a package plays without being unpacked. JSON entries may be deflated (inflated with DecompressionStream).
// openPackage(source) → { manifest, entries: Map(path → {offset?, size, csize, method, header}), sourceFor(path) }
// A .dawproject is a song too: bootleg's own (a package under the DAW name: it carries manifest.json) or a DAW's export
// whose tracks are each one whole audio file from time 0 (a "stems" export) — anything arranged needs bootleg Composer.
export const PKG_RE = /\.(bstem|bsong|dawproject)$/i;
const AUDIO = /\.(flac|wav|mp3|m4a|aac|ogg|opus|aif|aiff|caf)$/i;
const MIME = { flac: 'audio/flac', wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', opus: 'audio/ogg', aif: 'audio/aiff', aiff: 'audio/aiff', caf: 'audio/x-caf', json: 'application/json', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const u16 = (b, o) => b[o] | (b[o + 1] << 8), u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0, u64 = (b, o) => u32(b, o) + u32(b, o + 4) * 2 ** 32;
const find = (b, sig) => { for (let i = b.length - 4; i >= 0; i--) if (u32(b, i) === sig) return i; return -1; };

// the zip's central directory → entries
export async function readDirectory(reader) {
  const size = reader.size, tailLen = Math.min(size, 65557), tail = await reader.read(size - tailLen, tailLen), e = find(tail, 0x06054b50);
  if (e < 0) throw new Error('not a zip file');
  let count = u16(tail, e + 10), cdSize = u32(tail, e + 12), cdOff = u32(tail, e + 16);
  if (cdOff === 0xffffffff || count === 0xffff || cdSize === 0xffffffff) {                       // zip64: the real numbers are in the zip64 record
    const loc = e - 20; if (loc < 0 || u32(tail, loc) !== 0x07064b50) throw new Error('zip64 locator missing');
    const rec = await reader.read(u64(tail, loc + 8), 56); if (u32(rec, 0) !== 0x06064b50) throw new Error('bad zip64 record');
    count = u64(rec, 32); cdSize = u64(rec, 40); cdOff = u64(rec, 48);
  }
  const cd = await reader.read(cdOff, cdSize), out = new Map(), dec = new TextDecoder();
  for (let p = 0, i = 0; i < count && p + 46 <= cd.length; i++) {
    if (u32(cd, p) !== 0x02014b50) throw new Error('bad zip directory');
    const method = u16(cd, p + 10), nlen = u16(cd, p + 28), xlen = u16(cd, p + 30), clen = u16(cd, p + 32);
    let csize = u32(cd, p + 20), usize = u32(cd, p + 24), header = u32(cd, p + 42);
    const name = dec.decode(cd.subarray(p + 46, p + 46 + nlen));
    for (let x = p + 46 + nlen, end = x + xlen; x + 4 <= end;) {                                   // zip64 extra field: sizes / offset that did not fit
      const id = u16(cd, x), len = u16(cd, x + 2);
      if (id === 1) { let q = x + 4; if (usize === 0xffffffff) { usize = u64(cd, q); q += 8; } if (csize === 0xffffffff) { csize = u64(cd, q); q += 8; } if (header === 0xffffffff) header = u64(cd, q); }
      x += 4 + len;
    }
    if (!name.endsWith('/')) out.set(name, { method, size: usize, csize, header });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

async function dataOffset(reader, ent) {
  if (ent.offset == null) { const h = await reader.read(ent.header, 30); if (u32(h, 0) !== 0x04034b50) throw new Error('bad zip entry'); ent.offset = ent.header + 30 + u16(h, 26) + u16(h, 28); }
  return ent.offset;
}
async function inflate(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
export async function readEntry(reader, ent) {
  const off = await dataOffset(reader, ent), raw = await reader.read(off, ent.method === 0 ? ent.size : ent.csize);
  if (ent.method === 0) return raw; if (ent.method === 8) return inflate(raw); throw new Error(`zip method ${ent.method} is not supported`);
}

// ---- DAWproject (https://github.com/bitwig/dawproject): just enough XML to read project.xml / metadata.xml
export function parseXml(text) {
  const root = { tag: '#root', attrs: {}, children: [], text: '' }, stack = [root];
  const ent = t => t.replace(/&(lt|gt|quot|apos|amp|#x[0-9a-f]+|#\d+);/gi, (m, e) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[e.toLowerCase()] ?? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)));
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<[?!][^>]*>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  for (let m; (m = re.exec(text));) {
    const top = stack[stack.length - 1];
    if (m[1] != null) top.text += m[1];
    else if (m[2]) { if (stack.length > 1) stack.pop(); }
    else if (m[3]) {
      const attrs = {}; for (const a of m[4].matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = ent(a[2] ?? a[3]);
      const el = { tag: m[3], attrs, children: [], text: '' }; top.children.push(el); if (!m[5]) stack.push(el);
    } else if (m[6]) top.text += ent(m[6]);
  }
  return root;
}
const kids = (el, tag) => (el ? el.children.filter(c => c.tag === tag) : []);
const kid = (el, tag) => kids(el, tag)[0] || null;
function* walk(el) { for (const c of el.children) { yield c; yield* walk(c); } }
const first = (el, tag) => { for (const c of walk(el)) if (c.tag === tag) return c; return null; };

// the `-- bootleg --` block a bootleg song keeps in metadata.xml's comment (song_format.md)
export function parseComment(text = '') {
  const i = text.lastIndexOf('-- bootleg --'); if (i < 0) return { comment: text.trim(), block: {} };
  const block = {}; for (const line of text.slice(i + 13).split(/\r?\n/)) { const k = line.indexOf(':'); if (k > 0) block[line.slice(0, k).trim().toLowerCase()] = line.slice(k + 1).trim(); }
  return { comment: text.slice(0, i).trim(), block };
}

// project.xml (+ metadata.xml) → { application, bpm, tracks: [{id, name, volume, clips: [{time, playStart, file, external, notes}]}], markers, meta, block }
export function readDawProject(projectXml, metadataXml) {
  const doc = parseXml(projectXml), project = kid(doc, 'Project'); if (!project) throw new Error('project.xml has no Project');
  const app = kid(project, 'Application'), tempo = first(kid(project, 'Transport') || { children: [] }, 'Tempo');
  const tracks = new Map();
  for (const t of walk(kid(project, 'Structure') || { children: [] })) {
    if (t.tag !== 'Track') continue; const ch = kid(t, 'Channel'); if (ch && ch.attrs.role === 'master') continue;
    const vol = ch && kid(ch, 'Volume'); tracks.set(t.attrs.id, { id: t.attrs.id, name: t.attrs.name || '', volume: vol && (vol.attrs.unit || 'linear') === 'linear' ? parseFloat(vol.attrs.value) : 1, clips: [] });
  }
  const arr = kid(project, 'Arrangement'), markers = [];
  if (arr) {
    for (const lane of walk(arr)) {
      if (lane.tag !== 'Lanes' || !lane.attrs.track || !tracks.has(lane.attrs.track)) continue;
      for (const clips of kids(lane, 'Clips')) for (const clip of kids(clips, 'Clip')) {
        const audio = first(clip, 'Audio'), file = audio && kid(audio, 'File');
        tracks.get(lane.attrs.track).clips.push({ time: parseFloat(clip.attrs.time || 0), playStart: parseFloat(clip.attrs.playStart || 0), file: file ? file.attrs.path : null, external: !!file && file.attrs.external === 'true', notes: !!first(clip, 'Notes'), seconds: audio ? parseFloat(audio.attrs.duration) : null });
      }
    }
    for (const m of walk(arr)) if (m.tag === 'Marker') markers.push({ time: parseFloat(m.attrs.time || 0), name: m.attrs.name || '' });
  }
  const meta = {}; if (metadataXml) { const md = kid(parseXml(metadataXml), 'MetaData'); for (const c of md ? md.children : []) meta[c.tag] = c.text.trim(); }
  const { comment, block } = parseComment(meta.Comment || '');
  return { application: app ? `${app.attrs.name || ''} ${app.attrs.version || ''}`.trim() : '', bpm: tempo ? parseFloat(tempo.attrs.value) : null, tracks: [...tracks.values()], markers, meta, comment, block };
}

// a player can use it when every track that sounds is one whole audio file in the package, from time 0
export function stemShaped(daw, has) {
  const audible = daw.tracks.filter(t => t.clips.length); if (!audible.length) return false;
  return audible.every(t => t.clips.length === 1 && !t.clips[0].notes && t.clips[0].file && !t.clips[0].external && has(t.clips[0].file) && Math.abs(t.clips[0].time) < 1e-6 && Math.abs(t.clips[0].playStart) < 1e-6);
}

// A package on disk/in the browser → the song's parts as sources the library and the player already understand.
export async function openPackage(src) {
  const reader = src.reader(), entries = await readDirectory(reader);
  let manifest, daw = null;
  if (entries.has('manifest.json')) manifest = JSON.parse(new TextDecoder().decode(await readEntry(reader, entries.get('manifest.json'))));
  else if (entries.has('project.xml')) {
    const text = async p => entries.has(p) ? new TextDecoder().decode(await readEntry(reader, entries.get(p))) : null;
    daw = readDawProject(await text('project.xml'), await text('metadata.xml'));
    if (!stemShaped(daw, p => entries.has(p))) throw new Error(`${src.name}: an arranged DAWproject — open it in bootleg Composer`);
    manifest = dawManifest(daw, src.name);
  } else throw new Error(`${src.name}: no manifest.json`);
  let blobUrls = [];
  const sourceFor = path => {
    const ent = entries.get(path); if (!ent) return null; const ext = (path.split('.').pop() || '').toLowerCase(), type = MIME[ext] || 'application/octet-stream';
    let url = null; const bytes = () => readEntry(reader, ent);
    return {
      kind: 'pkg', name: path.split('/').pop(), path: `${src.path}#${path}`, size: ent.size, mtime: src.mtime || 0, pkg: src.path, entry: path,
      reader: () => ({ size: ent.size, read: async (o, l) => { if (ent.method !== 0) { const all = await bytes(); return all.subarray(o, o + l); } const off = await dataOffset(reader, ent); return reader.read(off + o, Math.max(0, Math.min(l, ent.size - o))); } }),
      fetch: async () => new Response(await bytes(), { headers: { 'content-type': type } }),
      text: async () => new TextDecoder().decode(await bytes()),
      urlAsync: async () => { if (!url) { url = URL.createObjectURL(new Blob([await bytes()], { type })); blobUrls.push(url); } return url; },
      url: () => url || '',
    };
  };
  const paths = [...entries.keys()].filter(p => !p.startsWith('project/'));
  const dawStems = daw ? daw.tracks.filter(t => t.clips.length) : null;
  return {
    manifest, entries, sourceFor, daw,
    mix: daw ? null : paths.find(p => !p.includes('/') && /^(mix|master|final|bounce)\./i.test(p) && AUDIO.test(p)) || null,
    stems: dawStems ? dawStems.map(t => t.clips[0].file) : paths.filter(p => /^stems\/[^/]+$/.test(p) && AUDIO.test(p)).sort(),
    names: dawStems ? Object.fromEntries(dawStems.map(t => [t.clips[0].file, t.name || t.clips[0].file.split('/').pop().replace(/\.[^.]+$/, '')])) : {},
    clips: entries.has('clips.json') ? 'clips.json' : null,
    cover: paths.find(p => /^cover\.(jpe?g|png|webp)$/i.test(p)) || null,
    project: entries.has('project/history.json'),
    release: () => { blobUrls.forEach(u => URL.revokeObjectURL(u)); blobUrls = []; },
  };
}

// what bootleg knows about a song, from a DAW's project: title and the rest from metadata.xml, levels from the tracks,
// sections from the markers; the song id from the bootleg block when the song started in bootleg
function dawManifest(daw, fileName) {
  const bpm = daw.bpm || 120, sec = b => b * 60 / bpm, m = daw.meta, stems = daw.tracks.filter(t => t.clips.length);
  const marks = [...daw.markers].sort((a, b) => a.time - b.time), len = Math.max(0, ...stems.map(t => t.clips[0].seconds || 0));
  return {
    format: 'dawproject', id: daw.block.id || null, title: m.Title || fileName.replace(PKG_RE, ''), artist: m.Artist || '', album: m.Album || '', year: m.Year || '', genre: m.Genre || '',
    bpm: daw.bpm, key: daw.block.key || '', seconds: len || undefined, comment: daw.comment, application: daw.application,
    stems_gain_db: Object.fromEntries(stems.map(t => [t.name, t.volume > 0 ? Math.round(2000 * Math.log10(t.volume)) / 100 : -96])),
    sections: marks.map((x, i) => ({ name: x.name, start_s: sec(x.time), end_s: i + 1 < marks.length ? sec(marks[i + 1].time) : len || sec(x.time) })),
    licences: daw.block.packs || daw.block.credits ? { packs: (daw.block.packs || '').split('; ').filter(Boolean), credits: (daw.block.credits || '').split('; ').filter(Boolean) } : undefined,
  };
}
