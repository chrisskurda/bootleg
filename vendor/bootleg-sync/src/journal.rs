//! `.bootleg/journal.jsonl` (device format §4): what a sync is about to do, so an interrupted one
//! (card pulled, battery died) can be cleaned up by whoever opens the medium next.
use crate::manifest::{Entry, Kind};
use crate::{hash_file, io_err, now, Device, Result};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Intent {
    pub op: String, // "copy" | "delete"
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub track: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub src: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<Kind>,
}

pub fn path(dev: &Device) -> PathBuf {
    dev.meta_dir().join("journal.jsonl")
}

pub fn tmp_of(p: &std::path::Path) -> PathBuf {
    let mut s = p.as_os_str().to_owned();
    s.push(".bootleg-tmp");
    PathBuf::from(s)
}

/// Write every intended operation before the first one starts.
pub fn begin(dev: &Device, intents: &[Intent]) -> Result<()> {
    let p = path(dev);
    let mut buf = String::new();
    for i in intents {
        buf.push_str(&serde_json::to_string(i).unwrap());
        buf.push('\n');
    }
    let mut f = std::fs::File::create(&p).map_err(|e| io_err(&p, e))?;
    f.write_all(buf.as_bytes()).map_err(|e| io_err(&p, e))?;
    f.sync_all().map_err(|e| io_err(&p, e))
}

pub fn end(dev: &Device) -> Result<()> {
    let p = path(dev);
    match std::fs::remove_file(&p) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(io_err(&p, e)),
        _ => Ok(()),
    }
}

#[derive(Debug, Default, Clone)]
pub struct Recovery {
    /// half-written temporary files removed
    pub temps_removed: usize,
    /// finished copies that had not reached the manifest yet, added
    pub adopted: Vec<String>,
    /// deletes that happened but were not recorded, removed from the manifest
    pub forgotten: Vec<String>,
}

pub(crate) fn recover(dev: &mut Device) -> Result<Option<Recovery>> {
    let p = path(dev);
    let text = match std::fs::read_to_string(&p) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(io_err(&p, e)),
    };
    let mut r = Recovery::default();
    for line in text.lines() {
        let Ok(i) = serde_json::from_str::<Intent>(line) else { continue };
        let abs = dev.abs(&i.path);
        match i.op.as_str() {
            "copy" => {
                let tmp = tmp_of(&abs);
                if tmp.exists() && std::fs::remove_file(&tmp).is_ok() {
                    r.temps_removed += 1;
                }
                // the planner only picks paths that are free or bootleg's own, so a file here is ours
                // (a replace that never got to its rename leaves the old file, still matching the manifest)
                if !abs.is_file() {
                    continue;
                }
                let old = dev.manifest.get(&i.path).map(|e| (e.src == i.src, e.size, e.sha256.clone()));
                if matches!(old, Some((true, _, _))) {
                    continue;
                }
                let (size, sha256) = hash_file(&abs)?;
                if matches!(&old, Some((_, s, h)) if *s == size && *h == sha256) {
                    continue;
                }
                {
                    dev.manifest.put(Entry { path: i.path.clone(), size, sha256, kind: i.kind.unwrap_or(Kind::Track), track: i.track, src: i.src, synced: now() })?;
                    r.adopted.push(i.path);
                }
            }
            "delete" => {
                if !abs.exists() && dev.manifest.contains(&i.path) {
                    dev.manifest.del(&i.path)?;
                    r.forgotten.push(i.path);
                }
            }
            _ => {}
        }
    }
    dev.manifest.compact()?;
    end(dev)?;
    Ok(Some(r))
}
