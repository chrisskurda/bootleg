// One check run: every file (cached results reused) on a few threads, then AccurateRip for the albums. Reports each
// result as it comes, so the page and the library fill in while the run goes on.
use crate::{album::{self, AlbumCheck}, cache::{stat, Cache}, decode::{self, FileCheck}};
use serde::{Deserialize, Serialize};
use std::{path::Path, sync::{atomic::{AtomicBool, AtomicUsize, Ordering}, mpsc}, time::Duration};

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Request {
    pub files: Vec<String>,
    /// Albums in disc order (one entry per disc), for AccurateRip. Every path should also be in `files`.
    pub albums: Vec<Vec<String>>,
    /// Ignore cached results.
    pub recheck: bool,
    /// Ask the AccurateRip database (network).
    pub accuraterip: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Out {
    #[serde(rename_all = "camelCase")]
    File { path: String, cached: bool, check: Option<FileCheck>, error: Option<String> },
    #[serde(rename_all = "camelCase")]
    Album { paths: Vec<String>, check: AlbumCheck },
}

#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Summary { pub files: usize, pub read: usize, pub cached: usize, pub failed: usize, pub albums: usize, pub cancelled: bool }

pub struct Hooks<'a> {
    pub emit: &'a mut dyn FnMut(Out),
    pub progress: &'a mut dyn FnMut(f64, &str),
    pub cancelled: &'a dyn Fn() -> bool,
    /// AccurateRip fetch (see album::verify).
    pub fetch: &'a dyn Fn(&str) -> Option<Option<Vec<u8>>>,
}

pub fn workers() -> usize { std::thread::available_parallelism().map(|n| n.get().saturating_sub(1)).unwrap_or(1).clamp(1, 4) }

pub fn run(req: &Request, cache: &mut Cache, h: &mut Hooks) -> Summary {
    let mut sum = Summary { files: req.files.len(), ..Default::default() };
    // cached first (no reading), the rest go to the workers
    let mut todo = vec![];
    for p in &req.files {
        let (size, mtime) = stat(Path::new(p));
        match (!req.recheck).then(|| cache.get(p, size, mtime).cloned()).flatten() {
            Some(c) => { sum.cached += 1; (h.emit)(Out::File { path: p.clone(), cached: true, check: Some(c), error: None }); }
            None => todo.push((p.clone(), size, mtime)),
        }
    }
    let total = req.files.len().max(1); let mut done = sum.cached;
    let stop = AtomicBool::new(false); let next = AtomicUsize::new(0);
    std::thread::scope(|s| {
        let (tx, rx) = mpsc::channel::<(usize, Result<FileCheck, String>)>();
        for _ in 0..workers().min(todo.len().max(1)) {
            let tx = tx.clone(); let (todo, stop, next) = (&todo, &stop, &next);
            s.spawn(move || loop {
                if stop.load(Ordering::Relaxed) { break; }
                let i = next.fetch_add(1, Ordering::Relaxed); if i >= todo.len() { break; }
                let r = std::panic::catch_unwind(|| decode::check(Path::new(&todo[i].0))).unwrap_or_else(|_| Err("the decoder crashed on this file".into()));
                if tx.send((i, r)).is_err() { break; }
            });
        }
        drop(tx);
        loop {
            if (h.cancelled)() { stop.store(true, Ordering::Relaxed); }
            match rx.recv_timeout(Duration::from_millis(200)) {
                Ok((i, r)) => {
                    let (p, size, mtime) = &todo[i]; done += 1; sum.read += 1;
                    match r {
                        Ok(c) => { cache.put(p, *size, *mtime, c.clone()); (h.emit)(Out::File { path: p.clone(), cached: false, check: Some(c), error: None }); }
                        Err(e) => { sum.failed += 1; (h.emit)(Out::File { path: p.clone(), cached: false, check: None, error: Some(e) }); }
                    }
                    (h.progress)(done as f64 / total as f64 * 0.95, &format!("Checked {done} of {total}"));
                }
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
    });
    if stop.load(Ordering::Relaxed) { sum.cancelled = true; return sum; }
    for (k, paths) in req.albums.iter().enumerate() {
        if (h.cancelled)() { sum.cancelled = true; break; }
        (h.progress)(0.95 + 0.05 * k as f64 / req.albums.len().max(1) as f64, &format!("AccurateRip: album {} of {}", k + 1, req.albums.len()));
        let sums: Vec<_> = paths.iter().map(|p| { let (size, mtime) = stat(Path::new(p)); cache.get(p, size, mtime).and_then(|c| c.measures.ar.clone()) }).collect();
        let refs: Vec<_> = sums.iter().map(|s| s.as_ref()).collect();
        let check = album::verify(&refs, &|path| if req.accuraterip { (h.fetch)(path) } else { None });
        sum.albums += 1; (h.emit)(Out::Album { paths: paths.clone(), check });
    }
    sum
}
