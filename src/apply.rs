//! Carry out a plan (device format §4): journal first, copies to `.bootleg-tmp` then renamed, manifest
//! updated after each file, compacted at the end. Safe to interrupt at any point.
use crate::config::Mode;
use crate::journal::{self, tmp_of, Intent};
use crate::manifest::{Entry, Kind};
use crate::plan::{Op, Plan};
use crate::{hash_file, hex, io_err, now, Device, Error, Result};
use sha2::{Digest, Sha256};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;

/// Progress and cancellation. `()` is a silent, never-cancelled progress.
pub trait Progress {
    fn step(&mut self, _done: usize, _total: usize, _what: &str) {}
    fn cancelled(&self) -> bool {
        false
    }
}
impl Progress for () {}

/// Converts audio for players that can't play the source (the desktop passes its transcoder).
pub trait Transcoder {
    /// Write `src` converted to `target` (e.g. `mp3-v0`, `aac-256`, `alac`) at `dest`, tags and cover kept.
    fn transcode(&self, src: &Path, dest: &Path, target: &str) -> std::result::Result<(), String>;
}

#[derive(Debug, Default)]
pub struct Report {
    pub copied: usize,
    pub transcoded: usize,
    pub deleted: usize,
    pub playlists: usize,
    pub bytes: u64,
    /// (path, error); the sync carries on past single-file failures
    pub failed: Vec<(String, String)>,
    pub cancelled: bool,
}

/// Copy `src` (or just `range` = (offset, length) of it) to `dest`, hashing what was written.
fn copy_hashing(src: &Path, range: Option<(u64, u64)>, dest: &Path) -> Result<(u64, String)> {
    let mut i = std::fs::File::open(src).map_err(|e| io_err(src, e))?;
    let mut left = u64::MAX;
    if let Some((off, len)) = range {
        i.seek(SeekFrom::Start(off)).map_err(|e| io_err(src, e))?;
        left = len;
    }
    let mut o = std::fs::File::create(dest).map_err(|e| io_err(dest, e))?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];
    let mut n = 0u64;
    while left > 0 {
        let want = buf.len().min(left.min(usize::MAX as u64) as usize);
        let k = i.read(&mut buf[..want]).map_err(|e| io_err(src, e))?;
        if k == 0 {
            if range.is_some() {
                return Err(Error::Refused(format!("{}: ends {left} bytes before the packaged file does", src.display())));
            }
            break;
        }
        left -= k as u64;
        o.write_all(&buf[..k]).map_err(|e| io_err(dest, e))?;
        h.update(&buf[..k]);
        n += k as u64;
    }
    o.sync_all().map_err(|e| io_err(dest, e))?;
    Ok((n, hex(&h.finalize())))
}

/// Remove folders a delete left empty, up to (not including) the managed root.
fn prune_empty(dev: &Device, rel: &str) {
    let root = dev.abs(&dev.config.root);
    let mut dir = dev.abs(rel);
    while dir.pop() && dir.starts_with(&root) && dir != root {
        if std::fs::remove_dir(&dir).is_err() {
            break; // not empty (or not ours to judge): stop
        }
    }
}

