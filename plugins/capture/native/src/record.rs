// A recording: whatever the input sends goes straight into a float WAV, with levels reported ten times a second.
use crate::{backend::{Backend, Chunk}, wav::Writer};
use serde::Serialize;
use std::{path::Path, sync::mpsc, time::Duration};

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Levels { pub seconds: f64, pub peak_db: Vec<f32>, pub rms_db: Vec<f32>, pub clipped: u64 }
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Recorded { pub path: String, pub rate: u32, pub channels: u16, pub seconds: f64, pub clipped: u64, pub ended: String }

pub struct Hooks<'a> { pub levels: &'a mut dyn FnMut(&Levels), pub finish: &'a dyn Fn() -> bool, pub cancelled: &'a dyn Fn() -> bool }

pub fn db(x: f32) -> f32 { if x > 0.0 { (20.0 * x.log10()).max(-120.0) } else { -120.0 } }

/// Records from `device` into `path` until `finish` (keep it), `cancelled` (the file is deleted), or the input ends.
pub fn record(b: &dyn Backend, device: &str, rate: u32, path: &Path, h: &mut Hooks) -> Result<Recorded, String> {
    let (tx, rx) = mpsc::channel(); let (live, rate, ch) = b.start(device, rate, tx)?;
    let mut w = Writer::create(path, rate, ch)?;
    let (mut peak, mut sq, mut n, mut clipped) = (vec![0f32; ch as usize], vec![0f64; ch as usize], 0u64, 0u64);
    let every = rate as u64 / 10; let mut ended = "finished".to_string();
    let fail = |w: Writer, e: String| { drop(w); let _ = std::fs::remove_file(path); Err(e) };
    loop {
        if (h.cancelled)() { drop(live); return fail(w, "cancelled".into()); }
        if (h.finish)() { break; }
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(Chunk::Audio(s)) => {
                if let Err(e) = w.write(&s) { ended = e; break; }
                for f in s.chunks_exact(ch as usize) { for (c, &x) in f.iter().enumerate() { let a = x.abs(); if a > peak[c] { peak[c] = a; } sq[c] += (x * x) as f64; if a >= 0.999 { clipped += 1; } } n += 1;
                    if n >= every { (h.levels)(&Levels { seconds: w.frames as f64 / rate as f64, peak_db: peak.iter().map(|&p| db(p)).collect(), rms_db: sq.iter().map(|&s| db((s / n as f64).sqrt() as f32)).collect(), clipped }); peak.fill(0.0); sq.fill(0.0); n = 0; } }
            }
            Ok(Chunk::Failed(e)) => { ended = format!("the input stopped: {e}"); break; }
            Ok(Chunk::End) | Err(mpsc::RecvTimeoutError::Disconnected) => { ended = "the input ended".into(); break; }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
    }
    drop(live);
    while let Ok(Chunk::Audio(s)) = rx.try_recv() { if w.write(&s).is_err() { break; } }      // what was already on its way
    let frames = w.finish()?;
    if frames == 0 { let _ = std::fs::remove_file(path); return Err("nothing was recorded (is the input muted, or was access to it refused?)".into()); }
    Ok(Recorded { path: path.to_string_lossy().into(), rate, channels: ch, seconds: frames as f64 / rate as f64, clipped, ended })
}
