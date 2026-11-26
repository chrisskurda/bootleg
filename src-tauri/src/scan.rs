// Fast folder scanner: walks a library folder in Rust (parallel) and returns every file the player cares about with its
// size and modified time — one call, instead of one IPC round trip per file from the page.
use serde::Serialize;
use std::{
    collections::VecDeque,
    fs,
    path::{Path, PathBuf},
    sync::{atomic::{AtomicUsize, Ordering}, Condvar, Mutex},
    time::UNIX_EPOCH,
};

#[derive(Serialize)]
pub struct Entry { pub path: String, pub size: u64, pub mtime: u64 }
#[derive(Serialize, Clone)]
pub struct Progress { pub dirs: usize, pub files: usize }

const AUDIO: [&str; 10] = ["mp3", "flac", "m4a", "aac", "ogg", "opus", "wav", "aif", "aiff", "caf"];
fn wanted(name: &str) -> bool {
    if name == "manifest.json" || name == "clips.json" { return true; }
    match name.rsplit_once('.') { Some((_, e)) => { let e = e.to_ascii_lowercase(); e == "nfo" || e == "bstem" || e == "bsong" || e == "dawproject" || AUDIO.contains(&e.as_str()) } None => false }
}

pub fn scan(root: &Path, mut on_progress: impl FnMut(Progress) + Send) -> Vec<Entry> {
    struct Shared { queue: Mutex<VecDeque<(PathBuf, u8)>>, cv: Condvar, pending: AtomicUsize, out: Mutex<Vec<Entry>>, dirs: AtomicUsize, files: AtomicUsize }
    let sh = Shared { queue: Mutex::new(VecDeque::from([(root.to_path_buf(), 0)])), cv: Condvar::new(), pending: AtomicUsize::new(1), out: Mutex::new(vec![]), dirs: AtomicUsize::new(0), files: AtomicUsize::new(0) };
    let progress = Mutex::new(&mut on_progress);
    let workers = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(2, 8);
    std::thread::scope(|sc| {
        for _ in 0..workers {
            sc.spawn(|| loop {
                let job = { let mut q = sh.queue.lock().unwrap(); loop { if let Some(j) = q.pop_front() { break Some(j); } if sh.pending.load(Ordering::SeqCst) == 0 { break None; } q = sh.cv.wait(q).unwrap(); } };
                let Some((dir, depth)) = job else { sh.cv.notify_all(); return; };
                let mut found = vec![]; let mut subdirs = vec![];
                if let Ok(rd) = fs::read_dir(&dir) {
                    for e in rd.flatten() {
                        let name = e.file_name(); let name = name.to_string_lossy(); if name.starts_with('.') { continue; }
                        let p = e.path();
                        let md = match e.file_type() { Ok(t) if t.is_symlink() => fs::metadata(&p).ok(), Ok(_) => e.metadata().ok(), Err(_) => None };
                        let Some(md) = md else { continue };
                        if md.is_dir() { if depth < 40 { subdirs.push(p); } }
                        else if wanted(&name) { found.push(Entry { path: p.to_string_lossy().into_owned(), size: md.len(), mtime: md.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0) }); }
                    }
                }
                let nf = found.iter().filter(|e| !e.path.ends_with(".nfo") && !e.path.ends_with(".json")).count();
                if !found.is_empty() { sh.out.lock().unwrap().extend(found); }
                let d = sh.dirs.fetch_add(1, Ordering::Relaxed) + 1; let f = sh.files.fetch_add(nf, Ordering::Relaxed) + nf;
                if d % 20 == 0 { if let Ok(mut cb) = progress.try_lock() { (*cb)(Progress { dirs: d, files: f }); } }
                { let mut q = sh.queue.lock().unwrap(); sh.pending.fetch_add(subdirs.len(), Ordering::SeqCst); for s in subdirs { q.push_back((s, depth + 1)); } }
                sh.pending.fetch_sub(1, Ordering::SeqCst); sh.cv.notify_all();
            });
        }
    });
    let mut v = sh.out.into_inner().unwrap(); v.sort_by(|a, b| a.path.cmp(&b.path)); v
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn finds_wanted_files_recursively_and_skips_hidden() {
        let d = std::env::temp_dir().join(format!("bootleg-scan-{}", std::process::id())); let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join("a/b")).unwrap(); fs::create_dir_all(d.join(".hidden")).unwrap();
        for f in ["a/one.flac", "a/b/two.MP3", "a/album.nfo", "a/b/manifest.json", "a/cover.jpg", "a/notes.txt", ".hidden/x.flac", "a/.dot.flac"] { fs::write(d.join(f), b"x").unwrap(); }
        let got: Vec<String> = scan(&d, |_| {}).into_iter().map(|e| e.path.replace(&d.to_string_lossy().to_string(), "")).collect();
        assert_eq!(got, vec!["/a/album.nfo", "/a/b/manifest.json", "/a/b/two.MP3", "/a/one.flac"]); let _ = fs::remove_dir_all(&d);
    }
}
