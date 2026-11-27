// The offline store: copies of server tracks (and of local files on network shares) kept on this computer, so they play
// without the server or the share, and so device sync can copy them to a card. What to keep is decided in the page
// (src/lib/offline.js: rules, space limit, quality); this side downloads, copies, indexes and deletes.
//
// Layout: <dir>/index.json, <dir>/files/<name>.<ext>, <dir>/tmp/ (downloads for a card sync that keeps nothing),
// <dir>/files/*.part (an interrupted download; resumed with an HTTP range when the server allows it).
// An entry's id is `<source key>|<quality>`: the same track can be kept at two qualities (say, original for the desktop
// and MP3 for a small player).
use bootleg_sync::disk;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager};
use tauri_plugin_http::reqwest;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Entry {
    /// the library source key (`subsonic:<conn>/<id>`, a file path, …)
    pub key: String,
    pub quality: String,
    /// file name under files/
    pub file: String,
    pub size: u64,
    /// lowercase extension
    pub codec: String,
    /// the source's fingerprint when it was fetched (size:changed); a different one means fetch again
    #[serde(default)]
    pub fp: String,
    pub fetched: u64,
    /// last played from here (ms; for "also keep what I play")
    #[serde(default)]
    pub played: u64,
}

#[derive(Serialize, Deserialize, Default)]
struct Index {
    format: u32,
    entries: BTreeMap<String, Entry>,
}

struct Store {
    dir: PathBuf,
    index: Index,
}

static STORE: OnceLock<Mutex<Option<Store>>> = OnceLock::new();
static CANCEL: AtomicBool = AtomicBool::new(false);
fn store() -> &'static Mutex<Option<Store>> {
    STORE.get_or_init(|| Mutex::new(None))
}
fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

impl Store {
    fn open(dir: PathBuf) -> Result<Store, String> {
        for d in [dir.clone(), dir.join("files"), dir.join("tmp")] {
            std::fs::create_dir_all(&d).map_err(|e| format!("{}: {e}", d.display()))?;
        }
        let index = match std::fs::read_to_string(dir.join("index.json")) {
            Ok(t) => serde_json::from_str(&t).map_err(|e| format!("offline index: {e}"))?,
            Err(_) => Index { format: 1, entries: BTreeMap::new() },
        };
        let mut s = Store { dir, index };
        // drop entries whose file is gone (deleted by hand, or a disk that was swapped)
        let gone: Vec<String> = s.index.entries.iter().filter(|(_, e)| !s.dir.join("files").join(&e.file).is_file()).map(|(k, _)| k.clone()).collect();
        if !gone.is_empty() {
            for k in gone {
                s.index.entries.remove(&k);
            }
            s.save()?;
        }
        Ok(s)
    }
    fn save(&self) -> Result<(), String> {
        let tmp = self.dir.join("index.json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(&self.index).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, self.dir.join("index.json")).map_err(|e| e.to_string())
    }
    fn path_of(&self, e: &Entry) -> PathBuf {
        self.dir.join("files").join(&e.file)
    }
    /// a file name for an id: readable start + a hash, so ids with any characters fit any file system
    fn name_for(&self, id: &str, ext: &str) -> String {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        id.hash(&mut h);
        let stem: String = id.rsplit(['/', ':']).next().unwrap_or("track").split('|').next().unwrap_or("track").chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').take(40).collect();
        let ext: String = ext.chars().filter(|c| c.is_ascii_alphanumeric()).take(8).collect::<String>().to_lowercase();
        format!("{}-{:016x}.{}", if stem.is_empty() { "track" } else { &stem }, h.finish(), if ext.is_empty() { "bin" } else { &ext })
    }
    fn info(&self) -> Info {
        let d = disk::info(&self.dir).ok();
        let entries: Vec<EntryOut> = self.index.entries.iter().map(|(id, e)| EntryOut { id: id.clone(), path: self.path_of(e).display().to_string(), e: e.clone() }).collect();
        Info { dir: self.dir.display().to_string(), used: entries.iter().map(|x| x.e.size).sum(), free: d.as_ref().map(|d| d.free), total: d.as_ref().map(|d| d.total), entries }
    }
}

#[derive(Serialize)]
pub struct EntryOut {
    id: String,
    /// absolute path (the page turns it into an asset URL to play)
    path: String,
    #[serde(flatten)]
    e: Entry,
}

#[derive(Serialize)]
pub struct Info {
    dir: String,
    used: u64,
    free: Option<u64>,
    total: Option<u64>,
    entries: Vec<EntryOut>,
}

fn with_store<T>(f: impl FnOnce(&mut Store) -> Result<T, String>) -> Result<T, String> {
    let mut g = store().lock().unwrap();
    let s = g.as_mut().ok_or("the offline store is not open")?;
    f(s)
}

fn default_dir(app: &AppHandle) -> Result<PathBuf, String> {
    // the self-test keeps its store beside its test library, never in the user's
    if let Ok(t) = std::env::var("BOOTLEG_SELFTEST") {
        return Ok(PathBuf::from(t).parent().map(|p| p.join("offline")).unwrap_or_else(|| std::env::temp_dir().join("bootleg-selftest-offline")));
    }
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("offline"))
}

