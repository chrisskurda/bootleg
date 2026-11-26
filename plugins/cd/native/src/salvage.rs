// What fills the stretches that did not read cleanly, and how they are reported (CD.md: "Damaged discs").
//   uncertain  → the best consensus samples are kept (default), or silence / interpolation
//   unreadable → interpolated when short (conceals a click), silence when long; or the zeros/best guess as read
// Every choice ends up as a library defect, so nothing filled in is ever presented as the original.
use crate::secure::{Damage, SectorState};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Fill { Keep, Silence, Interpolate }

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct FillPolicy { pub uncertain: Fill, pub unreadable_short: Fill, pub unreadable_long: Fill, pub short_ms: u32 }
impl Default for FillPolicy { fn default() -> Self { FillPolicy { uncertain: Fill::Keep, unreadable_short: Fill::Interpolate, unreadable_long: Fill::Silence, short_ms: 30 } } }

/// A defect as the library stores it (plugin spec 2.0 §6): seconds, kind, confidence, detail.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Defect { pub start: f64, pub end: f64, pub kind: &'static str, pub confidence: f64, pub detail: String }

pub fn apply(pcm: &mut [u8], damage: &[Damage], p: &FillPolicy) -> Vec<Defect> {
    let short = (p.short_ms as usize * 44_100 / 1000).max(1); let n = pcm.len() / 4;
    damage.iter().map(|d| {
        let fill = match d.kind { SectorState::Uncertain => p.uncertain, _ if d.to - d.from <= short => p.unreadable_short, _ => p.unreadable_long };
        match fill { Fill::Silence => pcm[d.from * 4..d.to * 4].fill(0), Fill::Interpolate => interpolate(pcm, d.from, d.to.min(n)), Fill::Keep => {} }
        let kind = match (d.kind, fill) { (_, Fill::Interpolate) => "interpolated", (SectorState::Uncertain, Fill::Keep) => "uncertain", _ => "unreadable" };
        let confidence = match d.kind { SectorState::Uncertain if d.reads > 0 => (d.agree as f64 / d.reads as f64).min(1.0), _ => 0.0 };
        let how = match fill { Fill::Keep if d.kind == SectorState::Uncertain => "best of the reads kept", Fill::Keep => "left as read", Fill::Silence => "silenced", Fill::Interpolate => "interpolated" };
        Defect { start: d.from as f64 / 44_100.0, end: d.to as f64 / 44_100.0, kind, confidence, detail: format!("{} sector{}, {} reads; {how}", d.sectors, if d.sectors == 1 { "" } else { "s" }, d.reads) }
    }).collect()
}

/// Linear interpolation across [from, to) from the last good frame before to the first good frame after, per channel.
fn interpolate(pcm: &mut [u8], from: usize, to: usize) {
    let n = pcm.len() / 4; let get = |pcm: &[u8], i: usize, c: usize| i16::from_le_bytes([pcm[i * 4 + c * 2], pcm[i * 4 + c * 2 + 1]]) as f64;
    for c in 0..2 {
        let a = if from > 0 { get(pcm, from - 1, c) } else { 0.0 }; let b = if to < n { get(pcm, to, c) } else { 0.0 };
        let len = (to - from + 1) as f64;
        for i in from..to { let v = (a + (b - a) * ((i - from + 1) as f64 / len)).round() as i16; pcm[i * 4 + c * 2..i * 4 + c * 2 + 2].copy_from_slice(&v.to_le_bytes()); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn dmg(from: usize, to: usize, kind: SectorState) -> Damage { Damage { from, to, kind, sectors: 1, reads: 10, agree: 3 } }
    #[test] fn short_gaps_are_interpolated_long_ones_silenced() {
        let mut pcm: Vec<u8> = (0..10_000i32).flat_map(|i| { let v = (i % 1000) as i16; [v.to_le_bytes(), v.to_le_bytes()].concat() }).collect();
        let d = apply(&mut pcm, &[dmg(100, 110, SectorState::Unreadable), dmg(2000, 6000, SectorState::Unreadable), dmg(8000, 8100, SectorState::Uncertain)], &FillPolicy::default());
        assert_eq!(d.iter().map(|x| x.kind).collect::<Vec<_>>(), ["interpolated", "unreadable", "uncertain"]);
        let s = |i: usize| i16::from_le_bytes([pcm[i * 4], pcm[i * 4 + 1]]);
        assert_eq!((s(99), s(105), s(110)), (99, 105, 110)); // a straight line through 99..110 is the line itself
        assert!((2000..6000).all(|i| s(i) == 0)); assert_eq!(s(8050), 50);
        assert!((d[2].confidence - 0.3).abs() < 1e-9); assert!(d[1].detail.contains("silenced"));
    }
}
