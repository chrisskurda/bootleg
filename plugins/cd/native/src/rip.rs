// A whole rip: secure read → fill and flag damage → AccurateRip → encode + verify → tags → cue, log, playlist.
use crate::{accuraterip as ar, backend::{Drive, DriveInfo}, output::{self, Format, Meta}, salvage::{self, Defect, FillPolicy}, secure::{self, Hooks, ReadError, SecureSettings, SectorState}, toc::{self, Toc, SAMPLES_PER_SECTOR}};
use serde::{Deserialize, Serialize};
use std::{fmt::Write as _, path::{Path, PathBuf}};

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct RipRequest {
    pub tracks: Vec<u8>,                 // empty = every audio track
    pub dest: String,                    // the library folder the rip goes into
    pub template: String,                // empty = output::DEFAULT_TEMPLATE
    pub format: Format,
    pub meta: Meta,
    pub secure: SecureSettings,
    pub fill: FillPolicy,
    #[serde(skip)] pub accuraterip: Option<Vec<ar::Response>>, // fetched by the caller (None = lookup failed / offline)
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Status { Verified, Secure, Suspect, Damaged }

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackOutcome {
    pub number: u8, pub path: String, pub status: Status, pub crc32: String, pub accuraterip: ar::TrackResult, pub isrc: Option<String>,
    pub sectors: usize, pub uncertain: usize, pub unreadable: usize, pub max_reads: u16, pub defects: Vec<Defect>, pub damage: Vec<secure::Damage>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RipResult { pub folder: String, pub tracks: Vec<TrackOutcome>, pub log: String, pub cue: String, pub playlist: String, pub summary: String, pub provenance: String, pub musicbrainz_disc_id: String, pub accuraterip_found: bool }

pub fn rip(drive: &mut dyn Drive, req: &RipRequest, h: &mut Hooks) -> Result<RipResult, ReadError> {
    let toc = drive.toc().map_err(ReadError::Drive)?; let info = drive.info(); let caps = drive.capabilities();
    let mut wanted: Vec<u8> = toc.audio_tracks().map(|t| t.number).filter(|n| req.tracks.is_empty() || req.tracks.contains(n)).collect(); wanted.sort();
    let template = if req.template.trim().is_empty() { output::DEFAULT_TEMPLATE } else { req.template.as_str() };
    let audio_n = toc.audio_count() as u32; let last_audio = toc.audio_tracks().last().map(|t| t.number).unwrap_or(1); let first_audio = toc.audio_tracks().next().map(|t| t.number).unwrap_or(1);
    let total_sectors: f64 = wanted.iter().map(|n| toc.track_sectors(*n) as f64).sum::<f64>().max(1.0); let mut done_sectors = 0.0;
    let mb = toc.musicbrainz_id(); let mcn = drive.mcn();
    let mut outcomes = vec![];
    let root = PathBuf::from(&req.dest);
    for &n in &wanted {
        let t = toc.track(n).unwrap().clone(); let end = toc.track_end(n); let sectors = (end - t.start + 1) as f64;
        let tm = req.meta.track(n);
        (h.log)(&format!("track {n}: sectors {}–{end}", t.start));
        // the offset may pull samples from the neighbouring sector on either side
        let pad = (req.secure.offset.abs() as usize).div_ceil(SAMPLES_PER_SECTOR) as i32;
        let map = {
            let base = done_sectors; let prog = &mut *h.progress;
            let mut p = |f: f64, s: &str| prog((base + f * sectors) / total_sectors, &format!("Track {n}: {s}"));
            let mut hk = Hooks { progress: &mut p, cancelled: h.cancelled, log: &mut *h.log };
            secure::read_range(drive, t.start - pad, end + pad, toc.audio_leadout(), &req.secure, &mut hk)?
        };
        done_sectors += sectors;
        let (mut pcm, damage) = secure::assemble(&map, t.start, end, req.secure.offset);
        // AccurateRip over the audio as read (before any filling: a filled track can't match anyway)
        let frames = ar::frames_from_pcm(&pcm); let (v1, v2) = ar::checksums(&frames, n == first_audio, n == last_audio);
        let idx = toc.audio_tracks().position(|x| x.number == n).unwrap_or(0);
        let arr = ar::verify(idx, v1, v2, req.accuraterip.as_deref().unwrap_or(&[]));
        let defects = salvage::apply(&mut pcm, &damage, &req.fill);
        let uncertain = damage.iter().filter(|d| d.kind == SectorState::Uncertain).map(|d| d.sectors).sum(); let unreadable = damage.iter().filter(|d| d.kind == SectorState::Unreadable).map(|d| d.sectors).sum();
        let status = if arr.matched.is_some() { Status::Verified } else if !damage.is_empty() { Status::Damaged } else if arr.total > 0 { Status::Suspect } else { Status::Secure };
        let isrc = drive.isrc(n).filter(|s| !s.trim_matches('0').is_empty());
        let ar_text = match (arr.matched, arr.total) { (Some(v), _) => format!("AccurateRip {v}: accurate (confidence {} of {})", arr.confidence, arr.total), (None, 0) if req.accuraterip.is_none() => "AccurateRip: not checked (offline)".into(), (None, 0) => "AccurateRip: not in database".into(), (None, t) => format!("AccurateRip: no match ({t} submissions)") };
        let rel = output::render(template, &req.meta, &tm).with_extension(req.format.ext()); let dest = root.join(&rel);
        output::write_track(&dest, req.format, &pcm, &req.meta, &tm, &output::Extra { isrc: isrc.clone(), ar: ar_text, tracks: audio_n, mb_disc_id: mb.clone() }).map_err(|e| ReadError::Drive(crate::backend::Error::Io(e)))?;
        let max_reads = map.reads.iter().copied().max().unwrap_or(0);
        outcomes.push(TrackOutcome { number: n, path: dest.display().to_string(), status, crc32: format!("{:08X}", crc32fast::hash(&pcm)), accuraterip: arr, isrc, sectors: sectors as usize, uncertain, unreadable, max_reads, defects, damage });
        (h.progress)(done_sectors / total_sectors, &format!("Track {n}: {}", match status { Status::Verified => "accurate", Status::Secure => "copied securely", Status::Suspect => "no AccurateRip match", Status::Damaged => "damaged" }));
    }
    let folder = outcomes.first().map(|o| PathBuf::from(&o.path).parent().unwrap().to_path_buf()).unwrap_or(root.clone());
    let base = output::safe(&format!("{} - {}", if req.meta.album_artist.is_empty() { "Unknown Artist" } else { &req.meta.album_artist }, if req.meta.album.is_empty() { "Unknown Album" } else { &req.meta.album }));
    let cue = folder.join(format!("{base}.cue")); let m3u = folder.join(format!("{base}.m3u8")); let log = folder.join(format!("{base}.log"));
    let _ = std::fs::write(&cue, cue_sheet(&toc, &req.meta, &outcomes, mcn.as_deref(), &mb));
    let _ = std::fs::write(&m3u, playlist(&req.meta, &outcomes, &folder));
    if !req.meta.cover_jpeg_base64.is_empty() { use base64::Engine; if let Ok(b) = base64::engine::general_purpose::STANDARD.decode(&req.meta.cover_jpeg_base64) { let _ = std::fs::write(folder.join("cover.jpg"), b); } }
    let summary = summary(&outcomes);
    let found = req.accuraterip.as_ref().is_some_and(|r| !r.is_empty());
    let provenance = format!("CD rip, {}, {} {}, read offset {:+}; {}", today(), info.vendor, info.model, req.secure.offset, summary);
    let _ = std::fs::write(&log, log_text(&info, &caps, &toc, req, &outcomes, &mb, &summary, found, req.accuraterip.is_some()));
    let _ = std::fs::write(log.with_extension("log.json"), serde_json::to_string_pretty(&serde_json::json!({ "app": "bootleg CD", "drive": info, "toc": toc, "musicbrainzDiscId": mb, "accurateripPath": toc.accuraterip_path(), "settings": req.secure, "fill": req.fill, "tracks": outcomes })).unwrap_or_default());
    Ok(RipResult { folder: folder.display().to_string(), tracks: outcomes, log: log.display().to_string(), cue: cue.display().to_string(), playlist: m3u.display().to_string(), summary, provenance, musicbrainz_disc_id: mb, accuraterip_found: found })
}

pub fn summary(o: &[TrackOutcome]) -> String {
    let c = |s: Status| o.iter().filter(|t| t.status == s).count();
    let (v, s, q, d) = (c(Status::Verified), c(Status::Secure), c(Status::Suspect), c(Status::Damaged));
    if v == o.len() { return "AccurateRip verified".into(); }
    let mut parts = vec![]; if v > 0 { parts.push(format!("{v} verified")); } if s > 0 { parts.push(format!("{s} secure, not in AccurateRip")); } if q > 0 { parts.push(format!("{q} not matching AccurateRip")); } if d > 0 { parts.push(format!("damaged: {d} of {} tracks not verified", o.len())); }
    parts.join(", ")
}

fn today() -> String {
    let d = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64 / 86_400).unwrap_or(0);
    // civil-from-days (Howard Hinnant)
    let z = d + 719_468; let era = z.div_euclid(146_097); let doe = z - era * 146_097; let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); let mp = (5 * doy + 2) / 153; let day = doy - (153 * mp + 2) / 5 + 1; let m = if mp < 10 { mp + 3 } else { mp - 9 };
    format!("{:04}-{m:02}-{day:02}", yoe + era * 400 + i64::from(m <= 2))
}

