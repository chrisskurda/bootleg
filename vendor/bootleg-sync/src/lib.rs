//! bootleg device format 1 (`contracts/device_format.md`): mark a volume as a bootleg medium, and sync it
//! without ever touching files bootleg did not write. Used by bootleg-pod (reads its own card, writes the
//! outbox) and by the desktop app (pairs and fills cards).
//!
//! ```no_run
//! use bootleg_sync::{Device, plan::{plan, Item, PlanOptions}, apply::apply, disk};
//! let mut dev = Device::open("/Volumes/R36S".as_ref()).unwrap();
//! let items: Vec<Item> = vec![]; // what the selection should put on the card
//! let p = plan(&dev, &items, &[], &disk::info(&dev.volume).unwrap(), &PlanOptions::default()).unwrap();
//! let report = apply(&mut dev, &p, &mut (), None).unwrap();
//! ```
pub mod apply;
pub mod config;
pub mod disk;
pub mod journal;
pub mod manifest;
pub mod names;
pub mod outbox;
pub mod plan;
pub mod players;

use config::{DeviceConfig, Mode, FORMAT};
use manifest::Manifest;
use sha2::{Digest, Sha256};
use std::fmt;
use std::io::Read;
use std::path::{Path, PathBuf};

pub const META_DIR: &str = ".bootleg";

#[derive(Debug)]
pub enum Error {
    /// no `.bootleg/device.toml`: the volume has not been paired
    NotPaired,
    /// already paired (on init)
    AlreadyPaired,
    /// written by a newer, incompatible version: must not write
    NewerFormat(u32),
    Parse(PathBuf, String),
    Io(PathBuf, std::io::Error),
    /// the plan or the request breaks a rule (with why)
    Refused(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            Error::NotPaired => write!(f, "not a bootleg medium (no {META_DIR}/device.toml); pair it first"),
            Error::AlreadyPaired => write!(f, "already a bootleg medium"),
            Error::NewerFormat(v) => write!(f, "written by a newer bootleg (device format {v}); not writing to it"),
            Error::Parse(p, e) => write!(f, "{}: {e}", p.display()),
            Error::Io(p, e) => write!(f, "{}: {e}", p.display()),
            Error::Refused(why) => write!(f, "{why}"),
        }
    }
}
impl std::error::Error for Error {}
pub type Result<T> = std::result::Result<T, Error>;

pub(crate) fn io_err(p: &Path, e: std::io::Error) -> Error {
    Error::Io(p.to_path_buf(), e)
}

pub fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}
pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// sha256 of a file, hex.
pub fn hash_file(p: &Path) -> Result<(u64, String)> {
    let mut f = std::fs::File::open(p).map_err(|e| io_err(p, e))?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    let mut n = 0u64;
    loop {
        let k = f.read(&mut buf).map_err(|e| io_err(p, e))?;
        if k == 0 {
            break;
        }
        h.update(&buf[..k]);
        n += k as u64;
    }
    Ok((n, hex(&h.finalize())))
}

pub(crate) fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// A paired volume: its settings and the manifest of what bootleg wrote there.
#[derive(Debug)]
pub struct Device {
    pub volume: PathBuf,
    pub config: DeviceConfig,
    pub manifest: Manifest,
    /// what recovery did when an interrupted sync was found on open
    pub recovered: Option<journal::Recovery>,
}

impl Device {
    pub fn meta_dir_of(volume: &Path) -> PathBuf {
        volume.join(META_DIR)
    }
    pub fn is_paired(volume: &Path) -> bool {
        Self::meta_dir_of(volume).join("device.toml").is_file()
    }

