// Everything measured from the decoded samples, in one pass: peak, clipping, DR, the spectrum (for the lossy-source and
// upsampling checks), the bits really used, and AccurateRip sums. Samples arrive interleaved as i32 at full 32-bit scale
// (a 16-bit sample is shifted left by 16), so the same code serves every bit depth and plateaus compare exactly.
use rustfft::{num_complex::Complex32, FftPlanner};
use serde::Serialize;

pub const FFT: usize = 4096;
const MAX_WINDOWS: usize = 160;
const AR_SKIP: usize = 5 * 588;      // AccurateRip leaves out 5 sectors at the start of the first track and the end of the last

pub struct Analyzer {
    pub channels: usize, pub rate: u32,
    pub frames: u64,
    peak: i64,
    // clipping: runs of ≥3 equal samples at the file's peak (found after the fact: runs are counted per level near full scale)
    runs: Vec<Run>, run_hist: std::collections::HashMap<i64, (u64, u64)>,     // level → (runs, samples)
    // DR (TT DR meter method): 3-second blocks per channel
    block: Vec<(f64, i64)>, block_len: u64, block_frames: u64, dr_blocks: Vec<Vec<(f64, f64)>>,
    // spectrum: windows of mono taken every `stride` frames
    stride: u64, win: Vec<f32>, collecting: bool, power: Vec<f64>, windows: usize,
    // bits used: OR of every sample
    or_bits: u32,
    // AccurateRip (16-bit stereo 44.1 kHz only)
    pub ar: Option<ArAcc>,
}
#[derive(Clone, Copy)]
struct Run { last: i64, len: u32 }

impl Analyzer {
    /// `expected_frames`: from the header when known (spaces the spectrum windows over the whole file).
    pub fn new(channels: usize, rate: u32, bits: u32, expected_frames: Option<u64>) -> Self {
        let block_len = rate as u64 * 3;
        let stride = expected_frames.map(|n| (n / MAX_WINDOWS as u64).max(FFT as u64)).unwrap_or(rate as u64 * 4);
        Analyzer {
            channels, rate, frames: 0, peak: 0, runs: vec![Run { last: i64::MIN, len: 0 }; channels], run_hist: Default::default(),
            block: vec![(0.0, 0); channels], block_len, block_frames: 0, dr_blocks: vec![vec![]; channels],
            stride, win: Vec::with_capacity(FFT), collecting: false, power: vec![0.0; FFT / 2], windows: 0, or_bits: 0,
            ar: (channels == 2 && rate == 44_100 && bits == 16).then(ArAcc::default),
        }
    }

