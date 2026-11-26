// The Tauri plugin `bootleg-cd` (plugin spec 2.0 §5.1). JS reaches these through `api.native` as
// `plugin:bootleg-cd|<command>`; long work runs as a Job (bootleg-plugin-api) and reports over a Channel.
use crate::{accuraterip as ar, backend::{self, Backend, DriveInfo, ReadOpts}, rip::{self, RipRequest}, secure::{Hooks, ReadError}, toc::{lba_to_msf, Toc}};
use bootleg_plugin_api::{jobs, JobEvent};
use serde::Serialize;
use std::{sync::{Mutex, OnceLock}, time::Duration};
use tauri::{ipc::Channel, plugin::{Builder, TauriPlugin}, Runtime};

fn backend() -> &'static dyn Backend { static B: OnceLock<Box<dyn Backend>> = OnceLock::new(); B.get_or_init(backend::platform).as_ref() }
/// One rip at a time per app: drives are shared hardware, and two readers on one drive would thrash it.
fn busy() -> &'static Mutex<()> { static M: OnceLock<Mutex<()>> = OnceLock::new(); M.get_or_init(|| Mutex::new(())) }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BackendInfo { backend: &'static str, spec: &'static str, os: &'static str, version: &'static str }
#[tauri::command]
fn backend_info() -> BackendInfo { BackendInfo { backend: backend().name(), spec: bootleg_plugin_api::SPEC, os: std::env::consts::OS, version: env!("CARGO_PKG_VERSION") } }

#[tauri::command]
async fn drives() -> Result<Vec<DriveInfo>, String> { tauri::async_runtime::spawn_blocking(|| backend().drives().map_err(|e| e.to_string())).await.map_err(|e| e.to_string())? }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Disc { drive: DriveInfo, toc: Toc, musicbrainz_id: String, musicbrainz_toc: String, cddb_id: String, accuraterip_path: String, capabilities: backend::Capabilities, mcn: Option<String>, seconds: Vec<f64> }
#[tauri::command]
async fn disc(drive: String) -> Result<Disc, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut d = backend().open(&drive).map_err(|e| e.to_string())?; let toc = d.toc().map_err(|e| e.to_string())?;
        let seconds = toc.tracks.iter().map(|t| toc.track_sectors(t.number) as f64 / 75.0).collect();
        Ok(Disc { drive: d.info(), musicbrainz_id: toc.musicbrainz_id(), musicbrainz_toc: toc.musicbrainz_toc(), cddb_id: format!("{:08x}", toc.cddb_id()), accuraterip_path: toc.accuraterip_path(), capabilities: d.capabilities(), mcn: d.mcn(), seconds, toc })
    }).await.map_err(|e| e.to_string())?
}

/// The AccurateRip entry for a disc: Some(responses) (empty = not in the database), None = could not ask (offline).
fn accuraterip(toc: &Toc) -> Option<Vec<ar::Response>> {
    if std::env::var_os("BOOTLEG_CD_OFFLINE").is_some() { return None; }   // tests and the self-test never touch the network
    let url = format!("http://www.accuraterip.com/accuraterip/{}", toc.accuraterip_path());
    match ureq::get(&url).timeout(Duration::from_secs(15)).call() {
        Ok(r) => { let mut b = vec![]; std::io::Read::read_to_end(&mut r.into_reader(), &mut b).ok()?; let (i1, i2) = toc.accuraterip_ids(); Some(ar::parse(&b, (i1, i2, toc.cddb_id()))) }
        Err(ureq::Error::Status(404, _)) => Some(vec![]),
        Err(_) => None,
    }
}

#[tauri::command]
fn rip(drive: String, request: RipRequest, on_event: Channel<JobEvent>) -> u64 {
    jobs().spawn(on_event, move |ctx| {
        let _guard = busy().try_lock().map_err(|_| "another rip is running".to_string())?;
        let mut d = backend().open(&drive).map_err(|e| e.to_string())?;
        let toc = d.toc().map_err(|e| e.to_string())?;
        ctx.progress(0.0, "Looking the disc up in AccurateRip…");
        let mut req = request; req.accuraterip = accuraterip(&toc);
        ctx.log("info", &match &req.accuraterip { Some(r) if !r.is_empty() => format!("AccurateRip: {} submission groups", r.len()), Some(_) => "AccurateRip: this disc is not in the database".into(), None => "AccurateRip: could not be reached; ripping without verification".into() });
        let mut progress = |f: f64, s: &str| ctx.progress(f, s); let cancelled = || ctx.cancelled(); let mut log = |s: &str| ctx.log("info", s);
        let mut h = Hooks { progress: &mut progress, cancelled: &cancelled, log: &mut log };
        match rip::rip(d.as_mut(), &req, &mut h) {
            Ok(r) => serde_json::to_value(r).map_err(|e| e.to_string()),
            Err(ReadError::Cancelled) => Err("cancelled".into()),
            Err(ReadError::Drive(e)) => Err(e.to_string()),
        }
    })
}

