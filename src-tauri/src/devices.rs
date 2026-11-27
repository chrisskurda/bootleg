// Portable players and SD cards (device format 1, vendor/bootleg-sync). The page chooses what goes on a card;
// everything that touches the card happens here, through bootleg-sync, which never replaces or deletes a file
// bootleg did not write.
use bootleg_sync::apply::{apply, Progress};
use bootleg_sync::config::{clean_root, Mode, Size};
use bootleg_sync::plan::{plan, Item, Op, Plan, PlanOptions, PlaylistSpec, Skip};
use bootleg_sync::{disk, find_media, outbox, players, Device};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

#[derive(Serialize, Default)]
pub struct Medium {
    pub volume: String,
    pub label: String,
    pub paired: bool,
    pub error: Option<String>,
    pub id: String,
    pub name: String,
    pub kind: String,
    pub mode: String,
    pub root: String,
    pub playlists: Vec<String>,
    pub stems: bool,
    /// the page's own selection settings (kept in device.toml under [select], so they travel with the card)
    pub select: Value,
    pub keep_free: String,
    pub max_use: Option<u8>,
    pub codecs: Vec<String>,
    pub last_sync: Option<u64>,
    pub free: Option<u64>,
    pub total: Option<u64>,
    pub fat32: bool,
    pub files: usize,
    pub bytes: u64,
    pub players: Vec<players::PlayerRecord>,
    pub outbox: usize,
    pub recovered: Option<String>,
}

fn label_of(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| p.display().to_string())
}

fn mode_name(m: Mode) -> String {
    match m { Mode::Add => "add", Mode::Mirror => "mirror", Mode::Fill => "fill" }.into()
}

fn describe(volume: &Path) -> Medium {
    let d = disk::info(volume).ok();
    let mut m = Medium { volume: volume.display().to_string(), label: label_of(volume), free: d.map(|d| d.free), total: d.map(|d| d.total), fat32: d.map(|d| d.fat32).unwrap_or(false), ..Default::default() };
    if !Device::is_paired(volume) {
        return m;
    }
    m.paired = true;
    match Device::open(volume) {
        Err(e) => m.error = Some(e.to_string()),
        Ok(dev) => {
            let c = &dev.config;
            m.id = c.id.clone();
            m.name = c.name.clone();
            m.kind = c.kind.clone();
            m.mode = mode_name(c.mode);
            m.root = c.root.clone();
            m.playlists = c.playlists.clone();
            m.stems = c.stems;
            m.select = c.extra.get("select").and_then(|v| serde_json::to_value(v).ok()).unwrap_or(Value::Null);
            m.keep_free = match &c.fill.keep_free { Some(Size::Bytes(n)) => n.to_string(), Some(Size::Text(s)) => s.clone(), None => String::new() };
            m.max_use = c.fill.max_use;
            m.codecs = c.profile.codecs.clone();
            m.last_sync = c.last_sync;
            m.files = dev.manifest.len();
            m.bytes = dev.manifest.bytes();
            m.players = players::list(volume);
            m.outbox = outbox::read_all(volume).map(|f| f.iter().map(|x| x.events.len()).sum()).unwrap_or(0);
            m.recovered = dev.recovered.as_ref().map(|r| format!("An interrupted sync was cleaned up: {} finished file(s) recorded, {} partial file(s) removed.", r.adopted.len(), r.temps_removed));
        }
    }
    m
}

