// bootleg plugin API, Rust side (docs/PLUGIN-SPEC.md §5.3). Both the core and native plugins depend on this crate;
// its major.minor is the spec version it implements.
//   Jobs: long-running work on its own thread, reporting over a Tauri Channel, cancellable from JS by id.
//   (Media, Paths and Tags from §5.3 join here as their first users arrive.)
use serde::Serialize;
use std::{collections::HashMap, sync::{atomic::{AtomicBool, AtomicU64, Ordering}, Arc, Mutex, OnceLock}};
use tauri::ipc::Channel;

pub const SPEC: &str = "2.0";

/// What a job sends to JS: `api.native.job(cmd, args, onEvent)` receives these, and `done` resolves on Done/Error.
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum JobEvent {
    Started { id: u64 },
    Progress { fraction: f64, text: String },
    Log { level: String, line: String },
    Event { data: serde_json::Value },
    Done { result: serde_json::Value },
    Error { message: String, cancelled: bool },
}

pub struct JobCtx { pub id: u64, cancel: Arc<AtomicBool>, channel: Channel<JobEvent> }
impl JobCtx {
    pub fn progress(&self, fraction: f64, text: &str) { let _ = self.channel.send(JobEvent::Progress { fraction: fraction.clamp(0.0, 1.0), text: text.into() }); }
    pub fn log(&self, level: &str, line: &str) { let _ = self.channel.send(JobEvent::Log { level: level.into(), line: line.into() }); }
    pub fn event(&self, data: serde_json::Value) { let _ = self.channel.send(JobEvent::Event { data }); }
    pub fn cancelled(&self) -> bool { self.cancel.load(Ordering::Relaxed) }
}

#[derive(Default)]
pub struct Jobs { running: Mutex<HashMap<u64, Arc<AtomicBool>>>, next: AtomicU64 }
impl Jobs {
    /// Run `work` on its own thread. Its Ok value is sent as Done, its Err as Error (cancelled if the job was cancelled).
    pub fn spawn<F>(&'static self, channel: Channel<JobEvent>, work: F) -> u64
    where F: FnOnce(&JobCtx) -> Result<serde_json::Value, String> + Send + 'static {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1; let cancel = Arc::new(AtomicBool::new(false));
        self.running.lock().unwrap().insert(id, cancel.clone());
        let _ = channel.send(JobEvent::Started { id });
        std::thread::spawn(move || {
            let ctx = JobCtx { id, cancel, channel };
            let out = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| work(&ctx))).unwrap_or_else(|_| Err("the job crashed".into()));
            let _ = ctx.channel.send(match out { Ok(result) => JobEvent::Done { result }, Err(message) => JobEvent::Error { message, cancelled: ctx.cancelled() } });
            self.running.lock().unwrap().remove(&id);
        });
        id
    }
    pub fn cancel(&self, id: u64) -> bool { self.running.lock().unwrap().get(&id).map(|c| c.store(true, Ordering::Relaxed)).is_some() }
}

/// The one job table, shared by the core (`plugin_job_cancel`) and every native plugin.
pub fn jobs() -> &'static Jobs { static J: OnceLock<Jobs> = OnceLock::new(); J.get_or_init(Jobs::default) }