    /// Open a paired volume, finishing or rolling back an interrupted sync first.
    pub fn open(volume: &Path) -> Result<Device> {
        let file = Self::meta_dir_of(volume).join("device.toml");
        let text = match std::fs::read_to_string(&file) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(Error::NotPaired),
            Err(e) => return Err(io_err(&file, e)),
        };
        // check the version before the full parse, so a newer layout is refused rather than misread
        if let Ok(v) = text.parse::<toml::Table>() {
            if let Some(f) = v.get("format").and_then(|f| f.as_integer()) {
                if f > FORMAT as i64 {
                    return Err(Error::NewerFormat(f as u32));
                }
            }
        }
        let config = DeviceConfig::parse(&text).map_err(|e| Error::Parse(file.clone(), e))?;
        let manifest = Manifest::load(&Self::meta_dir_of(volume).join("manifest.jsonl"), &config.id)?;
        let mut d = Device { volume: volume.to_path_buf(), config, manifest, recovered: None };
        d.recovered = journal::recover(&mut d)?;
        Ok(d)
    }

    /// Pair a volume: write `.bootleg/device.toml` with a new id. Nothing else on the volume is touched.
    pub fn init(volume: &Path, name: &str, kind: &str, mode: Mode, root: &str) -> Result<Device> {
        if !volume.is_dir() {
            return Err(io_err(volume, std::io::Error::new(std::io::ErrorKind::NotFound, "volume not found")));
        }
        if Self::is_paired(volume) {
            return Err(Error::AlreadyPaired);
        }
        let dir = Self::meta_dir_of(volume);
        std::fs::create_dir_all(&dir).map_err(|e| io_err(&dir, e))?;
        disk::hide(&dir);
        let config = DeviceConfig::new(uuid::Uuid::new_v4().to_string(), name.into(), kind.into(), mode, root.into(), now());
        let d = Device { volume: volume.to_path_buf(), manifest: Manifest::load(&dir.join("manifest.jsonl"), &config.id)?, config, recovered: None };
        d.save_config()?;
        Ok(d)
    }

    pub fn meta_dir(&self) -> PathBuf {
        Self::meta_dir_of(&self.volume)
    }

    /// Write `device.toml` (temporary file, then rename). Unknown keys from newer writers are kept.
    pub fn save_config(&self) -> Result<()> {
        let file = self.meta_dir().join("device.toml");
        let text = self.config.to_toml().map_err(|e| Error::Parse(file.clone(), e))?;
        write_atomic(&file, text.as_bytes())
    }

    /// Volume-relative path → absolute path.
    pub fn abs(&self, rel: &str) -> PathBuf {
        let mut p = self.volume.clone();
        for c in rel.split('/').filter(|c| !c.is_empty()) {
            p.push(c);
        }
        p
    }

    /// The desktop track key for a file on this volume, if bootleg put it there (pod: report plays against it).
    pub fn track_for(&self, rel: &str) -> Option<&str> {
        self.manifest.get(rel).and_then(|e| e.track.as_deref())
    }

    /// Re-hash every file in the manifest.
    pub fn verify(&self) -> Result<Verify> {
        let mut v = Verify::default();
        for e in self.manifest.iter() {
            let p = self.abs(&e.path);
            if !p.is_file() {
                v.missing.push(e.path.clone());
                continue;
            }
            let (size, sha) = hash_file(&p)?;
            if size != e.size || sha != e.sha256 {
                v.changed.push(e.path.clone());
            } else {
                v.ok += 1;
            }
        }
        Ok(v)
    }
}

#[derive(Debug, Default)]
pub struct Verify {
    pub ok: usize,
    pub missing: Vec<String>,
    pub changed: Vec<String>,
}

pub(crate) fn write_atomic(file: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let tmp = file.with_extension("bootleg-tmp");
    {
        let mut f = std::fs::File::create(&tmp).map_err(|e| io_err(&tmp, e))?;
        f.write_all(bytes).map_err(|e| io_err(&tmp, e))?;
        f.sync_all().map_err(|e| io_err(&tmp, e))?;
    }
    std::fs::rename(&tmp, file).map_err(|e| io_err(file, e))
}

/// Volumes that might be players or cards (removable filesystems, plus anything already paired),
/// and whether each is paired. `extra` adds roots to check, e.g. a pod's own data partition.
pub fn find_media(extra: &[PathBuf]) -> Vec<(PathBuf, bool)> {
    let mut v = disk::removable_mounts();
    for e in extra {
        if !v.contains(e) {
            v.push(e.clone());
        }
    }
    v.into_iter().map(|p| { let paired = Device::is_paired(&p); (p, paired) }).collect()
}
