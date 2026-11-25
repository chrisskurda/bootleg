// A tiny LAN media server: lets other devices (DLNA renderers, Chromecast) fetch a file the user is playing.
//   * only files that are already allowed in the app (the user picked them) can be shared;
//   * each share gets a random token URL (/m/<token>.<ext>), nothing else is served;
//   * HTTP Range is supported (renderers seek and probe with it).
use std::{
    collections::{hash_map::RandomState, HashMap},
    fs::File,
    hash::{BuildHasher, Hasher},
    io::{Read, Seek, SeekFrom},
    net::UdpSocket,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    thread,
};
use tiny_http::{Header, Response, Server, StatusCode};

type Shares = Arc<Mutex<HashMap<String, PathBuf>>>;
struct Lan { shares: Shares, base: String }
static LAN: OnceLock<Lan> = OnceLock::new();

pub fn lan_ip() -> String {
    // "connect" a UDP socket to a public address (nothing is sent) to learn which local address the OS would use
    UdpSocket::bind("0.0.0.0:0").and_then(|s| { s.connect("8.8.8.8:80")?; s.local_addr() }).map(|a| a.ip().to_string()).unwrap_or_else(|_| "127.0.0.1".into())
}

fn mime(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("flac") => "audio/flac", Some("mp3") => "audio/mpeg", Some("m4a") | Some("aac") => "audio/mp4", Some("ogg") | Some("opus") => "audio/ogg",
        Some("wav") => "audio/wav", Some("aif") | Some("aiff") => "audio/aiff", _ => "application/octet-stream",
    }
}
pub fn mime_of(path: &str) -> &'static str { mime(Path::new(path)) }

fn token() -> String { let mut o = String::new(); for _ in 0..2 { o += &format!("{:016x}", RandomState::new().build_hasher().finish()); } o }

fn serve(req: tiny_http::Request, shares: Shares) {
    let url = req.url().to_string();
    let id = url.trim_start_matches("/m/").split(['.', '?']).next().unwrap_or("").to_string();
    let path = shares.lock().ok().and_then(|m| m.get(&id).cloned());
    let Some(path) = path.filter(|_| url.starts_with("/m/")) else { let _ = req.respond(Response::empty(404)); return; };
    let Ok(mut f) = File::open(&path) else { let _ = req.respond(Response::empty(404)); return; };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let hdr = |k: &str, v: &str| Header::from_bytes(k.as_bytes(), v.as_bytes()).unwrap();
    let range = req.headers().iter().find(|h| h.field.equiv("Range")).map(|h| h.value.as_str().to_string());
    let (start, end, partial) = match range.as_deref().and_then(|r| r.strip_prefix("bytes=")) {
        Some(r) => { let mut it = r.splitn(2, '-'); let a = it.next().unwrap_or(""); let b = it.next().unwrap_or(""); let (s, e) = if a.is_empty() { let n: u64 = b.parse().unwrap_or(0); (len.saturating_sub(n), len.saturating_sub(1)) } else { (a.parse().unwrap_or(0), b.parse().unwrap_or(len.saturating_sub(1)).min(len.saturating_sub(1))) }; (s, e, true) }
        None => (0, len.saturating_sub(1), false),
    };
    if len == 0 || start > end { let _ = req.respond(Response::empty(416)); return; }
    let n = end - start + 1; let _ = f.seek(SeekFrom::Start(start));
    let mut headers = vec![hdr("Content-Type", mime(&path)), hdr("Accept-Ranges", "bytes"), hdr("transferMode.dlna.org", "Streaming"), hdr("contentFeatures.dlna.org", "DLNA.ORG_OP=01;DLNA.ORG_CI=0"), hdr("Access-Control-Allow-Origin", "*")];
    if partial { headers.push(hdr("Content-Range", &format!("bytes {start}-{end}/{len}"))); }
    let _ = req.respond(Response::new(StatusCode(if partial { 206 } else { 200 }), headers, f.take(n), Some(n as usize), None));
}

fn lan() -> Result<&'static Lan, String> {
    if let Some(l) = LAN.get() { return Ok(l); }
    let server = Server::http("0.0.0.0:0").map_err(|e| e.to_string())?;
    let port = server.server_addr().to_ip().map(|a| a.port()).ok_or("no port")?;
    let shares: Shares = Arc::new(Mutex::new(HashMap::new())); let sh = shares.clone();
    thread::spawn(move || { for req in server.incoming_requests() { let s = sh.clone(); thread::spawn(move || serve(req, s)); } });
    let _ = LAN.set(Lan { shares, base: format!("http://{}:{}", lan_ip(), port) });
    LAN.get().ok_or_else(|| "lan server".to_string())
}

/// Registers a file and returns the URL other devices on the network can fetch it from.
pub fn share(path: &Path) -> Result<String, String> {
    let l = lan()?; let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("bin").to_ascii_lowercase();
    let mut m = l.shares.lock().map_err(|e| e.to_string())?;
    if let Some((k, _)) = m.iter().find(|(_, p)| p.as_path() == path) { return Ok(format!("{}/m/{}.{}", l.base, k, ext)); }
    let t = token(); m.insert(t.clone(), path.to_path_buf()); Ok(format!("{}/m/{}.{}", l.base, t, ext))
}
