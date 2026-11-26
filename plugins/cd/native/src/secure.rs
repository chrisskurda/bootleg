// Secure reading: every sector is read at least `min_passes` times with the drive cache defeated in between, and is
// accepted only when `confirm` reads agree (and carry no C2 errors when C2 is trusted). Sectors that don't settle are
// re-read in rounds, slowing the drive down as rounds go by. Whatever never settles is kept as the best consensus
// (uncertain) or zeros (unreadable) and reported in the damage map — a damaged disc still gives everything it can.
use crate::backend::{Drive, Error, ReadOpts, C2_BYTES};
use crate::toc::{SAMPLES_PER_SECTOR, SECTOR_BYTES};
use serde::{Deserialize, Serialize};
use std::hash::{Hash, Hasher};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct SecureSettings {
    pub offset: i32,              // drive read offset correction, in samples
    pub min_passes: u8,           // whole-range passes (2 = read everything twice)
    pub confirm: u16,             // identical clean reads needed to accept a sector
    pub max_rounds: u16,          // re-read rounds for sectors that don't settle
    pub chunk: u32,               // sectors per read command
    pub cache_defeat: u32,        // sectors read elsewhere to flush the drive's cache before each pass/round (0 = drive has no audio cache)
    pub use_c2: bool,             // trust the drive's C2 error pointers
    pub speeds: Vec<Option<u16>>, // escalation: speed for rounds 0-1, 2-3, … (kB/s; None = maximum)
}
impl Default for SecureSettings {
    fn default() -> Self { SecureSettings { offset: 0, min_passes: 2, confirm: 2, max_rounds: 20, chunk: 16, cache_defeat: 1400, use_c2: false, speeds: vec![None, Some(1411), Some(706), Some(353), Some(176)] } }
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SectorState { Ok, Uncertain, Unreadable, Outside }

struct Cand { hash: u64, count: u16, c2: bool, data: Vec<u8> }
#[derive(Default)]
struct Slot { cands: Vec<Cand>, reads: u16, failures: u16 }
impl Slot {
    fn add(&mut self, data: &[u8], c2: bool) {
        self.reads += 1; let mut h = std::collections::hash_map::DefaultHasher::new(); data.hash(&mut h); let hash = h.finish();
        match self.cands.iter_mut().find(|c| c.hash == hash && c.c2 == c2) { Some(c) => c.count += 1, None => self.cands.push(Cand { hash, count: 1, c2, data: data.to_vec() }) }
    }
    fn accepted(&self, confirm: u16, use_c2: bool) -> Option<&Cand> { self.cands.iter().find(|c| c.count >= confirm && !(use_c2 && c.c2)) }
    fn best(&self) -> Option<&Cand> { self.cands.iter().max_by_key(|c| (c.count, !c.c2)) }
}

/// The result of reading a range: the chosen data of every sector and what we know about it.
pub struct SectorMap { pub first: i32, pub data: Vec<u8>, pub state: Vec<SectorState>, pub reads: Vec<u16>, pub agree: Vec<u16> }
impl SectorMap {
    pub fn get(&self, lba: i32) -> Option<(&[u8], SectorState)> {
        let i = lba - self.first; if i < 0 || i as usize >= self.state.len() { return None; }
        let i = i as usize; Some((&self.data[i * SECTOR_BYTES..(i + 1) * SECTOR_BYTES], self.state[i]))
    }
    pub fn count(&self, s: SectorState) -> usize { self.state.iter().filter(|x| **x == s).count() }
}

pub struct Hooks<'a> { pub progress: &'a mut dyn FnMut(f64, &str), pub cancelled: &'a dyn Fn() -> bool, pub log: &'a mut dyn FnMut(&str) }
#[derive(Debug, PartialEq)]
pub enum ReadError { Cancelled, Drive(Error) }

