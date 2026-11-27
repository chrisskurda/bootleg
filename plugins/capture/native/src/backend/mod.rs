// Audio inputs (plugin spec 2.0 §5.2): one contract, a real backend (cpal: CoreAudio on macOS, WASAPI on Windows, ALSA
// on Linux) and a simulator that "plays" WAV files as if they came from a turntable, for tests and CI.
use serde::Serialize;
use std::sync::mpsc::Sender;

pub mod sim;
pub mod system;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo { pub id: String, pub name: String, pub default: bool, pub rates: Vec<u32>, pub channels: u16, pub default_rate: u32 }

/// What arrives from an input: interleaved f32 samples, or the input failing.
pub enum Chunk { Audio(Vec<f32>), Failed(String), End }

/// A running capture; dropping it stops it.
pub trait Running: Send {}

pub trait Backend: Send + Sync {
    fn name(&self) -> &'static str;
    fn devices(&self) -> Result<Vec<DeviceInfo>, String>;
    /// Start capturing from `id` at `rate` (0: the device's default), stereo where the device has two channels or more.
    /// Returns the format actually used: (rate, channels).
    fn start(&self, id: &str, rate: u32, sink: Sender<Chunk>) -> Result<(Box<dyn Running>, u32, u16), String>;
}

/// The backend for this process: the simulator when BOOTLEG_CAPTURE_BACKEND=sim (BOOTLEG_CAPTURE_SIM = a folder of WAVs).
pub fn platform() -> Box<dyn Backend> {
    if std::env::var("BOOTLEG_CAPTURE_BACKEND").as_deref() == Ok("sim") {
        return Box::new(sim::Sim::new(std::env::var("BOOTLEG_CAPTURE_SIM").unwrap_or_default().into(), std::env::var("BOOTLEG_CAPTURE_SIM_SPEED").ok().and_then(|s| s.parse().ok()).unwrap_or(1.0)));
    }
    Box::new(system::System)
}