/// Open (or move to) the store at `dir` (default: the app's data folder) and let the page play from it.
#[tauri::command]
pub fn offline_open(app: AppHandle, dir: Option<String>) -> Result<Info, String> {
    let dir = match dir.filter(|d| !d.trim().is_empty()) { Some(d) => PathBuf::from(d), None => default_dir(&app)? };
    let s = Store::open(dir)?;
    app.asset_protocol_scope().allow_directory(s.dir.join("files"), true).map_err(|e| e.to_string())?;
    app.asset_protocol_scope().allow_directory(s.dir.join("tmp"), true).map_err(|e| e.to_string())?;
    let info = s.info();
    *store().lock().unwrap() = Some(s);
    Ok(info)
}

#[tauri::command]
pub fn offline_info() -> Result<Info, String> {
    with_store(|s| Ok(s.info()))
}

#[derive(Deserialize, Clone)]
pub struct Job {
    /// `<key>|<quality>`
    pub id: String,
    pub key: String,
    pub quality: String,
    /// download this… (headers: auth the plugin needs beyond the URL)
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    /// …or copy this local file (a library folder on a network share)
    #[serde(default)]
    pub path: Option<String>,
    /// extension of what arrives (`flac`, `mp3`, …)
    pub ext: String,
    #[serde(default)]
    pub fp: String,
    /// expected size, for progress (0 = unknown)
    #[serde(default)]
    pub size: u64,
}

#[derive(Serialize, Clone)]
pub struct Prog {
    done: usize,
    total: usize,
    bytes: u64,
    /// expected size of the current file (0 = unknown)
    size: u64,
    what: String,
}

#[derive(Serialize)]
pub struct FetchOut {
    id: String,
    path: Option<String>,
    size: u64,
    error: Option<String>,
}

async fn download(job: &Job, url: &str, part: &Path, mut tick: impl FnMut(u64)) -> Result<u64, String> {
    let have = std::fs::metadata(part).map(|m| m.len()).unwrap_or(0);
    let client = reqwest::Client::builder().connect_timeout(std::time::Duration::from_secs(15)).build().map_err(|e| e.to_string())?;
    let mut req = client.get(url);
    for (k, v) in &job.headers {
        req = req.header(k, v);
    }
    if have > 0 {
        req = req.header("Range", format!("bytes={have}-"));
    }
    let mut resp = req.send().await.map_err(|e| format!("could not reach the server ({e})"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("the server answered {status}"));
    }
    // a server that ignores the range sends the whole file again: start over
    let resumed = have > 0 && status.as_u16() == 206;
    let ctype = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    if ctype.contains("json") || ctype.contains("xml") || ctype.starts_with("text/") {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("the server sent a message, not audio: {}", body.chars().take(200).collect::<String>()));
    }
    let mut f = std::fs::OpenOptions::new().create(true).write(true).append(resumed).truncate(!resumed).open(part).map_err(|e| e.to_string())?;
    let mut n = if resumed { have } else { 0 };
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("download interrupted ({e})"))? {
        if CANCEL.load(Ordering::Relaxed) {
            return Err("stopped".into());
        }
        f.write_all(&chunk).map_err(|e| e.to_string())?;
        n += chunk.len() as u64;
        tick(n);
    }
    f.sync_all().map_err(|e| e.to_string())?;
    if n == 0 {
        return Err("the server sent an empty file".into());
    }
    Ok(n)
}