/// Read sectors `a..=b`. Sectors outside the program area `[0, disc_end)` are not read (state Outside, zeros) unless
/// the drive can overread; they are only ever needed for the read offset at the very start and end of the disc.
pub fn read_range(drive: &mut dyn Drive, a: i32, b: i32, disc_end: i32, s: &SecureSettings, h: &mut Hooks) -> Result<SectorMap, ReadError> {
    let n = (b - a + 1).max(0) as usize; let mut slots: Vec<Slot> = (0..n).map(|_| Slot::default()).collect();
    let caps = drive.capabilities(); let c2 = s.use_c2 && caps.c2;
    let inside = |l: i32| (l >= 0 || caps.overread_leadin) && (l < disc_end || caps.overread_leadout);
    let wanted: Vec<i32> = (a..=b).filter(|l| inside(*l)).collect();
    let total_work = (wanted.len() * s.min_passes.max(1) as usize).max(1) as f64; let mut done = 0usize;

    // one sector at a time (after a failed multi-sector command, and for re-reads)
    let read_one = |drive: &mut dyn Drive, l: i32, slots: &mut Vec<Slot>| {
        let slot = &mut slots[(l - a) as usize];
        match drive.read(l, 1, ReadOpts { c2, subq: false }) {
            Ok(r) => slot.add(&r.audio, r.c2.as_ref().is_some_and(|v| v.iter().any(|x| *x != 0))),
            Err(_) => { slot.reads += 1; slot.failures += 1; }
        }
    };

    for pass in 0..s.min_passes.max(1) {
        if pass > 0 { flush(drive, a, b, disc_end, s.cache_defeat); }
        let mut i = 0;
        while i < wanted.len() {
            if (h.cancelled)() { return Err(ReadError::Cancelled); }
            // a run of consecutive sectors, at most `chunk` long
            let start = wanted[i]; let mut len = 1; while i + len < wanted.len() && len < s.chunk as usize && wanted[i + len] == start + len as i32 { len += 1; }
            match drive.read(start, len as u32, ReadOpts { c2, subq: false }) {
                Ok(r) => for k in 0..len {
                    let flagged = r.c2.as_ref().is_some_and(|v| v[k * C2_BYTES..(k + 1) * C2_BYTES].iter().any(|x| *x != 0));
                    slots[(start - a) as usize + k].add(&r.audio[k * SECTOR_BYTES..(k + 1) * SECTOR_BYTES], flagged);
                },
                Err(Error::NoDisc) => return Err(ReadError::Drive(Error::NoDisc)),
                Err(_) => for k in 0..len as i32 { read_one(drive, start + k, &mut slots); },
            }
            i += len; done += len;
            (h.progress)(done as f64 / total_work, &format!("pass {} of {}", pass + 1, s.min_passes));
        }
    }

    let settled = |sl: &Slot| sl.accepted(s.confirm, c2).is_some();
    let mut bad: Vec<i32> = wanted.iter().copied().filter(|l| !settled(&slots[(l - a) as usize])).collect();
    if !bad.is_empty() { (h.log)(&format!("{} sectors did not match on the first passes; re-reading", bad.len())); }
    let mut speed: Option<u16> = None;
    for round in 0..s.max_rounds {
        if bad.is_empty() { break; }
        if (h.cancelled)() { let _ = drive.set_speed(None); return Err(ReadError::Cancelled); }
        let want = s.speeds.get(round as usize / 2).copied().unwrap_or(*s.speeds.last().unwrap_or(&None));
        if want != speed && drive.set_speed(want).is_ok() { speed = want; (h.log)(&format!("round {}: speed {}", round + 1, want.map(|k| format!("{:.0}×", k as f64 / 176.4)).unwrap_or("max".into()))); }
        flush(drive, bad[0], *bad.last().unwrap(), disc_end, s.cache_defeat);
        for &l in &bad { if (h.cancelled)() { break; } read_one(drive, l, &mut slots); }
        bad.retain(|l| !settled(&slots[(l - a) as usize]));
        (h.progress)(1.0, &format!("re-read round {}: {} sectors left", round + 1, bad.len()));
    }
    if speed.is_some() { let _ = drive.set_speed(None); }

    let mut map = SectorMap { first: a, data: vec![0; n * SECTOR_BYTES], state: vec![SectorState::Outside; n], reads: vec![0; n], agree: vec![0; n] };
    for (i, sl) in slots.iter().enumerate() {
        let l = a + i as i32; map.reads[i] = sl.reads; if !inside(l) { continue; }
        let (state, cand) = match sl.accepted(s.confirm, c2) { Some(c) => (SectorState::Ok, Some(c)), None => match sl.best() { Some(c) => (SectorState::Uncertain, Some(c)), None => (SectorState::Unreadable, None) } };
        map.state[i] = state;
        if let Some(c) = cand { map.data[i * SECTOR_BYTES..(i + 1) * SECTOR_BYTES].copy_from_slice(&c.data); map.agree[i] = c.count; }
    }
    Ok(map)
}

