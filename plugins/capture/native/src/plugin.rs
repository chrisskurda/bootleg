// The Tauri plugin `bootleg-capture` (plugin spec 2.0 §5.1). Recording and saving run as Jobs; `finish` ends a recording
// and keeps it (`cancel` throws it away). Raw recordings live in the app's data folder until saved or discarded.
use crate::{analyze, backend::{self, Backend, DeviceInfo}, record::{self, Hooks}, save::{self, SaveRequest}};
use bootleg_plugin_api::{jobs, JobEvent};
use serde::Serialize;
use std::{collections::HashMap, path::PathBuf, sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex, OnceLock}};
use tauri::{ipc::Channel, plugin::{Builder, TauriPlugin}, AppHandle, Manager, Runtime};

fn backend() -> &'static dyn Backend { static B: OnceLock<Box<dyn Backend>> = OnceLock::new(); B.get_or_init(backend::platform).as_ref() }
fn finishing() -> &'static Mutex<HashMap<u64, Arc<AtomicBool>>> { static M: OnceLock<Mutex<HashMap<u64, Arc<AtomicBool>>>> = OnceLock::new(); M.get_or_init(Default::default) }
fn folder<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let d = if let Ok(t) = std::env::var("BOOTLEG_CAPTURE_DIR") { PathBuf::from(t) } else { app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("plugins").join("capture").join("recordings") };
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?; Ok(d)
}
const PREFIX: &str = "bootleg-recording-";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Info { backend: &'static str, version: &'static str }
#[tauri::command]
fn backend_info() -> Info { Info { backend: backend().name(), version: env!("CARGO_PKG_VERSION") } }

#[tauri::command]
async fn devices() -> Result<Vec<DeviceInfo>, String> { tauri::async_runtime::spawn_blocking(|| backend().devices()).await.map_err(|e| e.to_string())? }

/// Records until `finish`; the result names the WAV in the recordings folder. `name`: a label for the file (e.g. "side-a").
#[tauri::command]
fn record<R: Runtime>(app: AppHandle<R>, device: String, rate: u32, name: String, on_event: Channel<JobEvent>) -> Result<u64, String> {
    let label: String = name.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(40).collect();
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let path = folder(&app)?.join(format!("{PREFIX}{stamp}{}{label}.wav", if label.is_empty() { "" } else { "-" }));
    Ok(jobs().spawn(on_event, move |ctx| {
        let flag = Arc::new(AtomicBool::new(false)); finishing().lock().unwrap().insert(ctx.id, flag.clone());
        let mut levels = |l: &record::Levels| ctx.event(serde_json::to_value(l).unwrap_or_default()); let fin = || flag.load(Ordering::Relaxed); let cancelled = || ctx.cancelled();
        let r = record::record(backend(), &device, rate, &path, &mut Hooks { levels: &mut levels, finish: &fin, cancelled: &cancelled });
        finishing().lock().unwrap().remove(&ctx.id);
        r.and_then(|r| serde_json::to_value(r).map_err(|e| e.to_string()))
    }))
}
#[tauri::command]
fn finish(job: u64) -> bool { finishing().lock().unwrap().get(&job).map(|f| f.store(true, Ordering::Relaxed)).is_some() }
#[tauri::command]
fn cancel(job: u64) -> bool { jobs().cancel(job) }

fn is_recording(p: &std::path::Path) -> bool { p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with(PREFIX) && n.ends_with(".wav")) }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Kept { path: String, bytes: u64, modified: u64, seconds: f64 }
/// Recordings kept from earlier (not yet saved as tracks, or not discarded).
#[tauri::command]
async fn recordings<R: Runtime>(app: AppHandle<R>) -> Result<Vec<Kept>, String> {
    let d = folder(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut v: Vec<Kept> = std::fs::read_dir(&d).map_err(|e| e.to_string())?.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| is_recording(p)).filter_map(|p| {
            let m = std::fs::metadata(&p).ok()?; let r = crate::wav::Reader::open(&p).ok()?;
            Some(Kept { path: p.to_string_lossy().into(), bytes: m.len(), modified: m.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs(), seconds: r.frames as f64 / r.rate as f64 })
        }).collect();
        v.sort_by_key(|k| std::cmp::Reverse(k.modified)); Ok(v)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn analyze(path: String, points: usize) -> Result<analyze::Analysis, String> { tauri::async_runtime::spawn_blocking(move || analyze::analyze(std::path::Path::new(&path), points.clamp(100, 8000))).await.map_err(|e| e.to_string())? }

#[tauri::command]
fn save(request: SaveRequest, on_event: Channel<JobEvent>) -> u64 {
    jobs().spawn(on_event, move |ctx| {
        let mut p = |f: f64, s: &str| ctx.progress(f, s); let c = || ctx.cancelled();
        save::save(&request, &mut p, &c).and_then(|r| serde_json::to_value(r).map_err(|e| e.to_string()))
    })
}

/// Delete a raw recording (only files the recorder made, in its folder).
#[tauri::command]
fn discard<R: Runtime>(app: AppHandle<R>, path: String) -> Result<(), String> {
    let p = PathBuf::from(&path); let d = folder(&app)?;
    if !is_recording(&p) || p.parent().map(|x| x.canonicalize().ok()) != Some(d.canonicalize().ok()) { return Err("not a recording".into()); }
    std::fs::remove_file(&p).map_err(|e| e.to_string())
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("bootleg-capture").invoke_handler(tauri::generate_handler![devices, record, finish, cancel, analyze, save, discard, recordings, backend_info]).build()
}