#[tauri::command]
fn cancel(job: u64) -> bool { jobs().cancel(job) }

/// The hardware spike (CD.md milestone 1): what this drive really does on this OS, with the disc mounted.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct Probe { drive: Option<DriveInfo>, backend: &'static str, toc: Option<String>, musicbrainz_id: Option<String>, capabilities: Option<backend::Capabilities>, steps: Vec<(String, bool, String)> }
#[tauri::command]
async fn probe(drive: String) -> Probe {
    tauri::async_runtime::spawn_blocking(move || {
        let mut p = Probe { backend: backend().name(), ..Default::default() };
        let step = |p: &mut Probe, name: &str, ok: bool, detail: String| p.steps.push((name.into(), ok, detail));
        let mut d = match backend().open(&drive) { Ok(d) => { step(&mut p, "open the drive", true, String::new()); d } Err(e) => { step(&mut p, "open the drive", false, e.to_string()); return p; } };
        p.drive = Some(d.info());
        let toc = match d.toc() { Ok(t) => t, Err(e) => { step(&mut p, "read the TOC", false, e.to_string()); return p; } };
        step(&mut p, "read the TOC", true, format!("{} tracks, lead-out at {}", toc.tracks.len(), toc.leadout));
        p.toc = Some(toc.musicbrainz_toc()); p.musicbrainz_id = Some(toc.musicbrainz_id());
        let caps = d.capabilities(); p.capabilities = Some(caps.clone());
        let lba = (toc.audio_leadout() / 2).max(0);
        let plain = d.read(lba, 4, ReadOpts::default());
        step(&mut p, "read audio sectors", plain.is_ok(), plain.as_ref().err().map(|e| e.to_string()).unwrap_or_default());
        let Ok(plain) = plain else { return p };
        let full = d.read(lba, 4, ReadOpts { c2: caps.c2, subq: caps.subchannel_q });
        match &full {
            Ok(f) => {
                step(&mut p, "audio + C2 + Q read in one command", true, format!("C2 {}, Q {}", caps.c2, caps.subchannel_q));
                step(&mut p, "same audio with and without the extra areas (offset units are right)", f.audio == plain.audio, String::new());
                if let Some(q) = &f.subq {
                    let bcd = |b: u8| (b >> 4) as i32 * 10 + (b & 15) as i32; let (m, s, fr) = lba_to_msf(lba);
                    let got = (bcd(q[7]), bcd(q[8]), bcd(q[9])); let crc_ok = { let c = !crate::backend::sim::crc16(&q[..10]); q[10..12] == c.to_be_bytes() };
                    step(&mut p, "Q subchannel points at the sector that was read", got == (m, s, fr) && crc_ok, format!("asked {m:02}:{s:02}:{fr:02}, Q says {:02}:{:02}:{:02}, CRC {}", got.0, got.1, got.2, if crc_ok { "ok" } else { "bad" }));
                }
                if let Some(c2) = &f.c2 { step(&mut p, "C2 error bits on a clean read", true, format!("{} bits set", c2.iter().map(|b| b.count_ones()).sum::<u32>())); }
            }
            Err(e) => step(&mut p, "audio + C2 + Q read in one command", false, e.to_string()),
        }
        let again = d.read(lba, 4, ReadOpts::default()); step(&mut p, "repeat read gives the same audio", again.as_ref().is_ok_and(|a| a.audio == plain.audio), String::new());
        let speed = d.set_speed(Some(706)).and_then(|_| d.set_speed(None)); step(&mut p, "set read speed", speed.is_ok(), speed.err().map(|e| e.to_string()).unwrap_or_default());
        let isrc = toc.audio_tracks().next().and_then(|t| d.isrc(t.number)); step(&mut p, "ISRC of the first track", true, isrc.unwrap_or("none on this disc".into()));
        step(&mut p, "MCN / barcode", true, d.mcn().unwrap_or("none on this disc".into()));
        p
    }).await.unwrap_or_default()
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("bootleg-cd").invoke_handler(tauri::generate_handler![drives, disc, rip, cancel, backend_info, probe]).build()
}
