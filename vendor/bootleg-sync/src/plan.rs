//! Work out a sync (device format §3.2) without touching the volume (it only looks at which paths exist).
//! The one rule: only manifest files are ever replaced or deleted.
use crate::config::Mode;
use crate::disk::{Disk, FAT32_MAX_FILE};
use crate::manifest::Kind;
use crate::names::{alternative, key, relative, safe_path};
use crate::{Device, Error, Result};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

/// One track the selection wants on the medium, in priority order (pinned first).
#[derive(Debug, Clone)]
pub struct Item {
    /// desktop track key (`sourceKind:id…`)
    pub track: String,
    pub src: PathBuf,
    /// wanted path under the managed root, `/`-separated (made safe by the planner), e.g. `Artist/Album/01 Title.flac`
    pub rel: String,
    pub size: u64,
    /// source fingerprint (`size:mtime` for local files); a change means copy again
    pub src_fp: String,
    /// lowercase extension / codec of the source
    pub codec: String,
    /// copy only `(offset, length)` bytes of `src`: an uncompressed entry inside a package (a `.bstem` is a zip whose
    /// audio is stored, not deflated). `size` is then the entry's length. Ranged sources can't be transcoded.
    pub range: Option<(u64, u64)>,
}

#[derive(Debug, Clone)]
pub struct PlaylistSpec {
    pub name: String,
    /// track keys, in order
    pub tracks: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct PlanOptions {
    /// a transcoder is available for codecs the player can't play
    pub can_transcode: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Op {
    /// copy (or transcode) a track to `dest`; `replaces` = overwrite bootleg's own older copy there
    Copy { track: String, src: PathBuf, range: Option<(u64, u64)>, dest: String, size: u64, src_fp: String, transcode: Option<String>, replaces: bool },
    /// delete a file bootleg wrote (always a manifest path)
    Delete { path: String, size: u64 },
    Playlist { name: String, dest: String, content: Vec<u8>, replaces: bool },
}

#[derive(Debug, Clone, PartialEq)]
pub enum Skip {
    NoSpace,
    NeedsTranscode,
    TooBigForFat32,
    /// no free name found (more than 99 collisions)
    NameTaken,
    /// a playlist none of whose tracks are on the medium (all skipped, or not copyable): not written
    EmptyPlaylist,
}

#[derive(Debug, Clone, Default)]
pub struct Plan {
    pub ops: Vec<Op>,
    /// tracks already on the medium and current
    pub unchanged: usize,
    /// tracks left out, with why (track key, reason)
    pub skipped: Vec<(String, Skip)>,
    /// tracks that got a ` (bootleg)` name because a foreign file held their path
    pub renamed: Vec<(String, String)>,
    pub bytes_in: u64,
    pub bytes_freed: u64,
    /// mirror only: the selection does not fit by this many bytes; apply refuses
    pub short_by: Option<u64>,
    /// bootleg files left in place in `add` mode that the selection no longer has
    pub kept_unselected: usize,
}

impl Plan {
    pub fn is_noop(&self) -> bool {
        self.ops.is_empty()
    }
}

fn output_ext(codec: &str, transcode: &Option<String>) -> String {
    match transcode.as_deref() {
        None => codec.to_string(),
        Some(t) => {
            let c = t.split('-').next().unwrap_or(t);
            match c { "aac" | "alac" => "m4a".into(), "vorbis" => "ogg".into(), other => other.into() }
        }
    }
}

fn with_ext(rel: &str, ext: &str) -> String {
    let file_start = rel.rfind('/').map(|i| i + 1).unwrap_or(0);
    match rel[file_start..].rfind('.') {
        Some(i) => format!("{}.{ext}", &rel[..file_start + i]),
        None => format!("{rel}.{ext}"),
    }
}

pub fn plan(dev: &Device, items: &[Item], playlists: &[PlaylistSpec], disk: &Disk, opts: &PlanOptions) -> Result<Plan> {
    let cfg = &dev.config;
    let prof = &cfg.profile;
    let m = &dev.manifest;
    let mut p = Plan::default();
    let wanted: HashSet<&str> = items.iter().map(|i| i.track.as_str()).collect();

    // paths this sync will own after it runs (case-insensitive), to avoid two items sharing one
    let mut taken: HashSet<String> = HashSet::new();
    // track key → final path, for playlists
    let mut placed: HashMap<String, String> = HashMap::new();
    let mut deletes: Vec<Op> = vec![];
    // op, bytes needed, bytes it frees (the copy it replaces), the old copy's delete when it was in another format
    let mut copies: Vec<(Op, u64, u64, Option<Op>)> = vec![];

    // 1. bootleg tracks the selection no longer has
    for e in m.iter().filter(|e| e.kind == Kind::Track) {
        let gone = e.track.as_deref().map(|t| !wanted.contains(t)).unwrap_or(true);
        if !gone {
            continue;
        }
        match cfg.mode {
            Mode::Add => {
                p.kept_unselected += 1;
                taken.insert(key(&e.path));
            }
            Mode::Mirror | Mode::Fill => deletes.push(Op::Delete { path: e.path.clone(), size: e.size }),
        }
    }

    // 2. what each wanted track needs
    for it in items {
        let transcode = if prof.plays(&it.codec) {
            None
        } else if opts.can_transcode && !prof.transcode_to.is_empty() && it.range.is_none() {
            Some(prof.transcode_to.clone())
        } else {
            p.skipped.push((it.track.clone(), Skip::NeedsTranscode));
            continue;
        };
        if disk.fat32 && transcode.is_none() && it.size > FAT32_MAX_FILE {
            p.skipped.push((it.track.clone(), Skip::TooBigForFat32));
            continue;
        }
        let ext = output_ext(&it.codec, &transcode);
        let existing = m.by_track(&it.track).filter(|e| e.kind == Kind::Track);
        if let Some(e) = existing {
            if e.src.as_deref() == Some(it.src_fp.as_str()) && dev.abs(&e.path).is_file() {
                p.unchanged += 1;
                taken.insert(key(&e.path));
                placed.insert(it.track.clone(), e.path.clone());
                continue;
            }
        }
        let wanted_path = safe_path(&cfg.root, &with_ext(&it.rel, &ext), prof);
        // replace bootleg's own copy in place when it is at the wanted path (or the old copy has the same extension)
        let (dest, replaces, frees, old) = match existing {
            Some(e) if key(&e.path) == key(&wanted_path) || e.path.rsplit('.').next().map(|x| x.eq_ignore_ascii_case(&ext)).unwrap_or(false) => {
                (e.path.clone(), true, e.size, None)
            }
            other => {
                // an old copy in another format goes once its replacement is written, in every mode
                let old = other.map(|e| (Op::Delete { path: e.path.clone(), size: e.size }, e.size));
                let mut d = wanted_path.clone();
                let mut n = 0;
                while taken.contains(&key(&d)) || (!m.contains(&d) && dev.abs(&d).exists()) || (m.contains(&d) && !deletes.iter().any(|op| matches!(op, Op::Delete { path, .. } if key(path) == key(&d)))) {
                    n += 1;
                    if n > 99 {
                        break;
                    }
                    d = alternative(&wanted_path, n);
                }
                if n > 99 {
                    p.skipped.push((it.track.clone(), Skip::NameTaken));
                    continue;
                }
                if n > 0 {
                    p.renamed.push((it.track.clone(), d.clone()));
                }
                match old {
                    Some((op, size)) => (d, false, size, Some(op)),
                    None => (d, false, 0, None),
                }
            }
        };
        taken.insert(key(&dest));
        let op = Op::Copy { track: it.track.clone(), src: it.src.clone(), range: it.range, dest: dest.clone(), size: it.size, src_fp: it.src_fp.clone(), transcode, replaces };
        copies.push((op, it.size, frees, old));
        placed.insert(it.track.clone(), dest);
    }

    // 3. space
    let freed: u64 = deletes.iter().map(|o| if let Op::Delete { size, .. } = o { *size } else { 0 }).sum();
    let keep_free = cfg.keep_free().map_err(Error::Refused)?;
    let mut budget = disk.free as i128 - keep_free as i128;
    if let Some(pct) = cfg.fill.max_use {
        let cap = disk.total as i128 * pct.min(100) as i128 / 100;
        budget = budget.min(cap - (disk.total as i128 - disk.free as i128));
    }
    budget += freed as i128;
    let mut chosen = vec![];
    match cfg.mode {
        Mode::Mirror => {
            let need: i128 = copies.iter().map(|c| c.1 as i128 - c.2 as i128).sum();
            if need > budget {
                p.short_by = Some((need - budget) as u64);
            }
            chosen = copies;
        }
        Mode::Add | Mode::Fill => {
            for c in copies {
                let need = c.1 as i128 - c.2 as i128;
                if need <= budget {
                    budget -= need;
                    chosen.push(c);
                } else {
                    if let Op::Copy { track, .. } = &c.0 {
                        placed.remove(track);
                        p.skipped.push((track.clone(), Skip::NoSpace));
                    }
                }
            }
        }
    }
    p.bytes_freed = freed + chosen.iter().map(|c| c.2).sum::<u64>();
    let replaced_old: Vec<Op> = chosen.iter_mut().filter_map(|c| c.3.take()).collect();
    p.bytes_in = chosen.iter().map(|c| c.1).sum();

    // 4. playlists (Playlists/ under the managed root), pointing at where each track ends up
    let pl_dir = if cfg.root.is_empty() { "Playlists".to_string() } else { format!("{}/Playlists", cfg.root) };
    let ext = prof.playlist_ext();
    let mut pl_paths = HashSet::new();
    for pl in playlists {
        let dest = safe_path(&cfg.root, &format!("Playlists/{}.{ext}", pl.name), prof);
        if !pl.tracks.iter().any(|t| placed.contains_key(t)) {
            p.skipped.push((format!("playlist:{}", pl.name), Skip::EmptyPlaylist));
            continue;
        }
        let mut text = String::from("#EXTM3U\n");
        for t in &pl.tracks {
            if let Some(path) = placed.get(t) {
                let rel = relative(&pl_dir, path);
                text.push_str(&if prof.path_sep == "\\" { rel.replace('/', "\\") } else { rel });
                text.push('\n');
            }
        }
        let content = if ext == "m3u" { text.chars().map(|c| if (c as u32) < 256 { c as u8 } else { b'?' }).collect() } else { text.into_bytes() };
        let mine = m.get(&dest).is_some();
        if !mine && dev.abs(&dest).exists() {
            p.skipped.push((format!("playlist:{}", pl.name), Skip::NameTaken));
            continue;
        }
        if mine && dev.abs(&dest).is_file() && std::fs::read(dev.abs(&dest)).ok().as_deref() == Some(content.as_slice()) {
            pl_paths.insert(key(&dest));
            continue;
        }
        pl_paths.insert(key(&dest));
        p.ops.push(Op::Playlist { name: pl.name.clone(), dest, content, replaces: mine });
    }
    if cfg.mode != Mode::Add {
        for e in m.iter().filter(|e| e.kind == Kind::Playlist && !pl_paths.contains(&key(&e.path))) {
            deletes.push(Op::Delete { path: e.path.clone(), size: e.size });
        }
    }

    // deletes first (they make the room), then copies, then playlists
    let pls: Vec<Op> = std::mem::take(&mut p.ops);
    p.ops = deletes;
    p.ops.extend(chosen.into_iter().map(|c| c.0));
    p.ops.extend(replaced_old);
    p.ops.extend(pls);
    Ok(p)
}
