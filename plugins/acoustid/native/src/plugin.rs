// The Tauri plugin `bootleg-acoustid`: `fingerprint` runs as a Job and sends each file's print as an event.
use bootleg_plugin_api::{jobs, JobEvent};
use std::path::Path;
use tauri::{ipc::Channel, plugin::{Builder, TauriPlugin}, Runtime};

#[tauri::command]
fn fingerprint(paths: Vec<String>, on_event: Channel<JobEvent>) -> u64 {
    jobs().spawn(on_event, move |ctx| {
        let n = paths.len().max(1); let mut ok = 0;
        for (i, p) in paths.iter().enumerate() {
            if ctx.cancelled() { return Err("cancelled".into()); }
            ctx.progress(i as f64 / n as f64, &format!("Listening to {} of {}", i + 1, n));
            match crate::fingerprint_file(Path::new(p)) {
                Ok(fp) => { ok += 1; ctx.event(serde_json::json!({ "path": p, "duration": fp.duration, "fingerprint": fp.fingerprint })); }
                Err(e) => ctx.event(serde_json::json!({ "path": p, "error": e })),
            }
        }
        Ok(serde_json::json!({ "files": paths.len(), "fingerprinted": ok }))
    })
}

#[tauri::command]
fn cancel(job: u64) -> bool { jobs().cancel(job) }

pub fn init<R: Runtime>() -> TauriPlugin<R> { Builder::new("bootleg-acoustid").invoke_handler(tauri::generate_handler![fingerprint, cancel]).build() }