    pub fn push(&mut self, interleaved: &[i32]) {
        let ch = self.channels;
        for f in interleaved.chunks_exact(ch) {
            self.frames += 1;
            let mut mono = 0f32;
            for (c, &s) in f.iter().enumerate() {
                let v = s as i64; self.or_bits |= s as u32;
                let a = v.abs(); if a > self.peak { self.peak = a; }
                // clipping: a run of equal samples, counted at its level when it ends
                let r = &mut self.runs[c];
                if v == r.last { r.len += 1; } else { if r.len >= 3 { let e = self.run_hist.entry(r.last.abs()).or_default(); e.0 += 1; e.1 += r.len as u64; } r.last = v; r.len = 1; }
                let x = s as f64 / 2147483648.0; let b = &mut self.block[c]; b.0 += x * x; if a > b.1 { b.1 = a; }
                mono += s as f32 / 2147483648.0;
            }
            self.block_frames += 1;
            if self.block_frames == self.block_len { self.end_block(); }
            // spectrum windows
            if !self.collecting && self.frames % self.stride == self.stride / 2 { self.collecting = true; self.win.clear(); }
            if self.collecting { self.win.push(mono / ch as f32); if self.win.len() == FFT { self.collecting = false; self.add_window(); } }
            if let Some(ar) = &mut self.ar { ar.push(f[0] as u32 >> 16 | (f[1] as u32 & 0xffff_0000)); }
        }
    }
    fn end_block(&mut self) {
        let n = self.block_frames as f64;
        for c in 0..self.channels { let (sq, pk) = self.block[c]; self.dr_blocks[c].push(((2.0 * sq / n).sqrt(), pk as f64 / 2147483648.0)); self.block[c] = (0.0, 0); }
        self.block_frames = 0;
    }
    fn add_window(&mut self) {
        let rms = (self.win.iter().map(|x| (x * x) as f64).sum::<f64>() / FFT as f64).sqrt();
        if rms < 10f64.powf(-50.0 / 20.0) { return; }        // silence says nothing about the spectrum
        let mut buf: Vec<Complex32> = self.win.iter().enumerate().map(|(i, &x)| { let w = 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / (FFT - 1) as f32).cos(); Complex32::new(x * w, 0.0) }).collect();
        FftPlanner::new().plan_fft_forward(FFT).process(&mut buf);
        for (p, c) in self.power.iter_mut().zip(&buf) { *p += c.norm_sqr() as f64; }
        self.windows += 1;
    }

    pub fn finish(mut self) -> Measures {
        for c in 0..self.channels { let r = self.runs[c]; if r.len >= 3 { let e = self.run_hist.entry(r.last.abs()).or_default(); e.0 += 1; e.1 += r.len as u64; } }
        if self.block_frames > self.rate as u64 / 2 { self.end_block(); }
        let peak_db = if self.peak > 0 { 20.0 * (self.peak as f64 / 2147483648.0).log10() } else { f64::NEG_INFINITY };
        // clipping: plateaus at (or within 0.1 dB of) the file's peak, when that peak is near full scale
        let near = (self.peak as f64 * 0.9886) as i64;
        let (clip_runs, clip_samples) = if peak_db > -1.0 { self.run_hist.iter().filter(|(l, _)| **l >= near).fold((0, 0), |a, (_, v)| (a.0 + v.0, a.1 + v.1)) } else { (0, 0) };
        let spectrum = (self.windows > 0).then(|| self.power.iter().map(|p| 10.0 * (p / self.windows as f64 + 1e-30).log10()).collect::<Vec<_>>());
        let used_bits = if self.or_bits == 0 { 0 } else { 32 - self.or_bits.trailing_zeros() };
        Measures {
            frames: self.frames, peak_db: (peak_db * 100.0).round() / 100.0, clip_runs, clip_samples,
            dr: dr(&self.dr_blocks), used_bits,
            spectrum: spectrum.map(|s| cutoff(&s, self.rate)), ar: self.ar.map(|a| a.finish()),
        }
    }
}

#[derive(Serialize, serde::Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Measures {
    pub frames: u64, pub peak_db: f64, pub clip_runs: u64, pub clip_samples: u64, pub dr: Option<f64>,
    /// Bits that carry anything (counted from the top): 16 in a 24-bit file means it is padded 16-bit audio.
    pub used_bits: u32,
    pub spectrum: Option<Spectrum>,
    #[serde(skip_serializing_if = "Option::is_none")] pub ar: Option<ArSums>,
}

/// TT DR meter method: per channel, 3 s blocks; RMS of the loudest 20% of blocks against the second-highest block peak.
fn dr(blocks: &[Vec<(f64, f64)>]) -> Option<f64> {
    let mut drs = vec![];
    for b in blocks {
        if b.is_empty() { continue; }
        let mut rms: Vec<f64> = b.iter().map(|x| x.0).collect(); rms.sort_by(|a, b| b.total_cmp(a));
        let n = ((rms.len() as f64 * 0.2).round() as usize).max(1); let top = (rms[..n].iter().map(|r| r * r).sum::<f64>() / n as f64).sqrt();
        let mut pk: Vec<f64> = b.iter().map(|x| x.1).collect(); pk.sort_by(|a, b| b.total_cmp(a)); let p2 = pk.get(1).or(pk.first()).copied().unwrap_or(0.0);
        if top > 0.0 && p2 > 0.0 { drs.push(20.0 * (p2 / top).log10()); }
    }
    (!drs.is_empty()).then(|| (drs.iter().sum::<f64>() / drs.len() as f64 * 10.0).round() / 10.0)
}

