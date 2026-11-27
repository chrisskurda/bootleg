// The simulator: each WAV file in a folder is an "input". Starting it plays the file in real time (or faster, for tests)
// as chunks of f32, like a sound card would, then ends.
use super::{Backend, Chunk, DeviceInfo, Running};
use std::{path::PathBuf, sync::{atomic::{AtomicBool, Ordering}, mpsc::Sender, Arc}, time::Duration};

pub struct Sim { dir: PathBuf, speed: f64 }
impl Sim { pub fn new(dir: PathBuf, speed: f64) -> Self { Sim { dir, speed: speed.max(0.01) } } }
struct Playing(Arc<AtomicBool>);
impl Running for Playing {}
impl Drop for Playing { fn drop(&mut self) { self.0.store(true, Ordering::Relaxed); } }

impl Backend for Sim {
    fn name(&self) -> &'static str { "sim" }
    fn devices(&self) -> Result<Vec<DeviceInfo>, String> {
        let mut v: Vec<_> = std::fs::read_dir(&self.dir).map_err(|e| e.to_string())?.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.extension().is_some_and(|e| e == "wav")).collect();
        v.sort();
        Ok(v.iter().enumerate().filter_map(|(i, p)| { let w = crate::wav::read(p).ok()?; let name = p.file_stem()?.to_string_lossy().to_string();
            Some(DeviceInfo { id: format!("sim:{name}"), name: format!("Simulated {name}"), default: i == 0, rates: vec![w.rate], channels: w.channels, default_rate: w.rate }) }).collect())
    }
    fn start(&self, id: &str, _rate: u32, sink: Sender<Chunk>) -> Result<(Box<dyn Running>, u32, u16), String> {
        let name = id.strip_prefix("sim:").ok_or("not a simulated input")?;
        let w = crate::wav::read(&self.dir.join(format!("{name}.wav")))?;
        let stop = Arc::new(AtomicBool::new(false)); let s2 = stop.clone(); let speed = self.speed;
        let (rate, ch) = (w.rate, w.channels);
        std::thread::spawn(move || {
            let chunk = (rate as usize / 50) * ch as usize;      // 20 ms, as a sound card delivers them
            for c in w.samples.chunks(chunk) {
                if s2.load(Ordering::Relaxed) { return; }
                if sink.send(Chunk::Audio(c.to_vec())).is_err() { return; }
                std::thread::sleep(Duration::from_secs_f64(0.02 / speed));
            }
            let _ = sink.send(Chunk::End);
        });
        Ok((Box::new(Playing(stop)), rate, ch))
    }
}
