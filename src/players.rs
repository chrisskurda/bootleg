//! `.bootleg/players/<id>.toml` (device format §5): players that report an identity (bootleg-pod does,
//! when it starts with the medium present). Stock-firmware players are identified by the desktop instead.
use crate::{io_err, now, write_atomic, Device, Error, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlayerRecord {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub app: String,
    #[serde(default)]
    pub last_seen: u64,
    #[serde(flatten)]
    pub extra: toml::Table,
}

fn dir(volume: &Path) -> PathBuf {
    Device::meta_dir_of(volume).join("players")
}

fn file_name(id: &str) -> String {
    let safe: String = id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect();
    format!("{safe}.toml")
}

/// Record (or refresh) this player on the medium. Keeps keys written by newer versions.
pub fn touch(volume: &Path, rec: &PlayerRecord) -> Result<()> {
    let d = dir(volume);
    std::fs::create_dir_all(&d).map_err(|e| io_err(&d, e))?;
    let file = d.join(file_name(&rec.id));
    let mut r = rec.clone();
    if let Some(old) = std::fs::read_to_string(&file).ok().and_then(|t| toml::from_str::<PlayerRecord>(&t).ok()) {
        for (k, v) in old.extra {
            r.extra.entry(k).or_insert(v);
        }
    }
    r.last_seen = now();
    let text = toml::to_string(&r).map_err(|e| Error::Parse(file.clone(), e.to_string()))?;
    write_atomic(&file, text.as_bytes())
}

pub fn list(volume: &Path) -> Vec<PlayerRecord> {
    let mut v: Vec<PlayerRecord> = std::fs::read_dir(dir(volume))
        .map(|r| r.flatten().filter_map(|e| std::fs::read_to_string(e.path()).ok()).filter_map(|t| toml::from_str(&t).ok()).collect())
        .unwrap_or_default();
    v.sort_by(|a, b| b.last_seen.cmp(&a.last_seen));
    v
}
