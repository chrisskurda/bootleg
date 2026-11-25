// MD5 (RFC 1321) — needed only for Subsonic's token authentication (token = md5(password + salt)); SubtleCrypto has no MD5.
const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0), S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
export function md5(input) {
  const msg = typeof input === 'string' ? new TextEncoder().encode(input) : input, n = msg.length, len = ((n + 8) >> 6 << 6) + 64, buf = new Uint8Array(len); buf.set(msg); buf[n] = 0x80;
  const dv = new DataView(buf.buffer); dv.setUint32(len - 8, (n * 8) >>> 0, true); dv.setUint32(len - 4, Math.floor(n * 8 / 2 ** 32), true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let o = 0; o < len; o += 64) {
    const M = Array.from({ length: 16 }, (_, i) => dv.getUint32(o + i * 4, true)); let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g; if (i < 16) { F = (B & C) | (~B & D); g = i; } else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; } else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; } else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) >>> 0; A = D; D = C; C = B; const s = S[(i >> 4) * 4 + (i % 4)]; B = (B + ((F << s) | (F >>> (32 - s)))) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const out = new Uint8Array(16), ov = new DataView(out.buffer); [a0, b0, c0, d0].forEach((v, i) => ov.setUint32(i * 4, v, true)); return [...out].map(b => b.toString(16).padStart(2, '0')).join('');
}