#[derive(Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Spectrum {
    /// Where the content stops (Hz), and whether it stops at a cliff (a lowpass filter) rather than fading out.
    pub cutoff_hz: f64, pub steep: bool, pub drop_db: f64,
    /// Coarse spectrum for the page: dB per band, bands of `band_hz`.
    pub band_hz: f64, pub bands: Vec<f32>,
}

/// The highest band with real content, and how sharply the level falls after it.
pub fn cutoff(power_db: &[f64], rate: u32) -> Spectrum {
    let bin = rate as f64 / FFT as f64; let per = 16usize; let nb = power_db.len() / per;
    let bands: Vec<f64> = (0..nb).map(|b| { let s = &power_db[b * per..(b + 1) * per]; 10.0 * (s.iter().map(|d| 10f64.powf(d / 10.0)).sum::<f64>() / per as f64).log10() }).collect();
    let band_hz = bin * per as f64;
    let idx = |hz: f64| ((hz / band_hz) as usize).min(nb.saturating_sub(1));
    let mut refv: Vec<f64> = bands[idx(1000.0)..=idx(6000.0)].to_vec(); refv.sort_by(|a, b| a.total_cmp(b)); let reference = refv[refv.len() / 2];
    // a cliff: the band where the level falls furthest, measured against everything above it (a lowpass filter
    // leaves nothing above; a natural fade-out still has something)
    let drop_at = |b: usize| { let lo = b.saturating_sub(3); let below = bands[lo..=b].iter().sum::<f64>() / (b - lo + 1) as f64; below - bands[b + 2..].iter().cloned().fold(f64::NEG_INFINITY, f64::max) };
    let (mut hb, mut drop_db) = (nb - 1, f64::NEG_INFINITY);
    for b in idx(2000.0)..nb.saturating_sub(2) { let d = drop_at(b); if d > drop_db { drop_db = d; hb = b; } }
    let steep = drop_db >= 25.0;
    if !steep { hb = nb - 1; while hb > idx(2000.0) && bands[hb] < reference - 60.0 { hb -= 1; } }     // no cliff: where the content fades below −60 dB
    if steep {      // the edge: where the level first falls 10 dB below the plateau leading up to the cliff
        let lo = idx(2000.0); let mut pl: Vec<f64> = bands[lo..hb.saturating_sub(3).max(lo + 1)].to_vec(); pl.sort_by(|a, b| a.total_cmp(b));
        let plateau = pl[pl.len() / 2]; if let Some(e) = (lo..=hb).find(|&b| bands[b] < plateau - 10.0) { hb = e.saturating_sub(1); }
    }
    Spectrum { cutoff_hz: ((hb + 1) as f64 * band_hz).round(), steep, drop_db: (drop_db * 10.0).round() / 10.0, band_hz, bands: bands.iter().map(|b| (*b - reference) as f32).collect() }
}

