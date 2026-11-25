#!/usr/bin/env python3
"""Draws the app icon (equaliser bars on a rounded gradient tile) with the standard library only -> src-tauri/icons/source.png (1024²).
Then:  npx tauri icon src-tauri/icons/source.png   (makes every size/format)."""
import math, struct, sys, zlib
N = 1024
def sdf_round_rect(x, y, cx, cy, hw, hh, r):          # signed distance to a rounded rectangle (negative inside)
    qx, qy = abs(x - cx) - (hw - r), abs(y - cy) - (hh - r)
    return math.hypot(max(qx, 0), max(qy, 0)) + min(max(qx, qy), 0) - r
def lerp(a, b, t): return a + (b - a) * t
BARS = [(0.28, 0.26), (0.39, 0.44), (0.50, 0.60), (0.61, 0.38), (0.72, 0.50)]   # (x centre, height) as fractions of the tile
rows = []
for py in range(N):
    row = bytearray([0])
    for px in range(N):
        x, y = px + 0.5, py + 0.5
        tile = sdf_round_rect(x, y, N / 2, N / 2, N * 0.47, N * 0.47, N * 0.22)
        a = min(1, max(0, 0.5 - tile))
        if a == 0: row += b'\x00\x00\x00\x00'; continue
        t = (x + y) / (2 * N)                           # diagonal gradient: deep plum -> coral
        r, g, b = lerp(44, 235, t), lerp(14, 96, t), lerp(52, 120, t)
        for cx, h in BARS:                              # equaliser bars, pink at the top fading to white
            hh, bw = N * h * 0.5, N * 0.034
            d = sdf_round_rect(x, y, cx * N, N * 0.73 - hh, bw, hh, bw)
            m = min(1, max(0, 0.5 - d))
            if m > 0:
                u = min(1, max(0, (y - (N * 0.73 - 2 * hh)) / (2 * hh)))
                br, bg, bb = lerp(255, 236, u), lerp(95, 240, u), lerp(210, 252, u)
                r, g, b = lerp(r, br, m), lerp(g, bg, m), lerp(b, bb, m)
        row += bytes((int(r), int(g), int(b), int(a * 255)))
    rows.append(bytes(row))
raw = b''.join(rows)
def chunk(tag, data): c = struct.pack('>I', len(data)) + tag + data; return c + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)
png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', N, N, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')
out = sys.argv[1] if len(sys.argv) > 1 else 'src-tauri/icons/source.png'
open(out, 'wb').write(png); print('wrote', out, len(png) // 1024, 'KB')
