//! bootleg-sync: pair and sync SD cards / USB players from the command line (device format 1).
//! The desktop sync view and bootleg-pod use the same library; this is for trying it on real cards now.
use bootleg_sync::apply::{apply, Progress};
use bootleg_sync::config::{parse_size, Mode, Size};
use bootleg_sync::plan::{plan, Item, Op, PlanOptions, PlaylistSpec};
use bootleg_sync::{disk, find_media, outbox, players, Device};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::exit;

const AUDIO: [&str; 10] = ["flac", "mp3", "ogg", "opus", "m4a", "aac", "wav", "aiff", "aif", "wv"];

const HELP: &str = "bootleg-sync — bootleg device format 1

  bootleg-sync list                                   removable volumes, and which are paired
  bootleg-sync init <volume> [--name N] [--kind generic|rockbox|pod] [--mode add|mirror|fill] [--root Music/bootleg]
  bootleg-sync status <volume>
  bootleg-sync set <volume> key=value ...             mode, root, name, keep_free (e.g. 2GB), max_use (%),
                                                      codecs (mp3,flac,…), transcode_to, playlist (m3u8|m3u), path_sep, ascii
  bootleg-sync push <volume> <playlist.m3u8 | folder | file>... [--library DIR] [--dry-run]
  bootleg-sync verify <volume>
  bootleg-sync outbox <volume> [--ack]
  bootleg-sync player <volume> --id ID [--name N] [--model M]

Only files bootleg wrote (listed in <volume>/.bootleg/manifest.jsonl) are ever replaced or deleted.
This CLI does not transcode: tracks the player can't play are reported and skipped.";

fn die(msg: impl std::fmt::Display) -> ! {
    eprintln!("bootleg-sync: {msg}");
    exit(1)
}

