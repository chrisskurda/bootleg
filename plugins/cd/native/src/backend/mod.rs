// The platform contract (plugin spec 2.0 §5.2): backends only provide primitives. Everything else — secure reading,
// verification, encoding — lives above this trait and is tested on every OS against `sim`.
use crate::toc::Toc;
use serde::Serialize;

pub const C2_BYTES: usize = 294; // one bit per byte of the 2352-byte sector
pub const SUBQ_BYTES: usize = 16;

#[derive(Debug, Clone, PartialEq)]
pub enum Error { Unsupported(String), NoDisc, NotFound(String), Permission(String), Io(String), Read { lba: i32, msg: String } }
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            Error::Unsupported(s) => write!(f, "not supported: {s}"), Error::NoDisc => write!(f, "no audio disc in the drive"),
            Error::NotFound(s) => write!(f, "drive not found: {s}"), Error::Permission(s) => write!(f, "no permission to read the drive: {s}"),
            Error::Io(s) => write!(f, "{s}"), Error::Read { lba, msg } => write!(f, "read error at sector {lba}: {msg}"),
        }
    }
}
impl std::error::Error for Error {}
pub type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Debug, Serialize, Default)]
pub struct DriveInfo { pub id: String, pub vendor: String, pub model: String, pub revision: String, pub path: String, pub has_disc: bool }

/// What this backend and device can do — discovered at runtime, never assumed from the OS (spec §5.2 rule 3).
#[derive(Clone, Debug, Serialize, Default)]
pub struct Capabilities { pub c2: bool, pub subchannel_q: bool, pub set_speed: bool, pub isrc: bool, pub mcn: bool, pub overread_leadin: bool, pub overread_leadout: bool }

#[derive(Clone, Copy, Debug, Default)]
pub struct ReadOpts { pub c2: bool, pub subq: bool }

/// `count` sectors from `lba`: audio (2352 bytes each), C2 error bits (294 each) and Q subchannel (16 each) when asked for.
#[derive(Clone, Debug, Default)]
pub struct Sectors { pub audio: Vec<u8>, pub c2: Option<Vec<u8>>, pub subq: Option<Vec<u8>> }

pub trait Drive: Send {
    fn info(&self) -> DriveInfo;
    fn capabilities(&mut self) -> Capabilities;
    fn toc(&mut self) -> Result<Toc>;
    fn read(&mut self, lba: i32, count: u32, opts: ReadOpts) -> Result<Sectors>;
    /// Read speed in kB/s (176 = 1×); None = the drive's maximum.
    fn set_speed(&mut self, _kbps: Option<u16>) -> Result<()> { Err(Error::Unsupported("set speed".into())) }
    fn isrc(&mut self, _track: u8) -> Option<String> { None }
    fn mcn(&mut self) -> Option<String> { None }
}

pub trait Backend: Send + Sync {
    fn name(&self) -> &'static str;
    fn drives(&self) -> Result<Vec<DriveInfo>>;
    fn open(&self, id: &str) -> Result<Box<dyn Drive>>;
}

#[cfg(target_os = "macos")] pub mod macos;
pub mod sim;

/// A target without a real backend yet: compiles everywhere, reports Unsupported (spec §5.2 rule 2).
pub struct Unsupported;
impl Backend for Unsupported {
    fn name(&self) -> &'static str { "unsupported" }
    fn drives(&self) -> Result<Vec<DriveInfo>> { Err(Error::Unsupported(format!("reading CDs on {}", std::env::consts::OS))) }
    fn open(&self, _: &str) -> Result<Box<dyn Drive>> { self.drives().map(|_| unreachable!()) }
}

/// The backend for this platform. `BOOTLEG_CD_BACKEND=sim` (with `BOOTLEG_CD_SIM=<folder of .cue images>`) selects the simulator.
pub fn platform() -> Box<dyn Backend> {
    if std::env::var("BOOTLEG_CD_BACKEND").as_deref() == Ok("sim") {
        return Box::new(sim::SimBackend::from_dir(std::env::var("BOOTLEG_CD_SIM").unwrap_or_default()));
    }
    #[cfg(target_os = "macos")] { return Box::new(macos::MacBackend); }
    #[allow(unreachable_code)] Box::new(Unsupported)
}
