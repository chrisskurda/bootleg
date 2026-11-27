// A media proxy on 127.0.0.1 for servers that don't allow other web origins (Plex only allows app.plex.tv). The player's
// <audio>/<video> elements must load media with CORS for their sound to reach the audio graph (visualizer, inserts,
// volume); without it they play silence, and the fallback — downloading the whole file first — is poor for video.
//   * listens on the loopback interface only (never the LAN), on a random port;
//   * forwards only URLs the app registered (media_proxy), each behind a random token: /p/<token>;
//   * passes Range through (seeking), and answers with Access-Control-Allow-Origin: *.
use std::{
    collections::{hash_map::RandomState, HashMap},
    hash::{BuildHasher, Hasher},
    sync::{Arc, Mutex, OnceLock},
    thread,
    time::Duration,
};
use tiny_http::{Header, Method, Response, Server, StatusCode};

type Routes = Arc<Mutex<HashMap<String, String>>>;
struct Proxy { routes: Routes, base: String }
static PROXY: OnceLock<Proxy> = OnceLock::new();
const KEEP: usize = 512;      // registered URLs kept (oldest dropped); a queue of streams never needs more

fn token() -> String { let mut o = String::new(); for _ in 0..2 { o += &format!("{:016x}", RandomState::new().build_hasher().finish()); } o }
fn hdr(k: &str, v: &str) -> Option<Header> { Header::from_bytes(k.as_bytes(), v.as_bytes()).ok() }

fn serve(req: tiny_http::Request, routes: Routes) {
    let cors = || ["Access-Control-Allow-Origin: *", "Access-Control-Allow-Headers: Range", "Access-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges"].into_iter().filter_map(|h| h.split_once(": ").and_then(|(k, v)| hdr(k, v))).collect::<Vec<_>>();
    if *req.method() == Method::Options { let mut r = Response::empty(204); for h in cors() { r.add_header(h); } let _ = req.respond(r); return; }
    let id = req.url().trim_start_matches("/p/").split(['?', '.', '/']).next().unwrap_or("").to_string();
    let Some(target) = req.url().starts_with("/p/").then(|| routes.lock().ok().and_then(|m| m.get(&id).cloned())).flatten() else { let _ = req.respond(Response::empty(404)); return; };
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    let agent = AGENT.get_or_init(|| ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(10)).timeout_read(Duration::from_secs(60)).build());
    let mut out = agent.request(if *req.method() == Method::Head { "HEAD" } else { "GET" }, &target);
    if let Some(r) = req.headers().iter().find(|h| h.field.equiv("Range")) { out = out.set("Range", r.value.as_str()); }
    let resp = match out.call() { Ok(r) => r, Err(ureq::Error::Status(_, r)) => r, Err(e) => { let _ = req.respond(Response::from_string(e.to_string()).with_status_code(502)); return; } };
    let status = resp.status();
    let mut headers = cors();
    for k in ["Content-Type", "Content-Range", "Accept-Ranges", "Last-Modified", "ETag", "Cache-Control"] { if let Some(v) = resp.header(k) { headers.extend(hdr(k, v)); } }
    let len = resp.header("Content-Length").and_then(|v| v.parse::<usize>().ok());
    let _ = req.respond(Response::new(StatusCode(status), headers, resp.into_reader(), len, None));
}

fn proxy() -> Result<&'static Proxy, String> {
    if let Some(p) = PROXY.get() { return Ok(p); }
    let server = Server::http("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = server.server_addr().to_ip().map(|a| a.port()).ok_or("no port")?;
    let routes: Routes = Arc::new(Mutex::new(HashMap::new())); let r = routes.clone();
    thread::spawn(move || { for req in server.incoming_requests() { let r = r.clone(); thread::spawn(move || serve(req, r)); } });
    let _ = PROXY.set(Proxy { routes, base: format!("http://127.0.0.1:{port}") });
    PROXY.get().ok_or_else(|| "media proxy".into())
}

/// Registers a remote media URL (http or https) and returns a loopback URL that streams it with CORS.
pub fn register(url: &str) -> Result<String, String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) { return Err("only http(s) URLs can be proxied".into()); }
    let p = proxy()?; let mut m = p.routes.lock().map_err(|e| e.to_string())?;
    if let Some((k, _)) = m.iter().find(|(_, u)| u.as_str() == url) { return Ok(format!("{}/p/{}", p.base, k)); }
    if m.len() >= KEEP { if let Some(k) = m.keys().next().cloned() { m.remove(&k); } }
    let t = token(); m.insert(t.clone(), url.to_string()); Ok(format!("{}/p/{}", p.base, t))
}

#[tauri::command]
pub fn media_proxy(url: String) -> Result<String, String> { register(&url) }

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    #[test]
    fn streams_ranges_with_cors_and_only_registered_urls() {
        // a stand-in origin server without CORS
        let origin = Server::http("127.0.0.1:0").unwrap(); let port = origin.server_addr().to_ip().unwrap().port();
        thread::spawn(move || for req in origin.incoming_requests() {
            let body: Vec<u8> = (0..=255u8).collect(); let range = req.headers().iter().find(|h| h.field.equiv("Range")).map(|h| h.value.to_string());
            let r = match range { Some(_) => Response::from_data(body[10..20].to_vec()).with_status_code(206).with_header(hdr("Content-Range", "bytes 10-19/256").unwrap()), None => Response::from_data(body) };
            let _ = req.respond(r.with_header(hdr("Content-Type", "audio/flac").unwrap()));
        });
        let local = register(&format!("http://127.0.0.1:{port}/a.flac?X-Plex-Token=secret")).unwrap();
        assert!(local.starts_with("http://127.0.0.1:") && !local.contains("secret"), "{local}");
        assert_eq!(register(&format!("http://127.0.0.1:{port}/a.flac?X-Plex-Token=secret")).unwrap(), local, "the same URL keeps its token");
        let r = ureq::get(&local).call().unwrap(); assert_eq!(r.header("Access-Control-Allow-Origin"), Some("*")); assert_eq!(r.header("Content-Type"), Some("audio/flac"));
        let mut b = vec![]; r.into_reader().read_to_end(&mut b).unwrap(); assert_eq!(b.len(), 256);
        let r = ureq::get(&local).set("Range", "bytes=10-19").call().unwrap(); assert_eq!(r.status(), 206); assert_eq!(r.header("Content-Range"), Some("bytes 10-19/256"));
        let mut b = vec![]; r.into_reader().read_to_end(&mut b).unwrap(); assert_eq!(b, (10..20u8).collect::<Vec<_>>());
        let base = local.rsplit_once("/p/").unwrap().0;
        assert!(matches!(ureq::get(&format!("{base}/p/nope")).call(), Err(ureq::Error::Status(404, _))), "unknown tokens are refused");
        assert!(register("file:///etc/passwd").is_err());
    }
}