fn flag(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

fn human(n: u64) -> String {
    let f = n as f64;
    if f >= 1e9 { format!("{:.2} GB", f / 1e9) } else if f >= 1e6 { format!("{:.1} MB", f / 1e6) } else if f >= 1e3 { format!("{:.0} KB", f / 1e3) } else { format!("{n} B") }
}

fn open(vol: &str) -> Device {
    let d = Device::open(Path::new(vol)).unwrap_or_else(|e| die(e));
    if let Some(r) = &d.recovered {
        eprintln!("recovered an interrupted sync: {} finished file(s) recorded, {} temporary file(s) removed, {} delete(s) recorded", r.adopted.len(), r.temps_removed, r.forgotten.len());
    }
    for w in &d.manifest.warnings {
        eprintln!("manifest: {w}");
    }
    d
}

fn is_audio(p: &Path) -> bool {
    p.extension().and_then(|e| e.to_str()).map(|e| AUDIO.contains(&e.to_lowercase().as_str())).unwrap_or(false)
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut v: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
    v.sort();
    for p in v {
        if p.file_name().and_then(|n| n.to_str()).map(|n| n.starts_with('.')).unwrap_or(false) {
            continue;
        }
        if p.is_dir() { walk(&p, out) } else if is_audio(&p) { out.push(p) }
    }
}

fn read_playlist(file: &Path) -> Vec<PathBuf> {
    let bytes = std::fs::read(file).unwrap_or_else(|e| die(format!("{}: {e}", file.display())));
    let text = match String::from_utf8(bytes) {
        Ok(t) => t,
        Err(e) => e.into_bytes().iter().map(|&b| b as char).collect(), // .m3u: Latin-1
    };
    let base = file.parent().unwrap_or(Path::new("."));
    text.lines()
        .map(|l| l.trim().trim_start_matches('\u{feff}'))
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(|l| {
            let l = l.strip_prefix("file://").unwrap_or(l);
            let p = PathBuf::from(if std::path::MAIN_SEPARATOR == '/' { l.replace('\\', "/") } else { l.to_string() });
            if p.is_absolute() { p } else { base.join(p) }
        })
        .collect()
}

fn item_for(src: &Path, rel: String) -> Option<Item> {
    let meta = std::fs::metadata(src).ok()?;
    let mtime = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
    let abs = std::fs::canonicalize(src).unwrap_or_else(|_| src.to_path_buf());
    Some(Item {
        track: format!("file:{}", abs.display()),
        src: abs,
        rel,
        size: meta.len(),
        src_fp: format!("{}:{mtime}", meta.len()),
        codec: src.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase(),
    })
}

/// Where a source file goes under the managed root: its path inside --library, else `<folder>/<file>`.
fn rel_for(src: &Path, library: Option<&Path>, base: Option<&Path>) -> String {
    let src = std::fs::canonicalize(src).unwrap_or_else(|_| src.to_path_buf());
    for root in [library, base].into_iter().flatten() {
        let root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
        if let Ok(r) = src.strip_prefix(&root) {
            return r.to_string_lossy().replace('\\', "/");
        }
    }
    let file = src.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default();
    match src.parent().and_then(|p| p.file_name()) {
        Some(dir) => format!("{}/{file}", dir.to_string_lossy()),
        None => file,
    }
}

struct Bar;
impl Progress for Bar {
    fn step(&mut self, done: usize, total: usize, what: &str) {
        eprint!("\r\x1b[2K[{done}/{total}] {}", what.chars().take(100).collect::<String>());
        if done == total {
            eprintln!();
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cmd = args.first().map(String::as_str).unwrap_or("help");
    let vol = || args.get(1).cloned().unwrap_or_else(|| die("which volume?"));
    match cmd {
        "list" => {
            for (p, paired) in find_media(&[]) {
                let d = disk::info(&p).ok();
                let label = if paired { Device::open(&p).map(|d| format!("paired: {} ({}, {:?})", d.config.name, d.config.kind, d.config.mode)).unwrap_or_else(|e| format!("paired, unreadable: {e}")) } else { "not paired".into() };
                println!("{:<40} {:>10} free  {label}", p.display(), d.map(|d| human(d.free)).unwrap_or("?".into()));
            }
        }
        "init" => {
            let v = vol();
            let mode: Mode = flag(&args, "--mode").map(|m| m.parse().unwrap_or_else(|e| die(e))).unwrap_or_default();
            let name = flag(&args, "--name").unwrap_or_else(|| Path::new(&v).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or("bootleg".into()));
            let d = Device::init(Path::new(&v), &name, &flag(&args, "--kind").unwrap_or("generic".into()), mode, &flag(&args, "--root").unwrap_or("Music/bootleg".into())).unwrap_or_else(|e| die(e));
            println!("paired {} as \"{}\" ({}), mode {:?}, managed folder /{}", v, d.config.name, d.config.id, d.config.mode, d.config.root);
        }
        "status" => {
            let d = open(&vol());
            let c = &d.config;
            println!("{} ({})  kind {}  mode {:?}  managed /{}", c.name, c.id, c.kind, c.mode, c.root);
            println!("last sync: {}", c.last_sync.map(|t| format!("{t} (unix)")).unwrap_or("never".into()));
            println!("bootleg files: {} ({})", d.manifest.len(), human(d.manifest.bytes()));
            if let Ok(di) = disk::info(&d.volume) {
                println!("volume: {} free of {}{}", human(di.free), human(di.total), if di.fat32 { ", FAT32 (4 GB file limit)" } else { "" });
            }
            println!("plays: {}  ·  playlists: {}", c.profile.codecs.join(","), c.profile.playlist);
            for p in players::list(&d.volume) {
                println!("player: {} ({}) {} last seen {}", p.name, p.id, p.app, p.last_seen);
            }
            let ob = outbox::read_all(&d.volume).unwrap_or_default();
            if !ob.is_empty() {
                println!("outbox: {} event(s) waiting in {} file(s)", ob.iter().map(|f| f.events.len()).sum::<usize>(), ob.len());
            }
        }
        "set" => {
            let mut d = open(&vol());
            for kv in &args[2..] {
                let (k, v) = kv.split_once('=').unwrap_or_else(|| die(format!("{kv}: expected key=value")));
                let c = &mut d.config;
                match k {
                    "mode" => c.mode = v.parse().unwrap_or_else(|e| die(e)),
                    "root" => c.root = bootleg_sync::config::clean_root(v),
                    "name" => c.name = v.into(),
                    "kind" => c.kind = v.into(),
                    "keep_free" => {
                        parse_size(v).unwrap_or_else(|e| die(e));
                        c.fill.keep_free = Some(Size::Text(v.into()))
                    }
                    "max_use" => c.fill.max_use = Some(v.parse().unwrap_or_else(|_| die("max_use: a percentage"))),
                    "codecs" => c.profile.codecs = v.split(',').map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty()).collect(),
                    "transcode_to" => c.profile.transcode_to = v.into(),
                    "playlist" => c.profile.playlist = v.into(),
                    "path_sep" => c.profile.path_sep = v.into(),
                    "ascii" => c.profile.ascii = v == "true",
                    "stems" => c.stems = v == "true",
                    _ => die(format!("unknown key {k}")),
                }
            }
            d.save_config().unwrap_or_else(|e| die(e));
            println!("saved");
        }
        "push" => {
            let mut d = open(&vol());
            let library = flag(&args, "--library").map(PathBuf::from);
            let dry = args.iter().any(|a| a == "--dry-run");
            let mut skip_next = false;
            let (mut items, mut pls, mut seen) = (vec![], vec![], HashSet::new());
            for a in &args[2..] {
                if skip_next { skip_next = false; continue; }
                if a == "--library" { skip_next = true; continue; }
                if a.starts_with("--") { continue; }
                let p = PathBuf::from(a);
                let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
                let mut keys = vec![];
                let srcs: Vec<(PathBuf, Option<PathBuf>)> = if ext == "m3u8" || ext == "m3u" {
                    read_playlist(&p).into_iter().map(|s| (s, None)).collect()
                } else if p.is_dir() {
                    let mut v = vec![];
                    walk(&p, &mut v);
                    let base = p.canonicalize().ok().and_then(|c| c.parent().map(Path::to_path_buf));
                    v.into_iter().map(|s| (s, base.clone())).collect()
                } else {
                    vec![(p.clone(), None)]
                };
                for (s, base) in srcs {
                    match item_for(&s, rel_for(&s, library.as_deref(), base.as_deref())) {
                        Some(it) => {
                            keys.push(it.track.clone());
                            if seen.insert(it.track.clone()) {
                                items.push(it);
                            }
                        }
                        None => eprintln!("missing: {}", s.display()),
                    }
                }
                if ext == "m3u8" || ext == "m3u" {
                    pls.push(PlaylistSpec { name: p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or("playlist".into()), tracks: keys });
                }
            }
            let di = disk::info(&d.volume).unwrap_or_else(|e| die(format!("free space: {e}")));
            let p = plan(&d, &items, &pls, &di, &PlanOptions::default()).unwrap_or_else(|e| die(e));
            let count = |f: fn(&Op) -> bool| p.ops.iter().filter(|o| f(o)).count();
            println!(
                "{} to copy ({}), {} to delete ({} freed), {} playlist(s), {} already there{}",
                count(|o| matches!(o, Op::Copy { .. })), human(p.bytes_in), count(|o| matches!(o, Op::Delete { .. })), human(p.bytes_freed),
                count(|o| matches!(o, Op::Playlist { .. })), p.unchanged,
                if p.kept_unselected > 0 { format!(", {} no longer selected but kept (add mode)", p.kept_unselected) } else { String::new() }
            );
            for (t, why) in &p.skipped {
                println!("skipped {why:?}: {t}");
            }
            for (t, path) in &p.renamed {
                println!("renamed (a file of yours is at its path): {t} → {path}");
            }
            if let Some(n) = p.short_by {
                die(format!("does not fit: {} short (mirror mode copies all or nothing)", human(n)));
            }
            if dry {
                for o in &p.ops {
                    match o {
                        Op::Copy { dest, .. } => println!("  + {dest}"),
                        Op::Delete { path, .. } => println!("  - {path}"),
                        Op::Playlist { dest, .. } => println!("  ≡ {dest}"),
                    }
                }
                return;
            }
            let r = apply(&mut d, &p, &mut Bar, None).unwrap_or_else(|e| die(e));
            println!("copied {} ({}), deleted {}, playlists {}", r.copied, human(r.bytes), r.deleted, r.playlists);
            for (path, e) in &r.failed {
                println!("FAILED {path}: {e}");
            }
            if !r.failed.is_empty() {
                exit(2);
            }
        }
        "verify" => {
            let d = open(&vol());
            let v = d.verify().unwrap_or_else(|e| die(e));
            println!("{} ok, {} missing, {} changed", v.ok, v.missing.len(), v.changed.len());
            for m in &v.missing { println!("missing: {m}"); }
            for c in &v.changed { println!("changed: {c}"); }
            if !(v.missing.is_empty() && v.changed.is_empty()) { exit(2) }
        }
        "outbox" => {
            let d = open(&vol());
            let files = outbox::read_all(&d.volume).unwrap_or_else(|e| die(e));
            for f in &files {
                for e in &f.events {
                    println!("{}", serde_json::to_string(e).unwrap());
                }
                if f.bad_lines > 0 { eprintln!("{}: {} unreadable line(s)", f.path.display(), f.bad_lines); }
                if args.iter().any(|a| a == "--ack") { outbox::ack(f).unwrap_or_else(|e| die(e)); }
            }
        }
        "player" => {
            let v = vol();
            let id = flag(&args, "--id").unwrap_or_else(|| die("--id"));
            let rec = players::PlayerRecord { id, name: flag(&args, "--name").unwrap_or_default(), model: flag(&args, "--model").unwrap_or_default(), app: format!("bootleg-sync {}", env!("CARGO_PKG_VERSION")), last_seen: 0, extra: Default::default() };
            players::touch(Path::new(&v), &rec).unwrap_or_else(|e| die(e));
            println!("recorded");
        }
        _ => println!("{HELP}"),
    }
}
