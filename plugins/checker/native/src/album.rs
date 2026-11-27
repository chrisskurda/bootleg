// AccurateRip for rips already in the library, without the disc (as CUETools does): an album's track lengths give the
// disc's table of contents, the TOC gives the AccurateRip ids, and each track's sums (analyze.rs) are compared with what
// the database holds. Works when the rip kept the disc's layout: one file per track, gaps appended to the track before
// (the usual default), no hidden track before track 1, and no data track. Otherwise the album isn't found.
use crate::analyze::ArSums;
use bootleg_plugin_cd::{accuraterip as ar, toc::{Toc, Track, SAMPLES_PER_SECTOR}};
use serde::Serialize;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AlbumCheck {
    /// "checked", "not-found" (not in the database), "offline", or "not-cd" (these files can't be a CD's tracks: `why`)
    pub state: &'static str, pub why: String,
    pub accuraterip_path: String, pub musicbrainz_id: String,
    pub tracks: Vec<ar::TrackResult>,
}

/// The TOC a disc with these track lengths (stereo frames) would have, if every length is whole sectors.
pub fn toc_from(frames: &[u64]) -> Result<Toc, String> {
    if frames.is_empty() || frames.len() > 99 { return Err("not 1–99 tracks".into()); }
    let mut start = 0i32; let mut tracks = vec![];
    for (i, &n) in frames.iter().enumerate() {
        if n % SAMPLES_PER_SECTOR as u64 != 0 { return Err(format!("track {} is not a whole number of CD sectors ({} samples)", i + 1, n)); }
        tracks.push(Track { number: i as u8 + 1, start, audio: true, preemphasis: false, session: 1, pregap: 0, isrc: None });
        start += (n / SAMPLES_PER_SECTOR as u64) as i32;
    }
    Ok(Toc { tracks, leadout: start, mcn: None })
}

/// `fetch(path)`: the database file for an AccurateRip path: Some(Some(bytes)), Some(None) when it has no entry, None offline.
pub fn verify(sums: &[Option<&ArSums>], fetch: &dyn Fn(&str) -> Option<Option<Vec<u8>>>) -> AlbumCheck {
    let mut out = AlbumCheck { state: "not-cd", why: String::new(), accuraterip_path: String::new(), musicbrainz_id: String::new(), tracks: vec![] };
    let Some(all) = sums.iter().copied().collect::<Option<Vec<_>>>() else { out.why = "not every track is 16-bit stereo 44.1 kHz lossless audio".into(); return out; };
    let toc = match toc_from(&all.iter().map(|s| s.frames).collect::<Vec<_>>()) { Ok(t) => t, Err(e) => { out.why = e; return out; } };
    out.accuraterip_path = toc.accuraterip_path(); out.musicbrainz_id = toc.musicbrainz_id();
    let responses = match fetch(&out.accuraterip_path) {
        None => { out.state = "offline"; return out; }
        Some(None) => { out.state = "not-found"; return out; }
        Some(Some(b)) => { let (i1, i2) = toc.accuraterip_ids(); ar::parse(&b, (i1, i2, toc.cddb_id())) }
    };
    if responses.is_empty() { out.state = "not-found"; return out; }
    let n = all.len();
    out.tracks = all.iter().enumerate().map(|(i, s)| { let (v1, v2) = s.pick(i == 0, i == n - 1); ar::verify(i, v1, v2, &responses) }).collect();
    out.state = "checked"; out
}
