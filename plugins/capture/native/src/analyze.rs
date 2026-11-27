// After a side is recorded: an overview to draw, and where the tracks probably are (the quiet gaps between them).
use crate::wav::Reader;
use serde::Serialize;
use std::path::Path;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Analysis {
    pub rate: u32, pub channels: u16, pub seconds: f64,
    /// Peak per point (0..1) for drawing, `points` across the whole recording.
    pub overview: Vec<f32>,
    /// Loudness every 0.25 s (dBFS), to show the quiet parts.
    pub rms_db: Vec<f32>,
    /// Where the music starts and ends (lead-in and run-out left off), and the suggested splits between them (seconds).
    pub start: f64, pub end: f64, pub splits: Vec<f64>,
    pub floor_db: f32, pub threshold_db: f32,
}

pub const WIN: f64 = 0.05;
pub fn analyze(p: &Path, points: usize) -> Result<Analysis, String> {
    let mut r = Reader::open(p)?; let (rate, ch, frames) = (r.rate, r.channels as usize, r.frames);
    let win = (rate as f64 * WIN) as u64; let mut rms = vec![]; let per_point = (frames / points.max(1) as u64).max(1); let mut overview = vec![]; let mut pk = 0f32; let mut in_point = 0u64;
    let block = rate as u64 * 10; let mut at = 0;
    while at < frames {
        let s = r.read(at, block)?; let mut sq = 0f64; let mut k = 0u64;
        for f in s.chunks_exact(ch) {
            let m = f.iter().map(|x| x.abs()).fold(0f32, f32::max); if m > pk { pk = m; }
            in_point += 1; if in_point == per_point { overview.push(pk); pk = 0.0; in_point = 0; }
            sq += f.iter().map(|x| (*x as f64).powi(2)).sum::<f64>() / ch as f64; k += 1;
            if k == win { rms.push(crate::record::db((sq / k as f64).sqrt() as f32)); sq = 0.0; k = 0; }
        }
        at += block;
    }
    let seconds = frames as f64 / rate as f64;
    let (start, end, splits, floor, thr) = suggest(&rms, seconds);
    let rms_db = rms.chunks(5).map(|c| c.iter().cloned().fold(-120f32, f32::max)).collect();
    Ok(Analysis { rate, channels: ch as u16, seconds, overview, rms_db, start, end, splits, floor_db: floor, threshold_db: thr })
}

/// From loudness every 50 ms: the quiet threshold (between the surface noise and the music), the start and end of the
/// music, and a split in the middle of every quiet stretch of 1 s or more. Tracks shorter than 20 s are merged.
pub fn suggest(rms: &[f32], seconds: f64) -> (f64, f64, Vec<f64>, f32, f32) {
    if rms.is_empty() { return (0.0, seconds, vec![], -120.0, -120.0); }
    let mut s = rms.to_vec(); s.sort_by(|a, b| a.total_cmp(b));
    let floor = s[s.len() / 100]; let music = s[s.len() / 2];      // gaps are only a few % of a side
    let thr = (floor + (music - floor) * 0.3).min(music - 12.0).max(floor + 4.0);
    // a click in a gap (or in the lead-in) is one loud 50 ms window: judge each window by the median of five around it
    let med: Vec<f32> = (0..rms.len()).map(|i| { let mut w: Vec<f32> = rms[i.saturating_sub(2)..(i + 3).min(rms.len())].to_vec(); w.sort_by(|a, b| a.total_cmp(b)); w[w.len() / 2] }).collect();
    let quiet: Vec<bool> = med.iter().map(|&r| r < thr).collect();
    let mut runs = vec![]; let mut i = 0;
    while i < quiet.len() { if quiet[i] { let a = i; while i < quiet.len() && quiet[i] { i += 1; } runs.push((a, i)); } else { i += 1; } }
    let t = |w: usize| w as f64 * WIN;
    let first_loud = quiet.iter().position(|q| !q).unwrap_or(0); let last_loud = quiet.iter().rposition(|q| !q).unwrap_or(quiet.len().saturating_sub(1));
    let start = (t(first_loud) - 0.3).max(0.0); let end = (t(last_loud + 1) + 0.5).min(seconds);
    let mut splits: Vec<f64> = runs.iter().filter(|(a, b)| *a > first_loud && *b <= last_loud && t(b - a) >= 1.0).map(|(a, b)| t((a + b) / 2)).collect();
    // no track shorter than 20 s: drop the split that makes the shortest one, until none is
    loop {
        let mut edges = vec![start]; edges.extend(&splits); edges.push(end);
        let Some((k, len)) = edges.windows(2).map(|w| w[1] - w[0]).enumerate().min_by(|a, b| a.1.total_cmp(&b.1)) else { break };
        if len >= 20.0 || splits.is_empty() { break; }
        let idx = if k == 0 { 0 } else if k >= splits.len() { splits.len() - 1 } else if edges[k] - edges[k - 1] < edges[k + 2] - edges[k + 1] { k - 1 } else { k };
        splits.remove(idx);
    }
    (start, end, splits, floor, thr)
}