fn cue_sheet(toc: &Toc, m: &Meta, o: &[TrackOutcome], mcn: Option<&str>, mb: &str) -> String {
    let q = |s: &str| s.replace('"', "'");
    let mut c = format!("REM DISCID {:08X}\nREM MUSICBRAINZ_DISCID {mb}\nREM COMMENT \"bootleg CD\"\n", toc.cddb_id());
    if !m.date.is_empty() { let _ = writeln!(c, "REM DATE {}", &m.date[..m.date.len().min(4)]); }
    if !m.genre.is_empty() { let _ = writeln!(c, "REM GENRE \"{}\"", q(&m.genre)); }
    if let Some(mcn) = mcn { let _ = writeln!(c, "CATALOG {mcn}"); }
    let _ = writeln!(c, "PERFORMER \"{}\"\nTITLE \"{}\"", q(&m.album_artist), q(&m.album));
    for t in o {
        let tm = m.track(t.number); let file = Path::new(&t.path).file_name().unwrap().to_string_lossy().to_string();
        let kind = if t.path.ends_with(".wav") { "WAVE" } else if t.path.ends_with(".aiff") { "AIFF" } else { "WAVE" };
        let _ = writeln!(c, "FILE \"{}\" {kind}\n  TRACK {:02} AUDIO\n    TITLE \"{}\"\n    PERFORMER \"{}\"", q(&file), t.number, q(&tm.title), q(&tm.artist));
        if let Some(i) = &t.isrc { let _ = writeln!(c, "    ISRC {i}"); }
        if toc.track(t.number).is_some_and(|x| x.preemphasis) { let _ = writeln!(c, "    FLAGS PRE"); }
        let _ = writeln!(c, "    INDEX 01 00:00:00");
    }
    c
}