/// Removable volumes (and any folder already paired that the page remembers), paired or not.
#[tauri::command]
pub async fn devices_list(known: Vec<String>) -> Vec<Medium> {
    tauri::async_runtime::spawn_blocking(move || {
        let extra: Vec<PathBuf> = known.into_iter().map(PathBuf::from).filter(|p| p.is_dir()).collect();
        find_media(&extra).into_iter().map(|(p, _)| describe(&p)).collect()
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
pub fn device_pair(volume: String, name: String, mode: String, root: String, kind: Option<String>) -> Result<Medium, String> {
    let v = PathBuf::from(&volume);
    let mode: Mode = mode.parse()?;
    Device::init(&v, &name, kind.as_deref().unwrap_or("generic"), mode, &root).map_err(|e| e.to_string())?;
    Ok(describe(&v))
}

/// Remove the pairing (`.bootleg/`). The music bootleg put there stays, as ordinary files.
#[tauri::command]
pub fn device_unpair(volume: String) -> Result<(), String> {
    let v = PathBuf::from(&volume);
    if !Device::is_paired(&v) {
        return Err("not paired".into());
    }
    std::fs::remove_dir_all(Device::meta_dir_of(&v)).map_err(|e| e.to_string())
}

/// Change a paired card's settings. Keys: name, mode, root, playlists, stems, keep_free, max_use, codecs, select.
#[tauri::command]
pub fn device_settings(volume: String, patch: serde_json::Map<String, Value>) -> Result<Medium, String> {
    let v = PathBuf::from(&volume);
    let mut dev = Device::open(&v).map_err(|e| e.to_string())?;
    let c = &mut dev.config;
    for (k, val) in patch {
        let s = || val.as_str().map(String::from).ok_or_else(|| format!("{k}: expected text"));
        match k.as_str() {
            "name" => c.name = s()?,
            "mode" => c.mode = s()?.parse()?,
            "root" => c.root = clean_root(&s()?),
            "stems" => c.stems = val.as_bool().unwrap_or(false),
            "playlists" => c.playlists = serde_json::from_value(val).map_err(|e| e.to_string())?,
            "codecs" => c.profile.codecs = serde_json::from_value(val).map_err(|e| e.to_string())?,
            "keep_free" => {
                let t = s()?;
                if t.trim().is_empty() { c.fill.keep_free = None } else {
                    bootleg_sync::config::parse_size(&t)?;
                    c.fill.keep_free = Some(Size::Text(t));
                }
            }
            "max_use" => c.fill.max_use = val.as_u64().map(|n| n.min(100) as u8),
            "select" => {
                let t: toml::Value = serde_json::from_value(val).map_err(|e| e.to_string())?;
                c.extra.insert("select".into(), t);
            }
            _ => return Err(format!("unknown setting {k}")),
        }
    }
    dev.save_config().map_err(|e| e.to_string())?;
    Ok(describe(&v))
}

#[derive(Deserialize)]
pub struct ItemIn {
    /// bootleg track key
    pub track: String,
    /// the file on this computer
    pub path: String,
    /// where it goes under the managed folder, e.g. `Artist/Album/01 Title.flac`
    pub rel: String,
}

#[derive(Deserialize)]
pub struct PlaylistIn {
    pub name: String,
    pub tracks: Vec<String>,
}

#[derive(Serialize)]
pub struct Skipped {
    pub track: String,
    pub why: String,
}

#[derive(Serialize)]
pub struct PlanOut {
    pub id: u64,
    pub copy: usize,
    pub delete: usize,
    pub playlists: usize,
    pub unchanged: usize,
    pub bytes_in: u64,
    pub bytes_freed: u64,
    pub short_by: Option<u64>,
    pub kept_unselected: usize,
    pub free: u64,
    pub skipped: Vec<Skipped>,
    pub renamed: Vec<(String, String)>,
    /// the first operations, for a preview: ["+ path", "- path", "≡ path"]
    pub preview: Vec<String>,
}

fn plans() -> &'static Mutex<HashMap<u64, (PathBuf, Plan)>> {
    static P: OnceLock<Mutex<HashMap<u64, (PathBuf, Plan)>>> = OnceLock::new();
    P.get_or_init(Default::default)
}
static NEXT: AtomicU64 = AtomicU64::new(1);
static CANCEL: AtomicBool = AtomicBool::new(false);

fn why(s: &Skip) -> &'static str {
    match s {
        Skip::NoSpace => "no room",
        Skip::NeedsTranscode => "the player can't play this format (no transcoding yet)",
        Skip::TooBigForFat32 => "over 4 GB, too big for FAT32",
        Skip::NameTaken => "no free file name",
        Skip::EmptyPlaylist => "none of its tracks could go on the device, so the playlist wasn’t written",
    }
}

pub fn items_from(input: Vec<ItemIn>) -> (Vec<Item>, Vec<Skipped>) {
    let (mut items, mut skipped) = (vec![], vec![]);
    for i in input {
        let p = PathBuf::from(&i.path);
        match std::fs::metadata(&p) {
            Ok(m) if m.is_file() => {
                let mtime = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
                let codec = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
                items.push(Item { track: i.track, src: p, rel: i.rel, size: m.len(), src_fp: format!("{}:{mtime}", m.len()), codec, range: None });
            }
            _ => skipped.push(Skipped { track: i.track, why: "file not found on this computer".into() }),
        }
    }
    (items, skipped)
}

/// Work out a sync without changing anything. The plan is kept here and run by `device_apply`.
#[tauri::command]
pub async fn device_plan(volume: String, items: Vec<ItemIn>, playlists: Vec<PlaylistIn>) -> Result<PlanOut, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let v = PathBuf::from(&volume);
        let dev = Device::open(&v).map_err(|e| e.to_string())?;
        let (items, mut skipped) = items_from(items);
        let pls: Vec<PlaylistSpec> = playlists.into_iter().map(|p| PlaylistSpec { name: p.name, tracks: p.tracks }).collect();
        let d = disk::info(&v).map_err(|e| format!("free space: {e}"))?;
        let p = plan(&dev, &items, &pls, &d, &PlanOptions::default()).map_err(|e| e.to_string())?;
        skipped.extend(p.skipped.iter().map(|(t, s)| Skipped { track: t.clone(), why: why(s).into() }));
        let count = |f: fn(&Op) -> bool| p.ops.iter().filter(|o| f(o)).count();
        let preview = p.ops.iter().take(200).map(|o| match o {
            Op::Copy { dest, .. } => format!("+ {dest}"),
            Op::Delete { path, .. } => format!("- {path}"),
            Op::Playlist { dest, .. } => format!("≡ {dest}"),
        }).collect();
        let out = PlanOut {
            id: NEXT.fetch_add(1, Ordering::Relaxed),
            copy: count(|o| matches!(o, Op::Copy { .. })),
            delete: count(|o| matches!(o, Op::Delete { .. })),
            playlists: count(|o| matches!(o, Op::Playlist { .. })),
            unchanged: p.unchanged,
            bytes_in: p.bytes_in,
            bytes_freed: p.bytes_freed,
            short_by: p.short_by,
            kept_unselected: p.kept_unselected,
            free: d.free,
            skipped,
            renamed: p.renamed.clone(),
            preview,
        };
        let mut all = plans().lock().unwrap();
        all.retain(|_, (vol, _)| vol != &v); // one pending plan per card
        all.insert(out.id, (v, p));
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize, Clone)]
pub struct Prog {
    pub done: usize,
    pub total: usize,
    pub what: String,
}

