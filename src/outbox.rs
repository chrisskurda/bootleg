//! Player → desktop events (device format §6): plays, skips, ratings, notes, tags made on the player.
//! Each player session writes its own file, so writers never share one; the desktop deletes what it read.
use crate::{io_err, now_ms, Device, Result};
use serde::{Deserialize, Serialize};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Event {
    /// unix milliseconds
    pub ts: u64,
    /// desktop track key from the manifest, or `file:<path>` for a file bootleg did not write
    pub track: String,
    /// volume-relative path of the file played
    pub path: String,
    /// `play`, `skip`, `rating`, `note`, `tags` (others may be added; readers keep what they don't know)
    #[serde(rename = "type")]
    pub kind: String,
    /// the rest: `seconds`/`complete` (play), `stars` (rating), `text`/`at`/`to` (note), `tags` (tags)
    #[serde(flatten)]
    pub data: serde_json::Map<String, serde_json::Value>,
}

impl Event {
    /// An event for a volume-relative file, keyed the way the desktop knows it.
    pub fn for_file(dev: &Device, rel: &str, kind: &str, data: serde_json::Value) -> Event {
        let track = dev.track_for(rel).map(String::from).unwrap_or_else(|| format!("file:{rel}"));
        let data = match data {
            serde_json::Value::Object(m) => m,
            _ => serde_json::Map::new(),
        };
        Event { ts: now_ms(), track, path: rel.into(), kind: kind.into(), data }
    }
}

fn dir(volume: &Path) -> PathBuf {
    Device::meta_dir_of(volume).join("outbox")
}

/// One player session's outbox file (created on the first event).
pub struct Outbox {
    file: PathBuf,
    out: Option<File>,
}

impl Outbox {
    pub fn new(volume: &Path, player_id: &str) -> Outbox {
        let safe: String = player_id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect();
        Outbox { file: dir(volume).join(format!("{safe}-{}.jsonl", now_ms())), out: None }
    }
    pub fn path(&self) -> &Path {
        &self.file
    }
    /// Append and flush one event (a crash loses at most the line being written).
    pub fn append(&mut self, e: &Event) -> Result<()> {
        if self.out.is_none() {
            let d = self.file.parent().unwrap();
            std::fs::create_dir_all(d).map_err(|err| io_err(d, err))?;
            self.out = Some(OpenOptions::new().create(true).append(true).open(&self.file).map_err(|err| io_err(&self.file, err))?);
        }
        let f = self.out.as_mut().unwrap();
        writeln!(f, "{}", serde_json::to_string(e).unwrap()).map_err(|err| io_err(&self.file, err))?;
        f.sync_data().map_err(|err| io_err(&self.file, err))
    }
}

#[derive(Debug)]
pub struct OutboxFile {
    pub path: PathBuf,
    pub events: Vec<Event>,
    /// lines that did not parse (e.g. cut off by a power loss)
    pub bad_lines: usize,
}

/// Every outbox file on the volume, oldest first.
pub fn read_all(volume: &Path) -> Result<Vec<OutboxFile>> {
    let d = dir(volume);
    let mut files: Vec<PathBuf> = match std::fs::read_dir(&d) {
        Ok(r) => r.flatten().map(|e| e.path()).filter(|p| p.extension().map(|x| x == "jsonl").unwrap_or(false)).collect(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(io_err(&d, e)),
    };
    files.sort();
    let mut out = vec![];
    for path in files {
        let text = std::fs::read_to_string(&path).map_err(|e| io_err(&path, e))?;
        let (mut events, mut bad_lines) = (vec![], 0);
        for l in text.lines().filter(|l| !l.trim().is_empty()) {
            match serde_json::from_str(l) {
                Ok(e) => events.push(e),
                Err(_) => bad_lines += 1,
            }
        }
        out.push(OutboxFile { path, events, bad_lines });
    }
    out.sort_by_key(|f| f.events.first().map(|e| e.ts).unwrap_or(0));
    Ok(out)
}

/// The desktop has merged this file: remove it.
pub fn ack(file: &OutboxFile) -> Result<()> {
    std::fs::remove_file(&file.path).map_err(|e| io_err(&file.path, e))
}