fn copy_local(src: &Path, part: &Path, mut tick: impl FnMut(u64)) -> Result<u64, String> {
    use std::io::Read;
    let mut i = std::fs::File::open(src).map_err(|e| format!("{} is not reachable ({e})", src.display()))?;
    let mut o = std::fs::File::create(part).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; 1 << 20];
    let mut n = 0u64;
    loop {
        if CANCEL.load(Ordering::Relaxed) {
            return Err("stopped".into());
        }
        let k = i.read(&mut buf).map_err(|e| e.to_string())?;
        if k == 0 {
            break;
        }
        o.write_all(&buf[..k]).map_err(|e| e.to_string())?;
        n += k as u64;
        tick(n);
    }
    o.sync_all().map_err(|e| e.to_string())?;
    Ok(n)
}

/// Fetch jobs one after another. `temp`: into tmp/ and not kept (a card sync with "temporary only"). Already-kept
/// entries with the same fingerprint are not fetched again. One failure doesn't stop the rest.
#[tauri::command]
pub async fn offline_fetch(jobs: Vec<Job>, temp: bool, on_progress: tauri::ipc::Channel<Prog>) -> Result<Vec<FetchOut>, String> {
    CANCEL.store(false, Ordering::Relaxed);
    let (dir, names): (PathBuf, Vec<String>) = with_store(|s| Ok((s.dir.clone(), jobs.iter().map(|j| s.name_for(&j.id, &j.ext)).collect())))?;
    let total = jobs.len();
    let mut out = vec![];
    for (i, (job, name)) in jobs.iter().zip(names).enumerate() {
        if CANCEL.load(Ordering::Relaxed) {
            out.push(FetchOut { id: job.id.clone(), path: None, size: 0, error: Some("stopped".into()) });
            continue;
        }
        if !temp {
            let kept = with_store(|s| Ok(s.index.entries.get(&job.id).filter(|e| e.fp == job.fp && s.path_of(e).is_file()).map(|e| (s.path_of(e), e.size))))?;
            if let Some((p, size)) = kept {
                out.push(FetchOut { id: job.id.clone(), path: Some(p.display().to_string()), size, error: None });
                continue;
            }
        }
        let what = job.key.rsplit('/').next().unwrap_or(&job.key).to_string();
        let _ = on_progress.send(Prog { done: i, total, bytes: 0, size: job.size, what: what.clone() });
        let final_path = dir.join(if temp { "tmp" } else { "files" }).join(&name);
        let part = PathBuf::from(format!("{}.part", final_path.display()));
        let mut last = 0u64;
        let tick = |n: u64| {
            if n - last >= 1 << 20 {
                last = n;
                let _ = on_progress.send(Prog { done: i, total, bytes: n, size: job.size, what: what.clone() });
            }
        };
        let res = match (&job.url, &job.path) {
            (Some(u), _) => download(job, u, &part, tick).await,
            (None, Some(p)) => {
                let (p, part2) = (PathBuf::from(p), part.clone());
                tauri::async_runtime::spawn_blocking(move || copy_local(&p, &part2, |_| {})).await.map_err(|e| e.to_string()).and_then(|r| r)
            }
            _ => Err("nothing to fetch from".into()),
        };
        match res.and_then(|size| std::fs::rename(&part, &final_path).map(|_| size).map_err(|e| e.to_string())) {
            Ok(size) => {
                if !temp {
                    with_store(|s| {
                        let played = s.index.entries.get(&job.id).map(|e| e.played).unwrap_or(0);
                        if let Some(old) = s.index.entries.get(&job.id) {
                            if old.file != name {
                                let _ = std::fs::remove_file(s.path_of(old));
                            }
                        }
                        s.index.entries.insert(job.id.clone(), Entry { key: job.key.clone(), quality: job.quality.clone(), file: name.clone(), size, codec: job.ext.to_lowercase(), fp: job.fp.clone(), fetched: now_ms(), played });
                        s.save()
                    })?;
                }
                out.push(FetchOut { id: job.id.clone(), path: Some(final_path.display().to_string()), size, error: None });
            }
            Err(e) => {
                if e != "stopped" && job.url.is_none() {
                    let _ = std::fs::remove_file(&part);
                }
                out.push(FetchOut { id: job.id.clone(), path: None, size: 0, error: Some(e) });
            }
        }
    }
    let _ = on_progress.send(Prog { done: total, total, bytes: 0, size: 0, what: String::new() });
    Ok(out)
}

