// .bstem / .bsong packages (contracts/song_format.md in bootleg-stemserver): a song in one zip. Audio entries are stored
// uncompressed, so they are read straight out of the file — by range on the desktop, by slicing a File in the browser —
// and a package plays without being unpacked. JSON entries may be deflated (inflated with DecompressionStream).
// openPackage(source) → { manifest, entries: Map(path → {offset?, size, csize, method, header}), sourceFor(path) }
export const PKG_RE = /\.(bstem|bsong)$/i;
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

// A package on disk/in the browser → the song's parts as sources the library and the player already understand.
export async function openPackage(src) {
  const reader = src.reader(), entries = await readDirectory(reader);
  if (!entries.has('manifest.json')) throw new Error(`${src.name}: no manifest.json`);
  const manifest = JSON.parse(new TextDecoder().decode(await readEntry(reader, entries.get('manifest.json'))));
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
  return {
    manifest, entries, sourceFor,
    mix: paths.find(p => !p.includes('/') && /^(mix|master|final|bounce)\./i.test(p) && AUDIO.test(p)) || null,
    stems: paths.filter(p => /^stems\/[^/]+$/.test(p) && AUDIO.test(p)).sort(),
    clips: entries.has('clips.json') ? 'clips.json' : null,
    cover: paths.find(p => /^cover\.(jpe?g|png|webp)$/i.test(p)) || null,
    project: entries.has('project/history.json'),
    release: () => { blobUrls.forEach(u => URL.revokeObjectURL(u)); blobUrls = []; },
  };
}
