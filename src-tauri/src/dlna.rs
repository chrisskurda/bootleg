// DLNA / UPnP MediaRenderer control: discover renderers (SSDP), then drive AVTransport + RenderingControl over SOAP.
// Plain HTTP on the local network. The device fetches the audio from our LAN media server (see lan.rs).
use serde::Serialize;
use std::{collections::HashSet, net::UdpSocket, time::{Duration, Instant}};

const AV: &str = "urn:schemas-upnp-org:service:AVTransport:1";
const RC: &str = "urn:schemas-upnp-org:service:RenderingControl:1";

#[derive(Serialize, Clone, Debug)]
pub struct Device { pub id: String, pub name: String, pub model: String, pub location: String, pub av: String, pub rc: String }
#[derive(Serialize, Debug)]
pub struct Status { pub state: String, pub pos: f64, pub dur: f64 }

fn unescape(s: &str) -> String { s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&") }
pub fn escape(s: &str) -> String { s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&apos;") }

/// First <name ...>text</name> in `xml` (namespace prefixes are ignored by matching ":name" too).
fn tag(xml: &str, name: &str) -> Option<String> {
    for open in [format!("<{name}>"), format!("<{name} ")] {
        if let Some(i) = xml.find(&open) {
            let rest = &xml[i..]; let gt = rest.find('>')?; let body = &rest[gt + 1..];
            let end = body.find(&format!("</{name}>"))?; return Some(unescape(body[..end].trim()));
        }
    }
    None
}
fn origin(url: &str) -> String { let after = url.find("://").map(|i| i + 3).unwrap_or(0); let end = url[after..].find('/').map(|i| after + i).unwrap_or(url.len()); url[..end].to_string() }
fn join(base: &str, loc: &str, path: &str) -> String {
    if path.starts_with("http") { return path.into(); }
    let b = if base.is_empty() { loc } else { base };      // no <URLBase>: URLs are relative to the description's own address
    if path.starts_with('/') { return format!("{}{}", origin(b), path); }
    let cut = b.rfind('/').map(|i| &b[..=i]).unwrap_or(b); format!("{cut}{path}")
}

pub fn parse_description(location: &str, xml: &str) -> Option<Device> {
    let urlbase = tag(xml, "URLBase").unwrap_or_default(); let mut av = String::new(); let mut rc = String::new();
    for block in xml.split("<service>").skip(1) {
        let ty = tag(block, "serviceType").unwrap_or_default(); let ctl = tag(block, "controlURL").unwrap_or_default();
        if ty.contains("AVTransport") { av = join(&urlbase, location, &ctl); } else if ty.contains("RenderingControl") { rc = join(&urlbase, location, &ctl); }
    }
    if av.is_empty() { return None; }
    Some(Device { id: tag(xml, "UDN").unwrap_or_else(|| location.to_string()), name: tag(xml, "friendlyName").unwrap_or_else(|| "Renderer".into()), model: tag(xml, "modelName").unwrap_or_default(), location: location.into(), av, rc })
}

fn http_get(url: &str) -> Result<String, String> { ureq::get(url).timeout(Duration::from_secs(3)).call().map_err(|e| e.to_string())?.into_string().map_err(|e| e.to_string()) }
pub fn describe(location: &str) -> Result<Device, String> { parse_description(location, &http_get(location)?).ok_or_else(|| "that device has no AVTransport service (not a DLNA media renderer)".to_string()) }

/// SSDP M-SEARCH for MediaRenderers; returns each responder's description URL.
pub fn ssdp(timeout: Duration) -> Vec<String> {
    let Ok(sock) = UdpSocket::bind("0.0.0.0:0") else { return vec![] };
    let _ = sock.set_read_timeout(Some(Duration::from_millis(250))); let _ = sock.set_multicast_ttl_v4(2);
    let msg = "M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n";
    let mut seen = HashSet::new(); let mut out = vec![]; let start = Instant::now(); let mut sent = 0;
    while start.elapsed() < timeout {
        if sent < 2 && start.elapsed() > Duration::from_millis(sent * 700) { let _ = sock.send_to(msg.as_bytes(), "239.255.255.250:1900"); sent += 1; }
        let mut buf = [0u8; 2048];
        if let Ok((n, _)) = sock.recv_from(&mut buf) {
            let text = String::from_utf8_lossy(&buf[..n]);
            if let Some(loc) = text.lines().find_map(|l| { let (k, v) = l.split_once(':')?; if k.trim().eq_ignore_ascii_case("location") { Some(v.trim().to_string()) } else { None } }) { if seen.insert(loc.clone()) { out.push(loc); } }
        }
    }
    out
}

fn soap(url: &str, svc: &str, action: &str, args: &str) -> Result<String, String> {
    let body = format!("<?xml version=\"1.0\" encoding=\"utf-8\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body><u:{action} xmlns:u=\"{svc}\">{args}</u:{action}></s:Body></s:Envelope>");
    match ureq::post(url).set("Content-Type", "text/xml; charset=\"utf-8\"").set("SOAPAction", &format!("\"{svc}#{action}\"")).timeout(Duration::from_secs(6)).send_string(&body) {
        Ok(r) => r.into_string().map_err(|e| e.to_string()),
        Err(ureq::Error::Status(code, r)) => { let t = r.into_string().unwrap_or_default(); Err(format!("{action} failed ({code}): {}", tag(&t, "errorDescription").unwrap_or_default())) }
        Err(e) => Err(format!("{action}: {e}")),
    }
}
fn hms(secs: f64) -> String { let s = secs.max(0.0) as u64; format!("{:02}:{:02}:{:02}", s / 3600, s % 3600 / 60, s % 60) }
fn parse_hms(s: &str) -> f64 { let p: Vec<f64> = s.split(':').map(|x| x.parse().unwrap_or(0.0)).collect(); if p.len() == 3 { p[0] * 3600.0 + p[1] * 60.0 + p[2] } else { 0.0 } }

pub fn play(av: &str, url: &str, title: &str, artist: &str, album: &str, mime: &str) -> Result<(), String> {
    let didl = format!("<DIDL-Lite xmlns=\"urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:upnp=\"urn:schemas-upnp-org:metadata-1-0/upnp/\"><item id=\"0\" parentID=\"-1\" restricted=\"1\"><dc:title>{}</dc:title><dc:creator>{}</dc:creator><upnp:artist>{}</upnp:artist><upnp:album>{}</upnp:album><upnp:class>object.item.audioItem.musicTrack</upnp:class><res protocolInfo=\"http-get:*:{}:*\">{}</res></item></DIDL-Lite>", escape(title), escape(artist), escape(artist), escape(album), mime, escape(url));
    soap(av, AV, "SetAVTransportURI", &format!("<InstanceID>0</InstanceID><CurrentURI>{}</CurrentURI><CurrentURIMetaData>{}</CurrentURIMetaData>", escape(url), escape(&didl)))?;
    soap(av, AV, "Play", "<InstanceID>0</InstanceID><Speed>1</Speed>").map(|_| ())
}
pub fn transport(av: &str, action: &str) -> Result<(), String> {
    match action { "Play" => soap(av, AV, "Play", "<InstanceID>0</InstanceID><Speed>1</Speed>"), "Pause" => soap(av, AV, "Pause", "<InstanceID>0</InstanceID>"), "Stop" => soap(av, AV, "Stop", "<InstanceID>0</InstanceID>"), _ => Err(format!("unknown action {action}")) }.map(|_| ())
}
pub fn seek(av: &str, secs: f64) -> Result<(), String> { soap(av, AV, "Seek", &format!("<InstanceID>0</InstanceID><Unit>REL_TIME</Unit><Target>{}</Target>", hms(secs))).map(|_| ()) }
pub fn volume(rc: &str, v: u8) -> Result<(), String> { soap(rc, RC, "SetVolume", &format!("<InstanceID>0</InstanceID><Channel>Master</Channel><DesiredVolume>{}</DesiredVolume>", v.min(100))).map(|_| ()) }
pub fn status(av: &str) -> Result<Status, String> {
    let ti = soap(av, AV, "GetTransportInfo", "<InstanceID>0</InstanceID>")?; let pi = soap(av, AV, "GetPositionInfo", "<InstanceID>0</InstanceID>")?;
    Ok(Status { state: tag(&ti, "CurrentTransportState").unwrap_or_default(), pos: parse_hms(&tag(&pi, "RelTime").unwrap_or_default()), dur: parse_hms(&tag(&pi, "TrackDuration").unwrap_or_default()) })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn parses_a_description() {
        let xml = r#"<root><URLBase>http://10.0.0.5:49152/</URLBase><device><friendlyName>Living Room</friendlyName><modelName>X1</modelName><UDN>uuid:abc</UDN><serviceList>
          <service><serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType><controlURL>/rc/ctl</controlURL></service>
          <service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>av/ctl</controlURL></service></serviceList></device></root>"#;
        let d = parse_description("http://10.0.0.5:49152/desc.xml", xml).unwrap();
        assert_eq!((d.name.as_str(), d.id.as_str(), d.av.as_str(), d.rc.as_str()), ("Living Room", "uuid:abc", "http://10.0.0.5:49152/av/ctl", "http://10.0.0.5:49152/rc/ctl"));
    }
    #[test] fn urls_without_urlbase_resolve_against_the_location() {
        let xml = "<root><device><friendlyName>X</friendlyName><service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/av</controlURL></service></device></root>";
        assert_eq!(parse_description("http://127.0.0.1:5000/desc.xml", xml).unwrap().av, "http://127.0.0.1:5000/av");
    }
    #[test] fn escapes_and_times() { assert_eq!(escape("a&b<c>"), "a&amp;b&lt;c&gt;"); assert_eq!(hms(3725.4), "01:02:05"); assert_eq!(parse_hms("00:01:05.500"), 65.5); }
}