#[tauri::command]
pub fn offline_cancel() {
    CANCEL.store(true, Ordering::Relaxed);
}

/// Delete kept entries (and their files).
#[tauri::command]
pub fn offline_remove(ids: Vec<String>) -> Result<Info, String> {
    with_store(|s| {
        for id in ids {
            if let Some(e) = s.index.entries.remove(&id) {
                let _ = std::fs::remove_file(s.path_of(&e));
            }
        }
        s.save()?;
        Ok(s.info())
    })
}

/// Note that these entries were just played (for "also keep what I play": oldest-played go first).
#[tauri::command]
pub fn offline_touch(ids: Vec<String>) -> Result<(), String> {
    with_store(|s| {
        let t = now_ms();
        let mut any = false;
        for id in ids {
            if let Some(e) = s.index.entries.get_mut(&id) {
                e.played = t;
                any = true;
            }
        }
        if any { s.save() } else { Ok(()) }
    })
}

/// Empty tmp/ (after a card sync that kept nothing) and drop leftover partial downloads older than a week.
#[tauri::command]
pub fn offline_clear_temp() -> Result<(), String> {
    with_store(|s| {
        if let Ok(rd) = std::fs::read_dir(s.dir.join("tmp")) {
            for e in rd.flatten() {
                let _ = std::fs::remove_file(e.path());
            }
        }
        let week = std::time::Duration::from_secs(7 * 86400);
        if let Ok(rd) = std::fs::read_dir(s.dir.join("files")) {
            for e in rd.flatten() {
                let old = e.metadata().ok().and_then(|m| m.modified().ok()).and_then(|t| t.elapsed().ok()).map(|a| a > week).unwrap_or(false);
                if old && e.path().extension().map(|x| x == "part").unwrap_or(false) {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn index_survives_reopen_and_forgets_missing_files() {
        let tmp = std::env::temp_dir().join(format!("bootleg-offline-test-{}", now_ms()));
        let mut s = Store::open(tmp.clone()).unwrap();
        let name = s.name_for("subsonic:c1/abc|original", "FLAC");
        assert!(name.starts_with("abc-") && name.ends_with(".flac"), "{name}");
        assert_ne!(name, s.name_for("subsonic:c1/abc|high", "flac"));
        std::fs::write(tmp.join("files").join(&name), b"audio").unwrap();
        s.index.entries.insert("subsonic:c1/abc|original".into(), Entry { key: "subsonic:c1/abc".into(), quality: "original".into(), file: name.clone(), size: 5, codec: "flac".into(), fp: "5:1".into(), fetched: 1, played: 0 });
        s.index.entries.insert("subsonic:c1/gone|original".into(), Entry { key: "subsonic:c1/gone".into(), quality: "original".into(), file: "gone.flac".into(), size: 9, codec: "flac".into(), fp: String::new(), fetched: 1, played: 0 });
        s.save().unwrap();
        let s2 = Store::open(tmp.clone()).unwrap();
        assert_eq!(s2.index.entries.len(), 1);
        assert_eq!(s2.info().used, 5);
        let _ = std::fs::remove_dir_all(tmp);
    }

    #[test]
    fn copies_a_local_file() {
        let tmp = std::env::temp_dir().join(format!("bootleg-offline-copy-{}", now_ms()));
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("a.flac"), b"0123456789").unwrap();
        assert_eq!(copy_local(&tmp.join("a.flac"), &tmp.join("b.part"), |_| {}).unwrap(), 10);
        assert_eq!(std::fs::read(tmp.join("b.part")).unwrap(), b"0123456789");
        assert!(copy_local(&tmp.join("nope.flac"), &tmp.join("c.part"), |_| {}).unwrap_err().contains("not reachable"));
        let _ = std::fs::remove_dir_all(tmp);
    }
}
