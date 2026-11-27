// Click removal: a click is a short burst (at most 2 ms) where the sample-to-sample change jumps far above what the music
// around it does, and settles again. Each one is redrawn with a smooth curve through the good samples on either side.
// Music's own attacks aren't touched: they last longer than a click and don't settle back.

#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize)]
pub struct Click { pub frame: u64, pub len: u32 }

pub struct Settings { pub k: f32, pub floor: f32, pub max_ms: f32 }
impl Default for Settings { fn default() -> Self { Settings { k: 12.0, floor: 0.02, max_ms: 2.0 } } }

/// Repairs `x` (interleaved) in place; returns the clicks found (per channel, frames from the start of `x`).
pub fn declick(x: &mut [f32], channels: usize, rate: u32, s: &Settings) -> Vec<Click> {
    let frames = x.len() / channels; let max_len = ((s.max_ms / 1000.0) * rate as f32).max(4.0) as usize; let win = 1024usize; let mut out = vec![];
    for c in 0..channels {
        let d: Vec<f32> = (0..frames).map(|i| if i == 0 { 0.0 } else { (x[i * channels + c] - x[(i - 1) * channels + c]).abs() }).collect();
        let mut pre = vec![0f64; frames + 1]; for i in 0..frames { pre[i + 1] = pre[i] + d[i] as f64; }
        let scale = |i: usize| { let a = i.saturating_sub(win); let b = (i + win).min(frames); ((pre[b] - pre[a]) / (b - a).max(1) as f64) as f32 };
        let mut i = 1;
        while i < frames {
            let thr = (scale(i) * s.k).max(s.floor);
            if d[i] <= thr { i += 1; continue; }
            // the burst: until the change stays small for a few samples
            let start = i; let mut end = i; let mut j = i + 1;
            while j < frames && j - start <= max_len + 4 { if d[j] > thr * 0.5 { end = j; j += 1; } else if j - end > 3 { break; } else { j += 1; } }
            let len = end - start + 1;
            let a = start.saturating_sub(3); let b = (end + 3).min(frames - 1);
            let at = |x: &[f32], i: usize| x[i * channels + c];
            if len <= max_len && a >= 2 && b + 2 < frames {
                // settles back: the level after is close to what the slope before predicts
                let slope = at(x, a) - at(x, a - 1); let predict = at(x, a) + slope * (b - a) as f32; let jump = (at(x, b) - predict).abs();
                if jump < thr * 4.0 {
                    let (p0, p1) = (at(x, a), at(x, b)); let (m0, m1) = (at(x, a) - at(x, a - 1), at(x, b + 1) - at(x, b)); let n = (b - a) as f32;
                    for k in a + 1..b { let t = (k - a) as f32 / n; let (t2, t3) = (t * t, t * t * t);
                        x[k * channels + c] = (2.0 * t3 - 3.0 * t2 + 1.0) * p0 + (t3 - 2.0 * t2 + t) * m0 * n + (-2.0 * t3 + 3.0 * t2) * p1 + (t3 - t2) * m1 * n; }
                    out.push(Click { frame: start as u64, len: len as u32 });
                }
            }
            i = end + 4;
        }
    }
    out.sort_by_key(|c| c.frame); out
}
