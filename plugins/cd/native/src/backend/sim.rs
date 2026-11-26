// The simulator backend (plugin spec 2.0 §7): a drive that plays back a disc image and misbehaves on purpose, the way
// real drives and real scratched discs do — read offset, a cache that hides re-reads, sectors that read wrong some of
// the time, sectors that never read, C2 pointers that are right or not, sectors that only read well at low speed.
//
// A folder of images: each `<name>.cue` (+ its .bin, raw 2352-byte audio sectors) is one simulated drive with that disc;
// `<name>.sim.json` beside it configures the drive and the damage:
//   { "offset": 6, "cache_sectors": 64, "c2": "accurate"|"none"|"unreliable", "seed": 1, "overread": false,
//     "faults": [{ "from": 1000, "to": 1010, "kind": "flaky"|"weak"|"dead"|"wrong"|"speed", "p": 0.5, "max_kbps": 706 }] }
use super::*;
use crate::toc::{msf_to_lba, Track, SAMPLES_PER_SECTOR, SECTOR_BYTES};
use serde::Deserialize;
use std::{collections::VecDeque, path::{Path, PathBuf}};

#[derive(Clone, Debug, Deserialize, Default, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum C2Mode { #[default] Accurate, None, Unreliable }

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum FaultKind {
    Flaky,   // each read is corrupted with probability p (C2 flags the corrupted bytes when C2 is accurate)
    Weak,    // each read fails with probability p, otherwise it is correct
    Dead,    // never reads
    Wrong,   // always reads the same wrong data, with no C2: only AccurateRip can catch it
    Speed,   // corrupted with probability p above max_kbps, correct at or below it
}
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Fault { pub from: i32, pub to: i32, pub kind: FaultKind, #[serde(default = "half")] pub p: f64, #[serde(default)] pub max_kbps: u16 }
fn half() -> f64 { 0.5 }

#[derive(Clone, Debug, Deserialize, Default)]
pub struct SimConfig {
    #[serde(default)] pub offset: i32,
    #[serde(default)] pub cache_sectors: usize,
    #[serde(default)] pub c2: C2Mode,
    #[serde(default)] pub seed: u64,
    #[serde(default)] pub overread: bool,
    #[serde(default)] pub faults: Vec<Fault>,
    #[serde(default)] pub vendor: Option<String>,
    #[serde(default)] pub model: Option<String>,
}

/// A disc: its TOC and the true audio of the program area from LBA 0 (what a perfect read gives).
#[derive(Clone)]
pub struct SimDisc { pub toc: Toc, pub pcm: Vec<u8> }

impl SimDisc {
    /// A made-up disc for tests: tracks of the given lengths (sectors), music-like (tones + noise), each track different.
    pub fn synthetic(lengths: &[i32], seed: u64) -> SimDisc {
        let mut tracks = vec![]; let mut lba = 0;
        for (i, &n) in lengths.iter().enumerate() { tracks.push(Track { number: i as u8 + 1, start: lba, audio: true, preemphasis: false, session: 1, pregap: 0, isrc: None }); lba += n; }
        let total = lba as usize * SAMPLES_PER_SECTOR; let mut pcm = Vec::with_capacity(total * 4); let mut rng = Rng(seed | 1);
        for j in 0..total {
            let t = j as f64 / 44_100.0; let k = (tracks.iter().rposition(|tr| (tr.start as usize * SAMPLES_PER_SECTOR) <= j).unwrap_or(0) + 1) as f64;
            let tone = (t * 220.0 * k * std::f64::consts::TAU).sin() * 6000.0 + (t * 331.0 * std::f64::consts::TAU).sin() * 3000.0;
            let l = (tone + (rng.next() % 2000) as f64 - 1000.0) as i16; let r = (tone * 0.8 + (rng.next() % 2000) as f64 - 1000.0) as i16;
            pcm.extend(l.to_le_bytes()); pcm.extend(r.to_le_bytes());
        }
        SimDisc { toc: Toc { tracks, leadout: lba, mcn: None }, pcm }
    }

    /// A cue sheet with one BINARY file of raw 2352-byte sectors (the format whipper, cdrdao and EAC images use).
    pub fn from_cue(cue_path: &Path) -> std::result::Result<SimDisc, String> {
        let text = std::fs::read_to_string(cue_path).map_err(|e| format!("{}: {e}", cue_path.display()))?;
        let mut bin: Option<PathBuf> = None; let mut tracks: Vec<Track> = vec![]; let mut mcn = None; let mut idx0: Option<i32> = None;
        for line in text.lines().map(str::trim) {
            let mut w = line.split_whitespace(); let kw = w.next().unwrap_or("").to_ascii_uppercase();
            match kw.as_str() {
                "FILE" => { let name = line[4..].trim().rsplitn(2, ' ').nth(1).unwrap_or("").trim_matches('"'); bin = Some(cue_path.with_file_name(name)); }
                "CATALOG" => mcn = w.next().map(str::to_string),
                "TRACK" => { let n: u8 = w.next().and_then(|s| s.parse().ok()).ok_or("bad TRACK")?; let audio = w.next().unwrap_or("AUDIO").eq_ignore_ascii_case("AUDIO"); tracks.push(Track { number: n, start: 0, audio, preemphasis: false, session: 1, pregap: 0, isrc: None }); idx0 = None; }
                "FLAGS" => if let Some(t) = tracks.last_mut() { t.preemphasis = line.to_ascii_uppercase().contains("PRE"); },
                "ISRC" => if let Some(t) = tracks.last_mut() { t.isrc = w.next().map(str::to_string); },
                "INDEX" => {
                    let i: u8 = w.next().and_then(|s| s.parse().ok()).unwrap_or(1);
                    let p: Vec<u8> = w.next().unwrap_or("0:0:0").split(':').map(|x| x.parse().unwrap_or(0)).collect();
                    let lba = msf_to_lba(p[0], p[1], p[2]) + 150; // cue times are relative to the file start = LBA 0
                    if i == 0 { idx0 = Some(lba) } else if i == 1 { if let Some(t) = tracks.last_mut() { t.start = lba; t.pregap = idx0.map(|z| lba - z).unwrap_or(0); } }
                }
                _ => {}
            }
        }
        let bin = bin.ok_or("no FILE in cue")?; let pcm = std::fs::read(&bin).map_err(|e| format!("{}: {e}", bin.display()))?;
        if tracks.is_empty() { return Err("no tracks in cue".into()); }
        let leadout = (pcm.len() / SECTOR_BYTES) as i32;
        Ok(SimDisc { toc: Toc { tracks, leadout, mcn }, pcm })
    }
    /// Write this disc as a .cue + .bin pair (fixtures, and the tests that read images back).
    pub fn write_image(&self, cue_path: &Path) -> std::io::Result<()> {
        let bin = cue_path.with_extension("bin"); std::fs::write(&bin, &self.pcm)?;
        let mut cue = format!("FILE \"{}\" BINARY\n", bin.file_name().unwrap().to_string_lossy());
        if let Some(m) = &self.toc.mcn { cue = format!("CATALOG {m}\n{cue}"); }
        for t in &self.toc.tracks {
            cue += &format!("  TRACK {:02} AUDIO\n", t.number);
            if let Some(i) = &t.isrc { cue += &format!("    ISRC {i}\n"); }
            if t.pregap > 0 { cue += &format!("    INDEX 00 {}\n", crate::toc::fmt_frames(t.start - t.pregap)); }
            cue += &format!("    INDEX 01 {}\n", crate::toc::fmt_frames(t.start));
        }
        std::fs::write(cue_path, cue)
    }
}

struct Rng(u64);
impl Rng { fn next(&mut self) -> u64 { self.0 ^= self.0 << 13; self.0 ^= self.0 >> 7; self.0 ^= self.0 << 17; self.0 } fn chance(&mut self, p: f64) -> bool { (self.next() % 1_000_000) as f64 / 1_000_000.0 < p } }

pub struct SimDrive { id: String, disc: SimDisc, cfg: SimConfig, rng: Rng, cache: VecDeque<(i32, Vec<u8>, Vec<u8>)>, speed: Option<u16>, pub reads: u64 }

impl SimDrive {
    pub fn new(id: &str, disc: SimDisc, cfg: SimConfig) -> SimDrive { let seed = cfg.seed; SimDrive { id: id.into(), disc, cfg, rng: Rng(seed.wrapping_mul(2654435761) | 1), cache: VecDeque::new(), speed: None, reads: 0 } }
    fn fault(&self, lba: i32) -> Option<&Fault> { self.cfg.faults.iter().find(|f| lba >= f.from && lba <= f.to) }
    /// What the drive's laser sees at `lba`: the true audio shifted by the drive's read offset.
    fn raw(&self, lba: i32) -> Vec<u8> {
        let mut out = vec![0u8; SECTOR_BYTES]; let total = (self.disc.pcm.len() / 4) as i64;
        for k in 0..SAMPLES_PER_SECTOR as i64 {
            let j = lba as i64 * SAMPLES_PER_SECTOR as i64 + k - self.cfg.offset as i64;
            if j >= 0 && j < total { let s = j as usize * 4; out[k as usize * 4..k as usize * 4 + 4].copy_from_slice(&self.disc.pcm[s..s + 4]); }
        }
        out
    }
    fn read_one(&mut self, lba: i32) -> Result<(Vec<u8>, Vec<u8>)> {
        let last = self.disc.toc.leadout;
        if (lba < 0 || lba >= last) && !self.cfg.overread { return Err(Error::Read { lba, msg: "outside the program area".into() }); }
        if let Some(i) = self.cache.iter().position(|c| c.0 == lba) { let c = self.cache[i].clone(); return Ok((c.1, c.2)); }
        let mut data = self.raw(lba); let mut c2 = vec![0u8; C2_BYTES];
        let fault = self.fault(lba).cloned();
        if let Some(f) = fault {
            let corrupt = match f.kind {
                FaultKind::Dead => return Err(Error::Read { lba, msg: "unrecoverable read error".into() }),
                FaultKind::Weak => { if self.rng.chance(f.p) { return Err(Error::Read { lba, msg: "read error".into() }); } false }
                FaultKind::Flaky => self.rng.chance(f.p),
                FaultKind::Speed => self.speed.map_or(true, |s| s > f.max_kbps) && self.rng.chance(f.p),
                FaultKind::Wrong => { let mut r = Rng(lba as u64 * 7919 + 1); for _ in 0..16 { let i = (r.next() % SECTOR_BYTES as u64) as usize; data[i] ^= 0x5a; } false }
            };
            if corrupt {
                for _ in 0..1 + self.rng.next() % 24 {
                    let i = (self.rng.next() % SECTOR_BYTES as u64) as usize; data[i] = data[i].wrapping_add(1 + (self.rng.next() % 255) as u8);
                    match self.cfg.c2 { C2Mode::Accurate => c2[i / 8] |= 0x80 >> (i % 8), C2Mode::Unreliable => if self.rng.chance(0.5) { c2[i / 8] |= 0x80 >> (i % 8) }, C2Mode::None => {} }
                }
            }
        }
        if self.cfg.cache_sectors > 0 { self.cache.push_back((lba, data.clone(), c2.clone())); while self.cache.len() > self.cfg.cache_sectors { self.cache.pop_front(); } }
        Ok((data, c2))
    }
    fn subq(&self, lba: i32) -> Vec<u8> {
        let bcd = |v: i32| (((v / 10) << 4) | (v % 10)) as u8; let toc = &self.disc.toc;
        let t = toc.tracks.iter().rev().find(|t| lba >= t.start - t.pregap).unwrap_or(&toc.tracks[0]);
        let (index, rel) = if lba < t.start { (0, t.start - lba) } else { (1, lba - t.start) };
        let (rm, rs, rf) = (rel / 4500, rel / 75 % 60, rel % 75); let (am, as_, af) = crate::toc::lba_to_msf(lba);
        let mut q = vec![0x01u8, bcd(t.number as i32), bcd(index), bcd(rm), bcd(rs), bcd(rf), 0, bcd(am), bcd(as_), bcd(af)];
        let crc = !crc16(&q); q.extend(crc.to_be_bytes()); q.resize(SUBQ_BYTES, 0); q
    }
}
/// CRC-16/CCITT as used by the Q subchannel (inverted on the disc).
pub fn crc16(d: &[u8]) -> u16 { let mut c: u16 = 0; for &b in d { c ^= (b as u16) << 8; for _ in 0..8 { c = if c & 0x8000 != 0 { (c << 1) ^ 0x1021 } else { c << 1 }; } } c }

impl Drive for SimDrive {
    fn info(&self) -> DriveInfo { DriveInfo { id: self.id.clone(), vendor: self.cfg.vendor.clone().unwrap_or("bootleg".into()), model: self.cfg.model.clone().unwrap_or("Simulated drive".into()), revision: "sim".into(), path: self.id.clone(), has_disc: true } }
    fn capabilities(&mut self) -> Capabilities { Capabilities { c2: self.cfg.c2 != C2Mode::None, subchannel_q: true, set_speed: true, isrc: true, mcn: true, overread_leadin: self.cfg.overread, overread_leadout: self.cfg.overread } }
    fn toc(&mut self) -> Result<Toc> { let mut t = self.disc.toc.clone(); for tr in &mut t.tracks { tr.isrc = None; } t.mcn = None; Ok(t) } // ISRC/MCN come from their own calls, like real drives
    fn read(&mut self, lba: i32, count: u32, opts: ReadOpts) -> Result<Sectors> {
        self.reads += count as u64;
        let mut s = Sectors { audio: Vec::with_capacity(count as usize * SECTOR_BYTES), c2: opts.c2.then(Vec::new), subq: opts.subq.then(Vec::new) };
        for l in lba..lba + count as i32 {
            let (d, c2) = self.read_one(l)?; s.audio.extend(d);
            if let Some(v) = s.c2.as_mut() { if self.cfg.c2 == C2Mode::None { return Err(Error::Unsupported("C2".into())); } v.extend(c2); }
            if let Some(v) = s.subq.as_mut() { v.extend(self.subq(l)); }
        }
        Ok(s)
    }
    fn set_speed(&mut self, kbps: Option<u16>) -> Result<()> { self.speed = kbps; Ok(()) }
    fn isrc(&mut self, track: u8) -> Option<String> { self.disc.toc.track(track).and_then(|t| t.isrc.clone()) }
    fn mcn(&mut self) -> Option<String> { self.disc.toc.mcn.clone() }
}

/// Every `<name>.cue` in a folder is a drive holding that disc.
pub struct SimBackend { pub dir: PathBuf }
impl SimBackend {
    pub fn from_dir(dir: impl Into<PathBuf>) -> SimBackend { SimBackend { dir: dir.into() } }
    fn cues(&self) -> Vec<PathBuf> { let mut v: Vec<PathBuf> = std::fs::read_dir(&self.dir).map(|r| r.filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.extension().is_some_and(|e| e == "cue")).collect()).unwrap_or_default(); v.sort(); v }
    pub fn config(cue: &Path) -> SimConfig { std::fs::read_to_string(cue.with_extension("sim.json")).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default() }
}
impl Backend for SimBackend {
    fn name(&self) -> &'static str { "sim" }
    fn drives(&self) -> Result<Vec<DriveInfo>> {
        Ok(self.cues().iter().map(|c| { let id = format!("sim:{}", c.file_stem().unwrap().to_string_lossy()); let cfg = Self::config(c); DriveInfo { path: c.display().to_string(), vendor: cfg.vendor.unwrap_or("bootleg".into()), model: cfg.model.unwrap_or(format!("Simulated drive ({})", c.file_stem().unwrap().to_string_lossy())), revision: "sim".into(), has_disc: true, id } }).collect())
    }
    fn open(&self, id: &str) -> Result<Box<dyn Drive>> {
        let cue = self.cues().into_iter().find(|c| format!("sim:{}", c.file_stem().unwrap().to_string_lossy()) == id).ok_or_else(|| Error::NotFound(id.into()))?;
        let disc = SimDisc::from_cue(&cue).map_err(Error::Io)?; Ok(Box::new(SimDrive::new(id, disc, Self::config(&cue))))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn offset_shifts_the_audio() {
        let disc = SimDisc::synthetic(&[40], 3); let truth = disc.pcm.clone();
        let mut d = SimDrive::new("x", disc, SimConfig { offset: 6, ..Default::default() });
        let s = d.read(10, 1, ReadOpts::default()).unwrap();
        let at = (10 * 588 - 6) * 4; assert_eq!(&s.audio[..], &truth[at..at + 2352]);
    }
    #[test] fn cache_hides_rereads_of_a_flaky_sector() {
        let disc = SimDisc::synthetic(&[40], 3);
        let mut d = SimDrive::new("x", disc, SimConfig { cache_sectors: 8, faults: vec![Fault { from: 5, to: 5, kind: FaultKind::Flaky, p: 0.5, max_kbps: 0 }], seed: 9, ..Default::default() });
        let a = d.read(5, 1, ReadOpts::default()).unwrap().audio; for _ in 0..5 { assert_eq!(d.read(5, 1, ReadOpts::default()).unwrap().audio, a); }
    }
    #[test] fn image_round_trip() {
        let dir = std::env::temp_dir().join(format!("bootleg-cd-sim-{}", std::process::id())); std::fs::create_dir_all(&dir).unwrap();
        let mut disc = SimDisc::synthetic(&[30, 20], 5); disc.toc.tracks[1].pregap = 4; disc.toc.tracks[0].isrc = Some("USABC0000001".into()); disc.toc.mcn = Some("0123456789012".into());
        disc.write_image(&dir.join("a.cue")).unwrap();
        let back = SimDisc::from_cue(&dir.join("a.cue")).unwrap(); assert_eq!(back.toc, disc.toc); assert_eq!(back.pcm, disc.pcm);
        let b = SimBackend::from_dir(&dir); assert_eq!(b.drives().unwrap().len(), 1);
        let mut d = b.open("sim:a").unwrap(); assert_eq!(d.isrc(1).as_deref(), Some("USABC0000001")); assert_eq!(d.toc().unwrap().tracks.len(), 2);
        let q = d.read(29, 1, ReadOpts { subq: true, ..Default::default() }).unwrap().subq.unwrap(); assert_eq!((q[1], q[2]), (0x02, 0x00)); // track 2's pregap
        std::fs::remove_dir_all(&dir).ok();
    }
}
