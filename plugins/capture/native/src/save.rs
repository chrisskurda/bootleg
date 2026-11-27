// Saving a recording as tracks: each stretch read from the WAV, clicks removed (optional), a 5 ms fade at each cut,
// dithered to 16 bits or kept at 24, encoded to FLAC, tagged, and moved into place.
use crate::{declick::{declick, Settings}, wav::Reader};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TrackSpec { pub start: f64, pub end: f64, pub number: u32, pub title: String, pub artist: String }
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct SaveRequest {
    pub recording: String, pub dest: String, pub template: String,
    pub album: String, pub album_artist: String, pub year: String, pub genre: String, pub disc: u32,
    pub tracks: Vec<TrackSpec>,
    /// 16 (dithered) or 24.
    pub bits: u32, pub declick: bool,
    /// "vinyl", "tape" or "other", and the deck/turntable, for the comment tag.
    pub source: String, pub device: String,
}
impl Default for SaveRequest { fn default() -> Self { SaveRequest { recording: String::new(), dest: String::new(), template: DEFAULT_TEMPLATE.into(), album: String::new(), album_artist: String::new(), year: String::new(), genre: String::new(), disc: 0, tracks: vec![], bits: 24, declick: true, source: "vinyl".into(), device: String::new() } } }
pub const DEFAULT_TEMPLATE: &str = "{albumartist}/{album}/{track} {title}";

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Saved { pub path: String, pub number: u32, pub title: String, pub seconds: f64, pub clicks: usize, pub click_times: Vec<f64> }

fn safe(s: &str) -> String {
    let t: String = s.chars().map(|c| if "/\\:*?\"<>|".contains(c) || c.is_control() { '_' } else { c }).collect();
    let t = t.trim().trim_end_matches('.').trim().to_string(); if t.is_empty() { "_".into() } else { t.chars().take(120).collect() }
}
pub fn render(r: &SaveRequest, t: &TrackSpec) -> PathBuf {
    let aa = if r.album_artist.is_empty() { "Unknown Artist" } else { &r.album_artist }; let al = if r.album.is_empty() { "Unknown Album" } else { &r.album };
    let title = if t.title.is_empty() { format!("Track {:02}", t.number) } else { t.title.clone() };
    let tpl = if r.template.is_empty() { DEFAULT_TEMPLATE } else { &r.template };
    tpl.split('/').map(|part| { let mut s = part.to_string(); for (k, v) in [("{albumartist}", aa.to_string()), ("{artist}", t.artist.clone()), ("{album}", al.to_string()), ("{title}", title.clone()), ("{track}", format!("{:02}", t.number)), ("{disc}", r.disc.max(1).to_string()), ("{year}", r.year.clone()), ("{genre}", r.genre.clone())] { s = s.replace(k, &v); } safe(&s) }).collect()
}

/// Float samples → integers at `bits`; 16 bits gets TPDF dither (so quiet passages don't turn into distortion).
pub fn quantize(x: &[f32], bits: u32, seed: &mut u32) -> Vec<i32> {
    let full = (1i64 << (bits - 1)) as f32; let (lo, hi) = (-(full as i64), full as i64 - 1);
    let mut rnd = || { *seed ^= *seed << 13; *seed ^= *seed >> 17; *seed ^= *seed << 5; *seed as f32 / u32::MAX as f32 };
    x.iter().map(|&v| { let d = if bits <= 16 { rnd() - rnd() } else { 0.0 }; ((v * full + d).round() as i64).clamp(lo, hi) as i32 }).collect()
}

pub fn encode_flac(samples: &[i32], channels: usize, bits: usize, rate: usize) -> Result<Vec<u8>, String> {
    use flacenc::{component::BitRepr, error::Verify};
    let cfg = flacenc::config::Encoder::default().into_verified().map_err(|e| format!("{e:?}"))?;
    let src = flacenc::source::MemSource::from_samples(samples, channels, bits, rate);
    let stream = flacenc::encode_with_fixed_block_size(&cfg, src, cfg.block_size).map_err(|e| format!("FLAC encoding failed: {e:?}"))?;
    let mut sink = flacenc::bitsink::ByteSink::new(); stream.write(&mut sink).map_err(|e| format!("FLAC writing failed: {e:?}"))?;
    let mut f = sink.as_slice().to_vec();
    // as in the CD plugin (output.rs): min block size = max, and padding after STREAMINFO so taggers don't corrupt it
    if f.len() > 42 && &f[..4] == b"fLaC" { let max = [f[10], f[11]]; f[8] = max[0]; f[9] = max[1]; }
    if f.len() > 42 && &f[..4] == b"fLaC" && f[4] & 0x7f == 0 { f[4] &= 0x7f; let pad = 8192u32; let mut b = vec![0x80 | 1, (pad >> 16) as u8, (pad >> 8) as u8, pad as u8]; b.resize(4 + pad as usize, 0); f.splice(42..42, b); }
    Ok(f)
}