pub fn apply(dev: &mut Device, plan: &Plan, progress: &mut dyn Progress, transcoder: Option<&dyn Transcoder>) -> Result<Report> {
    if let Some(n) = plan.short_by {
        if dev.config.mode == Mode::Mirror {
            return Err(Error::Refused(format!("the selection does not fit: {n} bytes short. Choose less, free space, or use fill mode")));
        }
    }
    // the rule, checked again here so a hand-built plan can't break it
    for op in &plan.ops {
        let (path, mine_required) = match op {
            Op::Delete { path, .. } => (path, true),
            Op::Copy { dest, replaces: true, .. } | Op::Playlist { dest, replaces: true, .. } => (dest, true),
            Op::Copy { dest, .. } | Op::Playlist { dest, .. } => (dest, false),
        };
        let mine = dev.manifest.contains(path);
        if mine_required && !mine {
            return Err(Error::Refused(format!("{path} is not bootleg's file; not replacing or deleting it")));
        }
        if !mine && !matches!(op, Op::Delete { .. }) && dev.abs(path).exists() {
            let freed_first = plan.ops.iter().any(|o| matches!(o, Op::Delete { path: p, .. } if crate::names::key(p) == crate::names::key(path)));
            if !freed_first {
                return Err(Error::Refused(format!("{path} exists and is not bootleg's file; not overwriting it")));
            }
        }
    }
    let intents: Vec<Intent> = plan
        .ops
        .iter()
        .map(|op| match op {
            Op::Delete { path, .. } => Intent { op: "delete".into(), path: path.clone(), track: None, src: None, kind: None },
            Op::Copy { dest, track, src_fp, .. } => Intent { op: "copy".into(), path: dest.clone(), track: Some(track.clone()), src: Some(src_fp.clone()), kind: Some(Kind::Track) },
            Op::Playlist { dest, .. } => Intent { op: "copy".into(), path: dest.clone(), track: None, src: None, kind: Some(Kind::Playlist) },
        })
        .collect();
    journal::begin(dev, &intents)?;

    let mut r = Report::default();
    let total = plan.ops.len();
    for (i, op) in plan.ops.iter().enumerate() {
        if progress.cancelled() {
            r.cancelled = true;
            break;
        }
        match op {
            Op::Delete { path, .. } => {
                progress.step(i, total, &format!("delete {path}"));
                let abs = dev.abs(path);
                match std::fs::remove_file(&abs) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => {
                        r.failed.push((path.clone(), e.to_string()));
                        continue;
                    }
                }
                dev.manifest.del(path)?;
                prune_empty(dev, path);
                r.deleted += 1;
            }
            Op::Copy { track, src, range, dest, src_fp, transcode, .. } => {
                progress.step(i, total, &format!("copy {dest}"));
                let abs = dev.abs(dest);
                let tmp = tmp_of(&abs);
                let res = (|| -> Result<(u64, String)> {
                    if let Some(parent) = abs.parent() {
                        std::fs::create_dir_all(parent).map_err(|e| io_err(parent, e))?;
                    }
                    let out = match transcode {
                        None => copy_hashing(src, *range, &tmp)?,
                        Some(target) => {
                            let t = transcoder.ok_or_else(|| Error::Refused("no transcoder available".into()))?;
                            t.transcode(src, &tmp, target).map_err(Error::Refused)?;
                            hash_file(&tmp)?
                        }
                    };
                    std::fs::rename(&tmp, &abs).map_err(|e| io_err(&abs, e))?;
                    Ok(out)
                })();
                match res {
                    Ok((size, sha256)) => {
                        dev.manifest.put(Entry { path: dest.clone(), size, sha256, kind: Kind::Track, track: Some(track.clone()), src: Some(src_fp.clone()), synced: now() })?;
                        r.bytes += size;
                        if transcode.is_some() { r.transcoded += 1 } else { r.copied += 1 }
                    }
                    Err(e) => {
                        let _ = std::fs::remove_file(&tmp);
                        r.failed.push((dest.clone(), e.to_string()));
                    }
                }
            }
            Op::Playlist { dest, content, name, .. } => {
                progress.step(i, total, &format!("playlist {name}"));
                let abs = dev.abs(dest);
                let res = (|| -> Result<()> {
                    if let Some(parent) = abs.parent() {
                        std::fs::create_dir_all(parent).map_err(|e| io_err(parent, e))?;
                    }
                    let tmp = tmp_of(&abs);
                    std::fs::write(&tmp, content).map_err(|e| io_err(&tmp, e))?;
                    std::fs::rename(&tmp, &abs).map_err(|e| io_err(&abs, e))
                })();
                match res {
                    Ok(()) => {
                        let sha = hex(&Sha256::digest(content));
                        dev.manifest.put(Entry { path: dest.clone(), size: content.len() as u64, sha256: sha, kind: Kind::Playlist, track: None, src: None, synced: now() })?;
                        r.playlists += 1;
                    }
                    Err(e) => r.failed.push((dest.clone(), e.to_string())),
                }
            }
        }
    }
    progress.step(total, total, "done");
    dev.manifest.compact()?;
    if !r.cancelled {
        dev.config.last_sync = Some(now());
        dev.save_config()?;
    }
    journal::end(dev)?;
    Ok(r)
}
