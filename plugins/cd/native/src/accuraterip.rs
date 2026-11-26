// AccurateRip: per-track checksums (v1 and v2) and the database's response format.
// Algorithm as published by the AccurateRip project; written from its description.
use crate::toc::SAMPLES_PER_SECTOR;
use serde::Serialize;

/// Checksums of one track. `samples` are stereo frames as little-endian u32 (left in the low half), already offset-corrected.
pub fn checksums(samples: &[u32], first: bool, last: bool) -> (u32, u32) {
    let n = samples.len() as u64;
    let from: u64 = if first { 5 * SAMPLES_PER_SECTOR as u64 } else { 0 };
    let to: u64 = if last { n.saturating_sub(5 * SAMPLES_PER_SECTOR as u64) } else { n };
    let (mut v1, mut v2) = (0u32, 0u32);
    for (i, &s) in samples.iter().enumerate() {
        let m = i as u64 + 1;
        if m < from || m > to { continue; }
        let p = s as u64 * m;
        v1 = v1.wrapping_add(p as u32);
        v2 = v2.wrapping_add(p as u32).wrapping_add((p >> 32) as u32);
    }
    (v1, v2)
}

pub fn frames_from_pcm(pcm: &[u8]) -> Vec<u32> { pcm.chunks_exact(4).map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect() }

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Entry { pub confidence: u8, pub crc: u32, pub crc450: u32 }
/// One submitted pressing/offset group: an entry per track.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Response { pub tracks: Vec<Entry> }

/// Parse a dBAR-*.bin file: repeated blocks of [count u8][id1 u32][id2 u32][cddb u32] then count × [confidence u8][crc u32][crc450 u32].
pub fn parse(data: &[u8], expect: (u32, u32, u32)) -> Vec<Response> {
    let mut out = vec![]; let mut pos = 0;
    let rd = |p: usize| u32::from_le_bytes([data[p], data[p + 1], data[p + 2], data[p + 3]]);
    while pos + 13 <= data.len() {
        let n = data[pos] as usize; let size = 13 + 9 * n;
        if pos + size > data.len() { break; }
        let ids = (rd(pos + 1), rd(pos + 5), rd(pos + 9));
        if ids == expect || (ids.0, ids.1) == (expect.0, expect.1) {
            out.push(Response { tracks: (0..n).map(|i| { let p = pos + 13 + 9 * i; Entry { confidence: data[p], crc: rd(p + 1), crc450: rd(p + 5) } }).collect() });
        }
        pos += size;
    }
    out
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct TrackResult { pub v1: u32, pub v2: u32, pub matched: Option<&'static str>, pub confidence: u32, pub total: u32 }

/// Compare a track's checksums against every response; confidence is summed over the responses that match.
pub fn verify(index: usize, v1: u32, v2: u32, responses: &[Response]) -> TrackResult {
    let (mut conf, mut total, mut matched) = (0u32, 0u32, None);
    for r in responses {
        let Some(e) = r.tracks.get(index) else { continue };
        total += e.confidence as u32;
        if e.crc == v2 && v2 != 0 { conf += e.confidence as u32; matched = Some("v2"); }
        else if e.crc == v1 && v1 != 0 { conf += e.confidence as u32; matched = matched.or(Some("v1")); }
    }
    TrackResult { v1, v2, matched, confidence: conf, total }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn bounds_skip_five_sectors_on_the_first_and_last_track() {
        let one = vec![1u32; 10 * 588];
        // middle track: sum of 1..=N
        let n = one.len() as u64; assert_eq!(checksums(&one, false, false).0 as u64, n * (n + 1) / 2 % (1 << 32));
        // first track: multipliers 2940..=N
        let s: u64 = (2940..=n).sum(); assert_eq!(checksums(&one, true, false).0 as u64, s % (1 << 32));
        // last track: multipliers 1..=N-2940
        let s: u64 = (1..=n - 2940).sum(); assert_eq!(checksums(&one, false, true).0 as u64, s % (1 << 32));
    }
    #[test] fn v2_folds_the_high_half() {
        let x = vec![0xffff_ffffu32; 3];
        let want: u64 = (1..=3u64).map(|m| { let p = 0xffff_ffffu64 * m; (p & 0xffff_ffff) + (p >> 32) }).sum();
        assert_eq!(checksums(&x, false, false).1, want as u32);
    }
    #[test] fn parse_and_verify() {
        let mut bin = vec![2u8]; for v in [0x11u32, 0x22, 0x33] { bin.extend(v.to_le_bytes()); }
        for (c, crc) in [(5u8, 0xaaaa_u32), (7, 0xbbbb)] { bin.push(c); bin.extend(crc.to_le_bytes()); bin.extend(0u32.to_le_bytes()); }
        let r = parse(&bin, (0x11, 0x22, 0x33)); assert_eq!(r.len(), 1);
        assert_eq!(verify(1, 0x1, 0xbbbb, &r), TrackResult { v1: 1, v2: 0xbbbb, matched: Some("v2"), confidence: 7, total: 7 });
        assert_eq!(verify(0, 0x2, 0x3, &r).matched, None);
        assert!(parse(&bin, (0x99, 0x22, 0x33)).is_empty());
    }
}
