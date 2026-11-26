//! `.bootleg/manifest.jsonl` (device format §3.1): an append-while-syncing log, compacted at the end.
use crate::names::key;
use crate::{io_err, Error, Result};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Track,
    Playlist,
    Art,
    Meta,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Entry {
    pub path: String,
    pub size: u64,
    pub sha256: String,
    pub kind: Kind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub track: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub src: Option<String>,
    #[serde(default)]
    pub synced: u64,
}

#[derive(Serialize, Deserialize)]
struct Header {
    format: u32,
    device: String,
}

#[derive(Deserialize)]
struct Del {
    del: String,
}

#[derive(Debug)]
pub struct Manifest {
    file: PathBuf,
    device: String,
    entries: BTreeMap<String, Entry>,
    by_track: HashMap<String, String>,
    /// lines that could not be read (reported, otherwise ignored)
    pub warnings: Vec<String>,
    out: Option<File>,
}

impl Manifest {
    pub fn load(file: &Path, device: &str) -> Result<Self> {
        let mut m = Manifest { file: file.to_path_buf(), device: device.into(), entries: BTreeMap::new(), by_track: HashMap::new(), warnings: vec![], out: None };
        let f = match File::open(file) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(m),
            Err(e) => return Err(io_err(file, e)),
        };
        for (i, line) in BufReader::new(f).lines().enumerate() {
            let line = line.map_err(|e| io_err(file, e))?;
            let t = line.trim();
            if t.is_empty() {
                continue;
            }
            if i == 0 {
                if let Ok(h) = serde_json::from_str::<Header>(t) {
                    if h.format > crate::config::FORMAT {
                        return Err(Error::NewerFormat(h.format));
                    }
                    if h.device != device {
                        m.warnings.push(format!("manifest belongs to device {} (expected {device})", h.device));
                    }
                    continue;
                }
            }
            if let Ok(e) = serde_json::from_str::<Entry>(t) {
                m.insert(e);
            } else if let Ok(d) = serde_json::from_str::<Del>(t) {
                m.remove(&d.del);
            } else {
                m.warnings.push(format!("line {}: not understood, ignored", i + 1));
            }
        }
        Ok(m)
    }

    fn insert(&mut self, e: Entry) {
        let k = key(&e.path);
        if let Some(old) = self.entries.get(&k) {
            if let Some(t) = &old.track {
                if self.by_track.get(t) == Some(&k) {
                    self.by_track.remove(t);
                }
            }
        }
        if let Some(t) = &e.track {
            self.by_track.insert(t.clone(), k.clone());
        }
        self.entries.insert(k, e);
    }

    fn remove(&mut self, path: &str) -> Option<Entry> {
        let k = key(path);
        let e = self.entries.remove(&k)?;
        if let Some(t) = &e.track {
            if self.by_track.get(t) == Some(&k) {
                self.by_track.remove(t);
            }
        }
        Some(e)
    }

    pub fn get(&self, path: &str) -> Option<&Entry> {
        self.entries.get(&key(path))
    }
    pub fn contains(&self, path: &str) -> bool {
        self.entries.contains_key(&key(path))
    }
    pub fn by_track(&self, track: &str) -> Option<&Entry> {
        self.by_track.get(track).and_then(|k| self.entries.get(k))
    }
    pub fn iter(&self) -> impl Iterator<Item = &Entry> {
        self.entries.values()
    }
    pub fn len(&self) -> usize {
        self.entries.len()
    }
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
    pub fn bytes(&self) -> u64 {
        self.entries.values().map(|e| e.size).sum()
    }

    fn append(&mut self, line: &str) -> Result<()> {
        if self.out.is_none() {
            let fresh = !self.file.exists();
            let mut f = OpenOptions::new().create(true).append(true).open(&self.file).map_err(|e| io_err(&self.file, e))?;
            if fresh {
                let h = serde_json::to_string(&Header { format: crate::config::FORMAT, device: self.device.clone() }).unwrap();
                writeln!(f, "{h}").map_err(|e| io_err(&self.file, e))?;
            }
            self.out = Some(f);
        }
        let f = self.out.as_mut().unwrap();
        writeln!(f, "{line}").map_err(|e| io_err(&self.file, e))
    }

    /// Record a file bootleg wrote (appended at once, so a crash right after keeps it).
    pub fn put(&mut self, e: Entry) -> Result<()> {
        self.append(&serde_json::to_string(&e).unwrap())?;
        self.insert(e);
        Ok(())
    }

    /// Forget a file bootleg deleted.
    pub fn del(&mut self, path: &str) -> Result<()> {
        if self.remove(path).is_some() {
            self.append(&serde_json::json!({ "del": path }).to_string())?;
        }
        Ok(())
    }

    /// Rewrite the log as one line per file (temporary file, flushed, then renamed over the old one).
    pub fn compact(&mut self) -> Result<()> {
        self.out = None;
        let tmp = self.file.with_extension("jsonl.tmp");
        {
            let mut f = File::create(&tmp).map_err(|e| io_err(&tmp, e))?;
            let mut buf = serde_json::to_string(&Header { format: crate::config::FORMAT, device: self.device.clone() }).unwrap();
            buf.push('\n');
            for e in self.entries.values() {
                buf.push_str(&serde_json::to_string(e).unwrap());
                buf.push('\n');
            }
            f.write_all(buf.as_bytes()).map_err(|e| io_err(&tmp, e))?;
            f.sync_all().map_err(|e| io_err(&tmp, e))?;
        }
        std::fs::rename(&tmp, &self.file).map_err(|e| io_err(&self.file, e))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(path: &str, track: &str) -> Entry {
        Entry { path: path.into(), size: 10, sha256: "x".into(), kind: Kind::Track, track: Some(track.into()), src: Some("10:1".into()), synced: 1 }
    }

    #[test]
    fn log_replays_and_compacts() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("manifest.jsonl");
        let mut m = Manifest::load(&f, "dev").unwrap();
        m.put(entry("M/A.flac", "t:a")).unwrap();
        m.put(entry("M/B.flac", "t:b")).unwrap();
        m.del("m/a.FLAC").unwrap(); // case-insensitive
        m.put(Entry { size: 20, ..entry("M/B.flac", "t:b") }).unwrap();
        drop(m);
        let mut m = Manifest::load(&f, "dev").unwrap();
        assert_eq!(m.len(), 1);
        assert_eq!(m.get("M/B.flac").unwrap().size, 20);
        assert_eq!(m.by_track("t:b").unwrap().path, "M/B.flac");
        assert!(m.by_track("t:a").is_none());
        m.compact().unwrap();
        assert_eq!(std::fs::read_to_string(&f).unwrap().lines().count(), 2);
        assert_eq!(Manifest::load(&f, "dev").unwrap().len(), 1);
    }

    #[test]
    fn bad_lines_are_reported_not_fatal() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("manifest.jsonl");
        std::fs::write(&f, "{\"format\":1,\"device\":\"dev\"}\nnot json\n{\"path\":\"a\",\"size\":1,\"sha256\":\"x\",\"kind\":\"track\"}\n").unwrap();
        let m = Manifest::load(&f, "dev").unwrap();
        assert_eq!(m.len(), 1);
        assert_eq!(m.warnings.len(), 1);
    }

    #[test]
    fn newer_format_is_refused() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("manifest.jsonl");
        std::fs::write(&f, "{\"format\":2,\"device\":\"dev\"}\n").unwrap();
        assert!(matches!(Manifest::load(&f, "dev"), Err(Error::NewerFormat(2))));
    }
}