pub fn save(r: &SaveRequest, progress: &mut dyn FnMut(f64, &str), cancelled: &dyn Fn() -> bool) -> Result<Vec<Saved>, String> {
    if !matches!(r.bits, 16 | 24) { return Err("bits must be 16 or 24".into()); }
    let mut wav = Reader::open(Path::new(&r.recording))?; let (rate, ch) = (wav.rate, wav.channels as usize); let mut out = vec![]; let mut seed = 0x9e37_79b9u32;
    let n = r.tracks.len();
    for (i, t) in r.tracks.iter().enumerate() {
        if cancelled() { return Err("cancelled".into()); }
        progress(i as f64 / n.max(1) as f64, &format!("Saving track {} of {n}", i + 1));
        let a = (t.start.max(0.0) * rate as f64) as u64; let b = ((t.end * rate as f64) as u64).min(wav.frames); if b <= a { return Err(format!("track {} has no length", t.number)); }
        let mut x = wav.read(a, b - a)?;
        let clicks = if r.declick { declick(&mut x, ch, rate, &Settings::default()) } else { vec![] };
        let fade = (rate as usize / 200).min(x.len() / ch / 4); let frames = x.len() / ch;
        for k in 0..fade { let g = k as f32 / fade as f32; for c in 0..ch { x[k * ch + c] *= g; x[(frames - 1 - k) * ch + c] *= g; } }
        let pcm = quantize(&x, r.bits, &mut seed); drop(x);
        let bytes = encode_flac(&pcm, ch, r.bits as usize, rate as usize)?; drop(pcm);
        let dest = Path::new(&r.dest).join(render(r, t)).with_extension("flac");
        if let Some(d) = dest.parent() { std::fs::create_dir_all(d).map_err(|e| format!("{}: {e}", d.display()))?; }
        let tmp = dest.with_file_name(format!(".bootleg-capture-{}", dest.file_name().unwrap().to_string_lossy()));
        std::fs::write(&tmp, &bytes).map_err(|e| format!("{}: {e}", tmp.display()))?;
        if let Err(e) = tag(&tmp, r, t, n) { let _ = std::fs::remove_file(&tmp); return Err(e); }
        std::fs::rename(&tmp, &dest).map_err(|e| { let _ = std::fs::remove_file(&tmp); format!("{}: {e}", dest.display()) })?;
        out.push(Saved { path: dest.to_string_lossy().into(), number: t.number, title: t.title.clone(), seconds: (b - a) as f64 / rate as f64, clicks: clicks.len(), click_times: clicks.iter().take(500).map(|c| c.frame as f64 / rate as f64).collect() });
    }
    progress(1.0, "Saved"); Ok(out)
}

fn tag(path: &Path, r: &SaveRequest, t: &TrackSpec, total: usize) -> Result<(), String> {
    use lofty::{config::WriteOptions, prelude::*, probe::Probe, tag::{ItemKey, Tag}};
    let mut tf = Probe::open(path).map_err(|e| format!("tags: {e}"))?.guess_file_type().map_err(|e| format!("tags: {e}"))?.read().map_err(|e| format!("tags: {e}"))?;
    if tf.primary_tag_mut().is_none() { let tt = tf.primary_tag_type(); tf.insert_tag(Tag::new(tt)); }
    let tag = tf.primary_tag_mut().ok_or("this format cannot hold tags")?;
    let mut set = |k: ItemKey, v: &str| { if !v.is_empty() { tag.insert_text(k, v.to_string()); } };
    set(ItemKey::TrackTitle, &t.title); set(ItemKey::TrackArtist, if t.artist.is_empty() { &r.album_artist } else { &t.artist }); set(ItemKey::AlbumTitle, &r.album); set(ItemKey::AlbumArtist, &r.album_artist);
    set(ItemKey::RecordingDate, &r.year); set(ItemKey::Genre, &r.genre); set(ItemKey::TrackNumber, &t.number.to_string()); set(ItemKey::TrackTotal, &total.to_string());
    if r.disc > 0 { set(ItemKey::DiscNumber, &r.disc.to_string()); }
    let from = match r.source.as_str() { "vinyl" => "vinyl", "tape" => "tape", _ => "an analogue source" };
    set(ItemKey::Comment, &format!("Recorded from {from}{} with bootleg", if r.device.is_empty() { String::new() } else { format!(" ({})", r.device) }));
    set(ItemKey::EncodedBy, "bootleg capture");
    tf.save_to_path(path, WriteOptions::default()).map_err(|e| format!("tags: {e}"))
}
