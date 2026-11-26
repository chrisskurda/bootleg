// The whole song's spectrogram, for the Now playing timeline: the file is decoded once (at a reduced sample rate, so a long
// recording does not take gigabytes), cut into COLS columns, and each column's spectrum is folded into ROWS log-spaced bands
// (30 Hz … half the sample rate). Kept as one byte per cell (0 = quiet … 255 = the loudest cell in the song), ~80 KB a song.
export const COLS = 800, ROWS = 96, N = 2048;

// Radix-2 FFT magnitudes (re/im are overwritten). n must be a power of two.
function fftMag(re, im, out) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let k = 0; k < len / 2; k++) { const a = i + k, b = a + len / 2, tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr; re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti; const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr; } }
  }
  for (let i = 0; i < n / 2; i++) out[i] = Math.hypot(re[i], im[i]);
}

// samples: mono Float32Array at `rate`. → { cols, rows, data: Uint8Array(cols*rows), column-major, row 0 = lowest band }
export async function spectrogram(samples, rate, { cols = COLS, rows = ROWS, yieldEvery = 100 } = {}) {
  const win = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1))), re = new Float32Array(N), im = new Float32Array(N), mag = new Float32Array(N / 2);
  const lo = 30, hi = rate / 2, edge = r => Math.max(1, Math.min(N / 2 - 1, Math.round(lo * Math.pow(hi / lo, r / rows) * N / rate)));
  const bands = Array.from({ length: rows }, (_, r) => [edge(r), Math.max(edge(r) + 1, edge(r + 1))]), db = new Float32Array(cols * rows); let max = -Infinity;
  const step = Math.max(1, (samples.length - N) / Math.max(1, cols - 1));
  for (let c = 0; c < cols; c++) {
    const at = Math.round(c * step); for (let i = 0; i < N; i++) { re[i] = (samples[at + i] || 0) * win[i]; im[i] = 0; } fftMag(re, im, mag);
    for (let r = 0; r < rows; r++) { const [a, b] = bands[r]; let m = 0; for (let k = a; k < b; k++) if (mag[k] > m) m = mag[k]; const v = 20 * Math.log10(m + 1e-9); db[c * rows + r] = v; if (v > max) max = v; }
    if (yieldEvery && c % yieldEvery === yieldEvery - 1) await new Promise(r => setTimeout(r, 0));      // stay responsive
  }
  const floor = max - 80, data = new Uint8Array(cols * rows); for (let i = 0; i < db.length; i++) data[i] = Math.max(0, Math.min(255, Math.round((db[i] - floor) / 80 * 255)));
  return { cols, rows, data };
}

// Decodes a whole file (ArrayBuffer) to mono at a rate that keeps memory bounded, then analyses it.
export async function analyseFile(buf, { duration = 0 } = {}) {
  const rate = duration > 1800 ? 11025 : 22050, ctx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 1, rate);
  const ab = await new Promise((ok, bad) => { const p = ctx.decodeAudioData(buf, ok, bad); if (p && p.then) p.then(ok, bad); });
  const n = ab.length, mono = new Float32Array(n); for (let ch = 0; ch < ab.numberOfChannels; ch++) { const d = ab.getChannelData(ch); for (let i = 0; i < n; i++) mono[i] += d[i] / ab.numberOfChannels; }
  return { ...(await spectrogram(mono, ab.sampleRate)), duration: ab.duration, rate: ab.sampleRate };
}

// A dark → violet → pink → warm-white ramp (bootleg's colours), 256 entries of [r, g, b].
const STOPS = [[0, [8, 9, 16]], [0.35, [43, 27, 92]], [0.6, [124, 70, 220]], [0.8, [255, 95, 210]], [1, [255, 236, 200]]];
export const RAMP = Array.from({ length: 256 }, (_, i) => { const t = i / 255; let k = 0; while (k < STOPS.length - 2 && t > STOPS[k + 1][0]) k++; const [t0, a] = STOPS[k], [t1, b] = STOPS[k + 1], f = (t - t0) / (t1 - t0); return a.map((x, j) => Math.round(x + (b[j] - x) * f)); });

export function paintSpectro(canvas, s) {
  canvas.width = s.cols; canvas.height = s.rows; const g = canvas.getContext('2d'), img = g.createImageData(s.cols, s.rows);
  for (let c = 0; c < s.cols; c++) for (let r = 0; r < s.rows; r++) { const [R, G, B] = RAMP[s.data[c * s.rows + r]], o = ((s.rows - 1 - r) * s.cols + c) * 4; img.data[o] = R; img.data[o + 1] = G; img.data[o + 2] = B; img.data[o + 3] = 255; }
  g.putImageData(img, 0, 0);
}