// ── AccurateRip sums for every first/last combination, in one pass ───────────────────────────────────────────────
/// Whether a track is the first or last on its disc is only known once albums are put together, so the sums are kept
/// for all four cases: the full sum, minus the head (frames 1..2939) and/or minus the tail (the last 2940 frames).
#[derive(Default)]
pub struct ArAcc { n: u64, v1: u32, v2: u32, head: (u32, u32), tail: std::collections::VecDeque<u32> }
#[inline] fn add(v: (u32, u32), s: u32, m: u64) -> (u32, u32) { let p = s as u64 * m; (v.0.wrapping_add(p as u32), v.1.wrapping_add(p as u32).wrapping_add((p >> 32) as u32)) }
impl ArAcc {
    fn push(&mut self, s: u32) {
        self.n += 1; let m = self.n;
        (self.v1, self.v2) = add((self.v1, self.v2), s, m);
        if (m as usize) < AR_SKIP { self.head = add(self.head, s, m); }
        self.tail.push_back(s); if self.tail.len() > AR_SKIP { self.tail.pop_front(); }
    }
    fn finish(self) -> ArSums {
        let n = self.n; let mut tail = (0u32, 0u32);
        for (i, &s) in self.tail.iter().enumerate() { let m = n - self.tail.len() as u64 + 1 + i as u64; if m > n.saturating_sub(AR_SKIP as u64) { tail = add(tail, s, m); } }
        let sub = |a: (u32, u32), b: (u32, u32)| (a.0.wrapping_sub(b.0), a.1.wrapping_sub(b.1));
        let full = (self.v1, self.v2); let first = sub(full, self.head); let last = sub(full, tail);
        // first and last (a one-track disc): both ends out; frames counted in both only if the track is shorter than 2×2940
        let both = sub(first, tail);
        ArSums { frames: n, mid: [full.0, full.1], first: [first.0, first.1], last: [last.0, last.1], only: [both.0, both.1] }
    }
}
#[derive(Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
pub struct ArSums { pub frames: u64, pub mid: [u32; 2], pub first: [u32; 2], pub last: [u32; 2], pub only: [u32; 2] }
impl ArSums { pub fn pick(&self, first: bool, last: bool) -> (u32, u32) { let a = match (first, last) { (false, false) => self.mid, (true, false) => self.first, (false, true) => self.last, (true, true) => self.only }; (a[0], a[1]) } }

#[cfg(test)]
mod tests {
    use super::*;
    use bootleg_plugin_cd::accuraterip::checksums;
    fn stereo16(frames: &[u32]) -> Vec<i32> { frames.iter().flat_map(|&f| [((f & 0xffff) as i16 as i32) << 16, ((f >> 16) as i16 as i32) << 16]).collect() }
    #[test]
    fn ar_sums_match_the_cd_plugin_for_every_position() {
        let mut x = 12345u32; let frames: Vec<u32> = (0..20_000).map(|_| { x = x.wrapping_mul(1664525).wrapping_add(1013904223); x }).collect();
        let mut a = Analyzer::new(2, 44_100, 16, Some(frames.len() as u64)); a.push(&stereo16(&frames)); let s = a.finish().ar.unwrap();
        for (f, l) in [(false, false), (true, false), (false, true), (true, true)] { assert_eq!(s.pick(f, l), checksums(&frames, f, l), "first {f} last {l}"); }
    }
    fn sine(rate: u32, secs: f64, hz: &[f64], amp: f64) -> Vec<i32> {
        let n = (rate as f64 * secs) as usize; let mut seed = 1u32;
        (0..n).flat_map(|i| { let t = i as f64 / rate as f64; let v: f64 = hz.iter().map(|h| (2.0 * std::f64::consts::PI * h * t).sin()).sum::<f64>() / hz.len() as f64 * amp;
            seed = seed.wrapping_mul(1103515245).wrapping_add(12345); let noise = ((seed >> 8) as f64 / 16777216.0 - 0.5) * 1e-4;
            let s = ((v + noise) * 32767.0).round().clamp(-32768.0, 32767.0) as i32; [s << 16, s << 16] }).collect()
    }
    #[test]
    fn clipping_is_found_and_dr_falls() {
        let clean = { let mut a = Analyzer::new(2, 44_100, 16, None); a.push(&sine(44_100, 10.0, &[440.0], 0.5)); a.finish() };
        let hot = { let mut a = Analyzer::new(2, 44_100, 16, None); a.push(&sine(44_100, 10.0, &[440.0], 3.0)); a.finish() };   // driven into the rails
        assert_eq!(clean.clip_runs, 0); assert!(hot.clip_runs > 1000, "{}", hot.clip_runs);
        assert!(clean.dr.unwrap() > hot.dr.unwrap()); assert_eq!(clean.used_bits, 16);
    }
}
