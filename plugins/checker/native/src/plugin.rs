// The Tauri plugin `bootleg-checker` (plugin spec 2.0 §5.1). JS reaches these through `api.native` as
// `plugin:bootleg-checker|<command>`; a check runs as a Job and sends each file's and album's result as an event.
use crate::{cache::Cache, decode::VERSION, run::{self, Hooks, Request}};
use bootleg_plugin_api::{jobs, JobEvent};
use serde::Serialize;
use std::{sync::{Mutex, OnceLock}, time::Duration};
use tauri::{ipc::Channel, plugin::{Builder, TauriPlugin}, AppHandle, Manager, Runtime};

/// The results cache, loaded on first use. One check at a time (the lock is held for the whole run).
fn cache<R: Runtime>(app: &AppHandle<R>) -> &'static Mutex<Cache> {
    static C: OnceLock<Mutex<Cache>> = OnceLock::new();
    // the self-test keeps it in memory: it never touches the user's real cache
    let file = if std::env::var_os("BOOTLEG_SELFTEST").is_some() { None } else { app.path().app_cache_dir().ok().map(|d| d.join("plugins").join("checker").join("results.json")) };
    C.get_or_init(|| Mutex::new(Cache::load(file)))
}

fn accuraterip(path: &str) -> Option<Option<Vec<u8>>> {
    if std::env::var_os("BOOTLEG_CHECK_OFFLINE").is_some() || std::env::var_os("BOOTLEG_CD_OFFLINE").is_some() { return None; }
    match ureq::get(&format!("http://www.accuraterip.com/accuraterip/{path}")).timeout(Duration::from_secs(15)).call() {
        Ok(r) => { let mut b = vec![]; std::io::Read::read_to_end(&mut r.into_reader(), &mut b).ok()?; Some(Some(b)) }
        Err(ureq::Error::Status(404, _)) => Some(None),
        Err(_) => None,
    }
}

#[tauri::command]
fn check<R: Runtime>(app: AppHandle<R>, request: Request, on_event: Channel<JobEvent>) -> u64 {
    jobs().spawn(on_event, move |ctx| {
        let mut c = cache(&app).try_lock().map_err(|_| "a check is already running".to_string())?;
        let mut emit = |o: run::Out| ctx.event(serde_json::to_value(o).unwrap_or_default());
        let mut progress = |f: f64, s: &str| ctx.progress(f, s); let cancelled = || ctx.cancelled();
        let sum = run::run(&request, &mut c, &mut Hooks { emit: &mut emit, progress: &mut progress, cancelled: &cancelled, fetch: &accuraterip });
        if let Err(e) = c.save() { ctx.log("warn", &format!("could not save the results cache: {e}")); }
        if sum.cancelled { return Err("cancelled".into()); }
        serde_json::to_value(sum).map_err(|e| e.to_string())
    })
}

#[tauri::command]
fn cancel(job: u64) -> bool { jobs().cancel(job) }

/// Forget cached results (all of them with no paths), so the next check reads those files again.
#[tauri::command]
fn forget<R: Runtime>(app: AppHandle<R>, paths: Vec<String>) -> Result<(), String> { let mut c = cache(&app).try_lock().map_err(|_| "a check is running".to_string())?; c.forget(&paths); c.save() }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Info { version: &'static str, checks: u32, spec: &'static str, workers: usize, cached: usize }
#[tauri::command]
fn info<R: Runtime>(app: AppHandle<R>) -> Info { Info { version: env!("CARGO_PKG_VERSION"), checks: VERSION, spec: bootleg_plugin_api::SPEC, workers: run::workers(), cached: cache(&app).try_lock().map(|c| c.map.len()).unwrap_or(0) } }

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("bootleg-checker").invoke_handler(tauri::generate_handler![check, cancel, forget, info]).build()
}
