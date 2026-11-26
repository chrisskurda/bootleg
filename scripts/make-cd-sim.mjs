#!/usr/bin/env node
// Simulated CDs for the CD plugin's sim backend (docs/plugins/CD.md, Testing):  node scripts/make-cd-sim.mjs <dir>
// Writes <dir>/Clean.cue+.bin and <dir>/Damaged.cue+.bin (+ .sim.json: the drive's offset and cache, the disc's damage).
// Run bootleg with BOOTLEG_CD_BACKEND=sim BOOTLEG_CD_SIM=<dir> to rip them as if they were in a drive.
import fs from 'node:fs'; import path from 'node:path';
const dir = process.argv[2]; if (!dir) { console.error('usage: make-cd-sim.mjs <dir>'); process.exit(2); }
fs.mkdirSync(dir, { recursive: true });
const SECTOR = 2352, SPS = 588;
const msf = n => [Math.floor(n / 4500), Math.floor(n / 75) % 60, n % 75].map(x => String(x).padStart(2, '0')).join(':');
function disc(name, lengths, seed, sim) {
  const total = lengths.reduce((a, b) => a + b, 0), buf = Buffer.alloc(total * SECTOR); let x = seed | 1, lba = 0;
  lengths.forEach((n, ti) => {
    const f1 = 220 * (ti + 1), f2 = 330 + 55 * ti;
    for (let j = lba * SPS; j < (lba + n) * SPS; j++) {
      x ^= x << 13; x ^= x >>> 17; x ^= x << 5; const noise = ((x >>> 0) % 1200) - 600, t = j / 44100;
      const env = 0.6 + 0.4 * Math.sin(t * 2 * Math.PI * 0.5), v = (Math.sin(t * 2 * Math.PI * f1) * 7000 + Math.sin(t * 2 * Math.PI * f2) * 3000) * env;
      buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v + noise))), j * 4); buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 0.8 - noise))), j * 4 + 2);
    }
    lba += n;
  });
  fs.writeFileSync(path.join(dir, name + '.bin'), buf);
  let cue = `FILE "${name}.bin" BINARY\n`; lba = 0;
  lengths.forEach((n, i) => { cue += `  TRACK ${String(i + 1).padStart(2, '0')} AUDIO\n    INDEX 01 ${msf(lba)}\n`; lba += n; });
  fs.writeFileSync(path.join(dir, name + '.cue'), cue);
  fs.writeFileSync(path.join(dir, name + '.sim.json'), JSON.stringify(sim, null, 2));
}
const L = [600, 450, 750];      // 8 s, 6 s, 10 s
disc('Clean', L, 7, { offset: 6, cache_sectors: 64, c2: 'accurate', seed: 1, model: 'Simulated drive (clean disc)' });
disc('Damaged', L, 9, { offset: 6, cache_sectors: 64, c2: 'unreliable', seed: 2, model: 'Simulated drive (scratched disc)', faults: [
  { from: 100, to: 104, kind: 'flaky', p: 0.6 },            // track 1: a light scratch — recovers with re-reads
  { from: 800, to: 809, kind: 'dead' },                       // track 2: 10 sectors that never read — salvaged around, flagged
  { from: 1400, to: 1402, kind: 'speed', p: 1, max_kbps: 706 }, // track 3: reads only when slowed down
] });
console.log(`simulated discs in ${dir}: Clean, Damaged`);