struct Chan(tauri::ipc::Channel<Prog>);
impl Progress for Chan {
    fn step(&mut self, done: usize, total: usize, what: &str) {
        let _ = self.0.send(Prog { done, total, what: what.into() });
    }
    fn cancelled(&self) -> bool {
        CANCEL.load(Ordering::Relaxed)
    }
}

#[derive(Serialize)]
pub struct ApplyOut {
    pub copied: usize,
    pub deleted: usize,
    pub playlists: usize,
    pub bytes: u64,
    pub failed: Vec<(String, String)>,
    pub cancelled: bool,
    /// files that read back wrong from the medium once and were written again
    pub rewritten: usize,
}

#[tauri::command]
pub async fn device_apply(plan_id: u64, on_progress: tauri::ipc::Channel<Prog>) -> Result<ApplyOut, String> {
    let (v, p) = plans().lock().unwrap().remove(&plan_id).ok_or("that sync plan is out of date; check again")?;
    CANCEL.store(false, Ordering::Relaxed);
    tauri::async_runtime::spawn_blocking(move || {
        let mut dev = Device::open(&v).map_err(|e| e.to_string())?;
        let r = apply(&mut dev, &p, &mut Chan(on_progress), None).map_err(|e| e.to_string())?;
        Ok(ApplyOut { copied: r.copied + r.transcoded, deleted: r.deleted, playlists: r.playlists, bytes: r.bytes, failed: r.failed, cancelled: r.cancelled, rewritten: r.rewritten })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn device_cancel() {
    CANCEL.store(true, Ordering::Relaxed);
}

#[derive(Serialize)]
pub struct OutboxOut {
    pub file: String,
    pub events: Vec<outbox::Event>,
}

/// Plays, ratings, notes and tags made on players, waiting on the card.
#[tauri::command]
pub fn device_outbox(volume: String) -> Result<Vec<OutboxOut>, String> {
    let files = outbox::read_all(Path::new(&volume)).map_err(|e| e.to_string())?;
    Ok(files.into_iter().map(|f| OutboxOut { file: f.path.display().to_string(), events: f.events }).collect())
}

/// The page merged these outbox files into its notes: remove them from the card.
#[tauri::command]
pub fn device_outbox_ack(volume: String, files: Vec<String>) -> Result<(), String> {
    let dir = Device::meta_dir_of(Path::new(&volume)).join("outbox");
    for f in files {
        let p = PathBuf::from(&f);
        if p.parent() != Some(dir.as_path()) {
            return Err(format!("not an outbox file: {f}"));
        }
        let _ = std::fs::remove_file(p);
    }
    Ok(())
}

/// Write `.bootleg/notes.json` (bootleg-notes v1 for the tracks on the card), for players that show notes.
#[tauri::command]
pub fn device_write_notes(volume: String, doc: Value) -> Result<(), String> {
    let v = PathBuf::from(&volume);
    if !Device::is_paired(&v) {
        return Err("not paired".into());
    }
    let file = Device::meta_dir_of(&v).join("notes.json");
    let tmp = file.with_extension("json.bootleg-tmp");
    std::fs::write(&tmp, serde_json::to_vec(&doc).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &file).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn items_are_stat_ed_and_missing_ones_reported() {
        let d = std::env::temp_dir().join(format!("bootleg-devices-test-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let f = d.join("a.FLAC");
        std::fs::write(&f, b"1234").unwrap();
        let (items, skipped) = items_from(vec![
            ItemIn { track: "file:a#4".into(), path: f.display().to_string(), rel: "A/a.flac".into() },
            ItemIn { track: "file:b#1".into(), path: d.join("gone.mp3").display().to_string(), rel: "b.mp3".into() },
        ]);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].size, 4);
        assert_eq!(items[0].codec, "flac");
        assert!(items[0].src_fp.starts_with("4:"));
        assert_eq!(skipped.len(), 1);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn pair_plan_apply_round_trip() {
        let d = std::env::temp_dir().join(format!("bootleg-devices-rt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let (vol, lib) = (d.join("vol"), d.join("lib"));
        std::fs::create_dir_all(&vol).unwrap();
        std::fs::create_dir_all(&lib).unwrap();
        std::fs::write(lib.join("x.mp3"), b"mp3!").unwrap();
        let m = device_pair(vol.display().to_string(), "Card".into(), "mirror".into(), "Music/bootleg".into(), None).unwrap();
        assert!(m.paired && m.mode == "mirror");
        let mut patch = serde_json::Map::new();
        patch.insert("select".into(), serde_json::json!({ "min_rating": 4, "starred": true }));
        patch.insert("playlists".into(), serde_json::json!(["Road"]));
        let m = device_settings(vol.display().to_string(), patch).unwrap();
        assert_eq!(m.select["min_rating"], 4);
        assert_eq!(m.playlists, vec!["Road"]);
        let (items, _) = items_from(vec![ItemIn { track: "file:x".into(), path: lib.join("x.mp3").display().to_string(), rel: "A/x.mp3".into() }]);
        let dev = Device::open(&vol).unwrap();
        let p = plan(&dev, &items, &[], &disk::info(&vol).unwrap(), &PlanOptions::default()).unwrap();
        drop(dev);
        let mut dev = Device::open(&vol).unwrap();
        apply(&mut dev, &p, &mut (), None).unwrap();
        assert!(vol.join("Music/bootleg/A/x.mp3").is_file());
        assert_eq!(describe(&vol).files, 1);
        device_unpair(vol.display().to_string()).unwrap();
        assert!(!Device::is_paired(&vol));
        assert!(vol.join("Music/bootleg/A/x.mp3").is_file(), "unpairing leaves the music");
        let _ = std::fs::remove_dir_all(&d);
    }
}
