// A minimal zip writer for tests: stored or deflated entries, optionally with Zip64 records (to test readers on them).
import zlib from 'node:zlib';
const crc = buf => { let c, t = crc.t || (crc.t = Array.from({ length: 256 }, (_, n) => { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; })), x = 0xffffffff; for (const b of buf) x = t[(x ^ b) & 0xff] ^ (x >>> 8); return (x ^ 0xffffffff) >>> 0; };
export function makeZip(entries, { zip64 = false } = {}) {
  const parts = [], cd = []; let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name), data = Buffer.from(e.data), method = e.method === 'deflate' ? 8 : 0, body = method ? zlib.deflateRawSync(data) : data, c = crc(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(zip64 ? 45 : 20, 4); lh.writeUInt16LE(method, 8); lh.writeUInt32LE(c, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26);
    parts.push(lh, name, body);
    const extra = zip64 ? Buffer.alloc(28) : Buffer.alloc(0);
    if (zip64) { extra.writeUInt16LE(1, 0); extra.writeUInt16LE(24, 2); extra.writeBigUInt64LE(BigInt(data.length), 4); extra.writeBigUInt64LE(BigInt(body.length), 12); extra.writeBigUInt64LE(BigInt(off), 20); }
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(zip64 ? 45 : 20, 4); ch.writeUInt16LE(zip64 ? 45 : 20, 6); ch.writeUInt16LE(method, 10); ch.writeUInt32LE(c, 16);
    ch.writeUInt32LE(zip64 ? 0xffffffff : body.length, 20); ch.writeUInt32LE(zip64 ? 0xffffffff : data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt16LE(extra.length, 30); ch.writeUInt32LE(zip64 ? 0xffffffff : off, 42);
    cd.push(ch, name, extra); off += 30 + name.length + body.length;
  }
  const cdBuf = Buffer.concat(cd), tail = [];
  if (zip64) {
    const r = Buffer.alloc(56); r.writeUInt32LE(0x06064b50, 0); r.writeBigUInt64LE(44n, 4); r.writeUInt16LE(45, 12); r.writeUInt16LE(45, 14); r.writeBigUInt64LE(BigInt(entries.length), 24); r.writeBigUInt64LE(BigInt(entries.length), 32); r.writeBigUInt64LE(BigInt(cdBuf.length), 40); r.writeBigUInt64LE(BigInt(off), 48);
    const l = Buffer.alloc(20); l.writeUInt32LE(0x07064b50, 0); l.writeBigUInt64LE(BigInt(off + cdBuf.length), 8); l.writeUInt32LE(1, 16); tail.push(r, l);
  }
  const eo = Buffer.alloc(22); eo.writeUInt32LE(0x06054b50, 0); eo.writeUInt16LE(zip64 ? 0xffff : entries.length, 8); eo.writeUInt16LE(zip64 ? 0xffff : entries.length, 10); eo.writeUInt32LE(zip64 ? 0xffffffff : cdBuf.length, 12); eo.writeUInt32LE(zip64 ? 0xffffffff : off, 16);
  return Buffer.concat([...parts, cdBuf, ...tail, eo]);
}
// a .bstem from a stem folder (manifest first, then the mix, cover, stems: audio stored)
export function bstemFrom(files, manifest) {
  const order = (a, b) => rank(a) - rank(b) || a.localeCompare(b), rank = p => (/^(mix)\./.test(p) ? 1 : /^cover\./.test(p) ? 2 : p.startsWith('stems/') ? 3 : 4);
  return makeZip([{ name: 'manifest.json', data: JSON.stringify(manifest), method: 'deflate' }, ...Object.keys(files).sort(order).map(p => ({ name: p, data: files[p], method: p.endsWith('.json') ? 'deflate' : 'store' }))]);
}