/// Read `n` sectors away from `lo..=hi` (the sectors about to be read again) so the drive's cache no longer holds them.
/// Uses whichever end of the disc is farther from them; on a disc too short to hold `n` other sectors it reads what it can.
fn flush(drive: &mut dyn Drive, lo: i32, hi: i32, disc_end: i32, n: u32) {
    if n == 0 || disc_end <= 0 { return; }
    let n = (n as i32).min(disc_end);
    let (before, after) = (lo.max(0), disc_end - hi.min(disc_end) - 1);   // room on either side
    let from = if before >= after { 0 } else { disc_end - n };
    let (from, to) = if before >= n || after >= n { (from, from + n) } else if before >= after { (0, before) } else { (hi + 1, disc_end) };
    let mut l = from; while l < to { let c = 32.min(to - l); let _ = drive.read(l, c as u32, ReadOpts::default()); l += c; }
}

/// A stretch of a track that did not read cleanly, in samples from the start of the track.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Damage { pub from: usize, pub to: usize, pub kind: SectorState, pub sectors: usize, pub reads: u32, pub agree: u32 }

/// The offset-corrected audio of track sectors `start..=end`, and its damage.
pub fn assemble(map: &SectorMap, start: i32, end: i32, offset: i32) -> (Vec<u8>, Vec<Damage>) {
    let first = start as i64 * SAMPLES_PER_SECTOR as i64; let n = ((end - start + 1) as usize) * SAMPLES_PER_SECTOR;
    let mut pcm = vec![0u8; n * 4]; let mut damage: Vec<Damage> = vec![]; let mut last_sector = i32::MIN;
    for i in 0..n {
        let raw = first + i as i64 + offset as i64; let lba = raw.div_euclid(SAMPLES_PER_SECTOR as i64) as i32; let k = raw.rem_euclid(SAMPLES_PER_SECTOR as i64) as usize;
        let Some((data, state)) = map.get(lba) else { continue };
        if state != SectorState::Outside { pcm[i * 4..i * 4 + 4].copy_from_slice(&data[k * 4..k * 4 + 4]); }
        if matches!(state, SectorState::Uncertain | SectorState::Unreadable) {
            let idx = (lba - map.first) as usize; let new_sector = lba != last_sector;
            match damage.last_mut() {
                Some(d) if d.to == i && d.kind == state => { d.to = i + 1; if new_sector { d.sectors += 1; d.reads += map.reads[idx] as u32; d.agree += map.agree[idx] as u32; } }
                _ => damage.push(Damage { from: i, to: i + 1, kind: state, sectors: 1, reads: map.reads[idx] as u32, agree: map.agree[idx] as u32 }),
            }
        }
        last_sector = lba;
    }
    (pcm, damage)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::sim::*;
    fn quiet() -> (impl FnMut(f64, &str), impl Fn() -> bool, impl FnMut(&str)) { (|_: f64, _: &str| {}, || false, |_: &str| {}) }
    fn rip(cfg: SimConfig, s: SecureSettings) -> (Vec<u8>, Vec<u8>, Vec<Damage>, u64) {
        let disc = SimDisc::synthetic(&[200], 11); let truth = disc.pcm.clone(); let mut d = SimDrive::new("t", disc, cfg);
        let (mut p, c, mut l) = quiet(); let mut h = Hooks { progress: &mut p, cancelled: &c, log: &mut l };
        let map = read_range(&mut d, -1, 200, 200, &s, &mut h).unwrap(); let (pcm, dmg) = assemble(&map, 0, 199, s.offset); (pcm, truth, dmg, d.reads)
    }
    #[test] fn clean_disc_with_offset_is_exact() {
        let (pcm, truth, dmg, _) = rip(SimConfig { offset: 667, cache_sectors: 32, ..Default::default() }, SecureSettings { offset: 667, cache_defeat: 40, ..Default::default() });
        // the last 667 samples come from beyond the program area: zeros, as on every drive that can't overread
        let cut = truth.len() - 667 * 4; assert_eq!(&pcm[..cut], &truth[..cut]); assert!(pcm[cut..].iter().all(|b| *b == 0)); assert!(dmg.is_empty());
    }
    #[test] fn flaky_sectors_are_recovered_by_rereading() {
        let cfg = SimConfig { cache_sectors: 32, seed: 4, faults: vec![Fault { from: 50, to: 59, kind: FaultKind::Flaky, p: 0.6, max_kbps: 0 }], ..Default::default() };
        let (pcm, truth, dmg, _) = rip(cfg, SecureSettings { cache_defeat: 40, max_rounds: 40, ..Default::default() });
        assert!(dmg.is_empty(), "{dmg:?}"); assert_eq!(pcm, truth);
    }
    #[test] fn without_cache_defeat_a_caching_drive_fools_the_comparison() {
        // the same flaky sector read twice from cache "agrees" with itself — this is why cache defeat matters
        let cfg = SimConfig { cache_sectors: 100_000, seed: 4, faults: vec![Fault { from: 50, to: 59, kind: FaultKind::Flaky, p: 1.0, max_kbps: 0 }], ..Default::default() };
        let (pcm, truth, dmg, _) = rip(cfg, SecureSettings { cache_defeat: 0, ..Default::default() });
        assert!(dmg.is_empty() && pcm != truth);
    }
    #[test] fn speed_sensitive_sectors_settle_after_slowing_down() {
        let cfg = SimConfig { cache_sectors: 0, seed: 7, faults: vec![Fault { from: 80, to: 82, kind: FaultKind::Speed, p: 1.0, max_kbps: 706 }], ..Default::default() };
        let (pcm, truth, dmg, _) = rip(cfg, SecureSettings { cache_defeat: 0, ..Default::default() });
        assert!(dmg.is_empty(), "{dmg:?}"); assert_eq!(pcm, truth);
    }
    #[test] fn c2_lets_flagged_reads_be_rejected() {
        let cfg = SimConfig { cache_sectors: 0, seed: 2, c2: C2Mode::Accurate, faults: vec![Fault { from: 10, to: 30, kind: FaultKind::Flaky, p: 0.3, max_kbps: 0 }], ..Default::default() };
        let (pcm, truth, dmg, _) = rip(cfg, SecureSettings { cache_defeat: 0, use_c2: true, ..Default::default() });
        assert!(dmg.is_empty()); assert_eq!(pcm, truth);
    }
    #[test] fn dead_sectors_are_salvaged_around_and_reported() {
        let cfg = SimConfig { cache_sectors: 0, seed: 3, faults: vec![Fault { from: 100, to: 104, kind: FaultKind::Dead, p: 1.0, max_kbps: 0 }, Fault { from: 150, to: 150, kind: FaultKind::Flaky, p: 1.0, max_kbps: 0 }], ..Default::default() };
        let (pcm, truth, dmg, _) = rip(cfg, SecureSettings { cache_defeat: 0, max_rounds: 4, ..Default::default() });
        assert_eq!(dmg.len(), 2, "{dmg:?}");
        assert_eq!((dmg[0].from, dmg[0].to, dmg[0].kind, dmg[0].sectors), (100 * 588, 105 * 588, SectorState::Unreadable, 5));
        assert_eq!((dmg[1].from, dmg[1].kind), (150 * 588, SectorState::Uncertain));
        // everything else is exact
        assert_eq!(&pcm[..100 * 588 * 4], &truth[..100 * 588 * 4]); assert_eq!(&pcm[105 * 588 * 4..150 * 588 * 4], &truth[105 * 588 * 4..150 * 588 * 4]);
    }
    #[test] fn cancel_stops_reading() {
        let disc = SimDisc::synthetic(&[100], 1); let mut d = SimDrive::new("t", disc, SimConfig::default());
        let (mut p, _, mut l) = quiet(); let c = || true; let mut h = Hooks { progress: &mut p, cancelled: &c, log: &mut l };
        assert_eq!(read_range(&mut d, 0, 99, 100, &SecureSettings::default(), &mut h).err(), Some(ReadError::Cancelled));
    }
}
