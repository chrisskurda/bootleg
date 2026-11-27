// Results kept between runs, so a re-check only reads files that changed (size or modification time) or were checked
// by an older version of the checks. One JSON file in the app's cache folder.
use crate::decode::{FileCheck, VERSION};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::{Path, PathBuf}};

#[derive(Serialize, Deserialize, Clone)]
pub struct Entry { pub size: u64, pub mtime: u64, pub version: u32, pub check: FileCheck }

#[derive(Default)]
pub struct Cache { pub file: Option<PathBuf>, pub map: HashMap<String, Entry>, dirty: bool }
impl Cache {
    pub fn load(file: Option<PathBuf>) -> Self {
        let map = file.as_ref().and_then(|f| std::fs::read(f).ok()).and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        Cache { file, map, dirty: false }
    }
    pub fn get(&self, path: &str, size: u64, mtime: u64) -> Option<&FileCheck> { self.map.get(path).filter(|e| e.size == size && e.mtime == mtime && e.version == VERSION).map(|e| &e.check) }
    pub fn put(&mut self, path: &str, size: u64, mtime: u64, check: FileCheck) { self.map.insert(path.into(), Entry { size, mtime, version: VERSION, check }); self.dirty = true; }
    pub fn forget(&mut self, paths: &[String]) { if paths.is_empty() { self.map.clear(); } else { for p in paths { self.map.remove(p); } } self.dirty = true; }
    pub fn save(&mut self) -> Result<(), String> {
        let (Some(f), true) = (&self.file, self.dirty) else { return Ok(()) };
        if let Some(d) = f.parent() { std::fs::create_dir_all(d).map_err(|e| e.to_string())?; }
        let tmp = f.with_extension("tmp"); std::fs::write(&tmp, serde_json::to_vec(&self.map).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, f).map_err(|e| e.to_string())?; self.dirty = false; Ok(())
    }
}
pub fn stat(p: &Path) -> (u64, u64) {
    std::fs::metadata(p).map(|m| (m.len(), m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0))).unwrap_or((0, 0))
}