fn playlist(m: &Meta, o: &[TrackOutcome], folder: &Path) -> String {
    let mut s = String::from("#EXTM3U\n");
    for t in o {
        let tm = m.track(t.number); let secs = t.sectors * SAMPLES_PER_SECTOR / 44_100;
        let rel = Path::new(&t.path).strip_prefix(folder).map(|p| p.display().to_string()).unwrap_or(t.path.clone());
        let _ = writeln!(s, "#EXTINF:{secs},{} - {}\n{rel}", tm.artist, tm.title);
    }
    s
}

#[allow(clippy::too_many_arguments)]
fn log_text(info: &DriveInfo, caps: &crate::backend::Capabilities, toc: &Toc, req: &RipRequest, o: &[TrackOutcome], mb: &str, summary: &str, found: bool, looked_up: bool) -> String {
    let s = &req.secure; let mut l = String::new();
    let _ = writeln!(l, "bootleg CD {} — extraction log\n{}\n", env!("CARGO_PKG_VERSION"), today());
    let _ = writeln!(l, "{} / {}\n", if req.meta.album_artist.is_empty() { "Unknown Artist" } else { &req.meta.album_artist }, if req.meta.album.is_empty() { "Unknown Album" } else { &req.meta.album });
    let _ = writeln!(l, "Drive               : {} {} ({}) [{}]", info.vendor, info.model, info.revision, info.path);
    let _ = writeln!(l, "Read offset         : {:+} samples", s.offset);
    let _ = writeln!(l, "Read mode           : secure, {} passes, {} matching reads, up to {} re-read rounds", s.min_passes, s.confirm, s.max_rounds);
    let _ = writeln!(l, "Cache defeat        : {}", if s.cache_defeat > 0 { format!("{} sectors", s.cache_defeat) } else { "off".into() });
    let _ = writeln!(l, "C2 pointers         : {}", if s.use_c2 && caps.c2 { "used" } else if caps.c2 { "available, not used" } else { "not available" });
    let _ = writeln!(l, "Overread lead-in/out: {}/{}", if caps.overread_leadin { "yes" } else { "no" }, if caps.overread_leadout { "yes" } else { "no" });
    let _ = writeln!(l, "Gap handling        : appended to previous track");
    let _ = writeln!(l, "Damaged audio       : uncertain {:?}, unreadable ≤{} ms {:?}, longer {:?}\n", req.fill.uncertain, req.fill.short_ms, req.fill.unreadable_short, req.fill.unreadable_long);
    let _ = writeln!(l, "TOC\n     Track |   Start  |  Length  | Start sector | End sector");
    for t in &toc.tracks { let e = toc.track_end(t.number); let _ = writeln!(l, "     {:>5} | {} | {} | {:>12} | {:>10}{}", t.number, toc::fmt_frames(t.start), toc::fmt_frames(e - t.start + 1), t.start, e, if t.audio { "" } else { "  (data)" }); }
    let _ = writeln!(l, "\nMusicBrainz disc id : {mb}\nAccurateRip         : {} ({})\n", toc.accuraterip_path(), if found { "found" } else if looked_up { "not in database" } else { "not checked (offline)" });
    for t in o {
        let _ = writeln!(l, "Track {:2}\n     Filename      {}", t.number, t.path);
        let _ = writeln!(l, "     Copy CRC      {}\n     AccurateRip   v1 {:08X}  v2 {:08X}  {}", t.crc32, t.accuraterip.v1, t.accuraterip.v2, match t.accuraterip.matched { Some(v) => format!("accurate ({v}, confidence {})", t.accuraterip.confidence), None if t.accuraterip.total > 0 => "NO MATCH".into(), None if !looked_up => "not checked".into(), None => "not in database".into() });
        if let Some(i) = &t.isrc { let _ = writeln!(l, "     ISRC          {i}"); }
        let _ = writeln!(l, "     Sectors       {} (most reads of one sector: {})", t.sectors, t.max_reads);
        for d in &t.defects { let _ = writeln!(l, "     Damage        {}–{}  {}  ({})", fmt_time(d.start), fmt_time(d.end), d.kind, d.detail); }
        let _ = writeln!(l, "     Status        {:?}\n", t.status);
    }
    let _ = writeln!(l, "Result: {summary}"); l
}
fn fmt_time(s: f64) -> String { format!("{}:{:06.3}", (s / 60.0) as u32, s % 60.0) }

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::sim::*;
    fn run(cfg: SimConfig, disc: SimDisc, ar: Option<Vec<ar::Response>>, secure: SecureSettings) -> (RipResult, SimDisc, PathBuf) {
        let dir = std::env::temp_dir().join(format!("bootleg-cd-rip-{}-{}", std::process::id(), rand_tag())); let truth = disc.clone();
        let mut d = SimDrive::new("sim:t", disc, cfg);
        let req = RipRequest { dest: dir.display().to_string(), meta: Meta { album: "Test Album".into(), album_artist: "Test Artist".into(), ..Default::default() }, secure, accuraterip: ar, ..Default::default() };
        let (mut p, c, mut l) = (|_: f64, _: &str| {}, || false, |_: &str| {}); let mut h = Hooks { progress: &mut p, cancelled: &c, log: &mut l };
        (rip(&mut d, &req, &mut h).unwrap(), truth, dir)
    }
    fn rand_tag() -> u64 { use std::hash::{BuildHasher, Hasher}; std::collections::hash_map::RandomState::new().build_hasher().finish() }
    /// The AccurateRip entry a perfect rip of `disc` would produce, as if submitted by others.
    fn ar_for(disc: &SimDisc) -> Vec<ar::Response> {
        let n = disc.toc.tracks.len();
        vec![ar::Response { tracks: disc.toc.tracks.iter().enumerate().map(|(i, t)| {
            let (a, b) = (t.start as usize * 588 * 4, (disc.toc.track_end(t.number) as usize + 1) * 588 * 4);
            let (_, v2) = ar::checksums(&ar::frames_from_pcm(&disc.pcm[a..b]), i == 0, i == n - 1); ar::Entry { confidence: 12, crc: v2, crc450: 0 } }).collect() }]
    }
    #[test] fn clean_disc_is_verified_and_files_are_exact() {
        let disc = SimDisc::synthetic(&[120, 90, 150], 21); let ar = ar_for(&disc);
        let (r, truth, dir) = run(SimConfig { offset: 48, cache_sectors: 40, ..Default::default() }, disc, Some(ar), SecureSettings { offset: 48, cache_defeat: 60, ..Default::default() });
        assert_eq!(r.tracks.iter().map(|t| t.status).collect::<Vec<_>>(), [Status::Verified; 3], "{}", r.summary);
        assert_eq!(r.summary, "AccurateRip verified");
        // the middle track's FLAC decodes to exactly the disc's audio
        let mut fr = claxon::FlacReader::open(&r.tracks[1].path).unwrap(); let got: Vec<i32> = fr.samples().map(|s| s.unwrap()).collect();
        assert_eq!(got, output::i32_samples(&truth.pcm[120 * 2352..210 * 2352]));
        for f in [&r.cue, &r.playlist, &r.log] { assert!(Path::new(f).exists(), "{f}"); }
        assert!(std::fs::read_to_string(&r.log).unwrap().contains("accurate (v2, confidence 12)"));
        std::fs::remove_dir_all(dir).ok();
    }
    #[test] fn wrong_offset_fails_accuraterip() {
        let disc = SimDisc::synthetic(&[100, 100], 8); let ar = ar_for(&disc);
        let (r, _, dir) = run(SimConfig { offset: 30, ..Default::default() }, disc, Some(ar), SecureSettings { offset: 0, cache_defeat: 0, ..Default::default() });
        assert!(r.tracks.iter().all(|t| t.status == Status::Suspect)); std::fs::remove_dir_all(dir).ok();
    }
    #[test] fn damaged_disc_is_salvaged_with_defects() {
        let disc = SimDisc::synthetic(&[100, 100], 9); let ar = ar_for(&disc);
        let cfg = SimConfig { seed: 5, faults: vec![Fault { from: 140, to: 149, kind: FaultKind::Dead, p: 1.0, max_kbps: 0 }, Fault { from: 20, to: 22, kind: FaultKind::Flaky, p: 0.5, max_kbps: 0 }], ..Default::default() };
        let (r, _, dir) = run(cfg, disc, Some(ar), SecureSettings { cache_defeat: 0, max_rounds: 30, ..Default::default() });
        assert_eq!(r.tracks[0].status, Status::Verified, "flaky sectors re-read to a verified copy");
        let t2 = &r.tracks[1]; assert_eq!(t2.status, Status::Damaged); assert_eq!(t2.unreadable, 10);
        assert_eq!(t2.defects.len(), 1); assert_eq!(t2.defects[0].kind, "unreadable"); assert!((t2.defects[0].start - 40.0 * 588.0 / 44_100.0).abs() < 1e-6);
        assert!(r.summary.contains("damaged: 1 of 2"), "{}", r.summary); assert!(Path::new(&t2.path).exists(), "a damaged track is still written");
        std::fs::remove_dir_all(dir).ok();
    }
    #[test] fn not_in_database_is_secure() {
        let disc = SimDisc::synthetic(&[60], 2); let (r, _, dir) = run(SimConfig::default(), disc, Some(vec![]), SecureSettings { cache_defeat: 0, ..Default::default() });
        assert_eq!(r.tracks[0].status, Status::Secure); std::fs::remove_dir_all(dir).ok();
    }
}
