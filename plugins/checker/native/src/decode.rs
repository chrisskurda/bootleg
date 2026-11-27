// Decoding one file all the way through and measuring it (analyze.rs). FLAC goes through claxon, which checks every
// frame's CRC; its MD5 of the audio is checked against the one the encoder stored. Everything else goes through
// symphonia, which carries on past damaged packets so the damage can be located.
use crate::analyze::{Analyzer, Measures};
use md5::{Digest, Md5};
use serde::{Deserialize, Serialize};
use std::{fs::File, path::Path};

/// Bump when the checks change, so cached results are redone.
pub const VERSION: u32 = 1;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Damage { pub start: f64, pub end: f64, pub detail: String }

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileCheck {
    pub format: String, pub codec: String, pub lossless: bool,
    pub rate: u32, pub channels: usize, pub bits: u32,
    pub seconds: f64, pub expected_seconds: Option<f64>,
    /// Stretches that could not be decoded, and a short tail that is missing.
    pub damage: Vec<Damage>, pub truncated: bool,
    /// FLAC only: "ok", "mismatch", or "unset" (the encoder stored none).
    #[serde(skip_serializing_if = "Option::is_none")] pub md5: Option<String>,
    pub decode_error: Option<String>,
    pub measures: Measures,
}

pub fn check(path: &Path) -> Result<FileCheck, String> {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    if ext == "flac" { flac(path) } else { other(path, &ext) }
}

fn flac(path: &Path) -> Result<FileCheck, String> {
    let mut r = claxon::FlacReader::open(path).map_err(|e| format!("not a readable FLAC file: {e}"))?;
    let si = r.streaminfo(); let (rate, ch, bits) = (si.sample_rate, si.channels as usize, si.bits_per_sample);
    let mut a = Analyzer::new(ch, rate, bits, si.samples);
    let shift = 32 - bits; let bytes = bits.div_ceil(8) as usize;
    let mut md5 = Md5::new(); let mut inter: Vec<i32> = vec![]; let mut raw: Vec<u8> = vec![];
    let mut frames = r.blocks(); let mut buf = vec![]; let mut err = None;
    loop {
        match frames.read_next_or_eof(buf) {
            Ok(Some(b)) => {
                let n = b.duration() as usize; inter.clear(); raw.clear();
                for i in 0..n { for c in 0..ch as u32 { let s = b.sample(c, i as u32); inter.push(s << shift); raw.extend_from_slice(&s.to_le_bytes()[..bytes]); } }
                md5.update(&raw); a.push(&inter); buf = b.into_buffer();
            }
            Ok(None) => break,
            Err(e) => { err = Some(e.to_string()); break; }
        }
    }
    let got = a.frames; let measures = a.finish();
    let seconds = got as f64 / rate as f64; let expected = si.samples.filter(|&n| n > 0).map(|n| n as f64 / rate as f64);
    let mut damage = vec![]; let mut truncated = false;
    if let Some(e) = &err {
        // claxon can't find its way past a broken frame: everything after it is unknown (flac -F can often recover more)
        let end = expected.unwrap_or(seconds).max(seconds);
        damage.push(Damage { start: seconds, end, detail: format!("decoding stopped: {e}") });
    } else if let Some(exp) = expected { if (got as f64) < exp * rate as f64 - 1.0 { truncated = true; damage.push(Damage { start: seconds, end: exp, detail: "the file ends early".into() }); } }
    let md5_state = if si.md5sum == [0u8; 16] { "unset" } else if err.is_some() || truncated { "mismatch" } else if md5.finalize()[..] == si.md5sum { "ok" } else { "mismatch" };
    Ok(FileCheck { format: "flac".into(), codec: "FLAC".into(), lossless: true, rate, channels: ch, bits, seconds, expected_seconds: expected, damage, truncated, md5: Some(md5_state.into()), decode_error: err, measures })
}

fn other(path: &Path, ext: &str) -> Result<FileCheck, String> {
    use symphonia::core::{audio::SampleBuffer, codecs::{DecoderOptions, CODEC_TYPE_ALAC, CODEC_TYPE_FLAC, CODEC_TYPE_NULL}, errors::Error, formats::FormatOptions, io::MediaSourceStream, meta::MetadataOptions, probe::Hint};
    let f = File::open(path).map_err(|e| e.to_string())?;
    let mss = MediaSourceStream::new(Box::new(f), Default::default());
    let mut hint = Hint::new(); hint.with_extension(ext);
    let probed = symphonia::default::get_probe().format(&hint, mss, &FormatOptions { enable_gapless: true, ..Default::default() }, &MetadataOptions::default()).map_err(|e| format!("not a readable audio file: {e}"))?;
    let mut fmt = probed.format;
    let track = fmt.tracks().iter().find(|t| t.codec_params.codec != CODEC_TYPE_NULL).ok_or("no audio track")?.clone();
    let p = &track.codec_params;
    let codec = symphonia::default::get_codecs().get_codec(p.codec).map(|d| d.short_name.to_string()).unwrap_or_else(|| "?".into());
    let lossless = matches!(p.codec, CODEC_TYPE_FLAC | CODEC_TYPE_ALAC) || codec.starts_with("pcm");
    let rate = p.sample_rate.ok_or("no sample rate")?; let ch = p.channels.map(|c| c.count()).unwrap_or(2); let bits = p.bits_per_sample.unwrap_or(if lossless { 16 } else { 0 });
    let mut dec = symphonia::default::get_codecs().make(p, &DecoderOptions { verify: true }).map_err(|e| format!("can't decode {codec}: {e}"))?;
    let mut a = Analyzer::new(ch, rate, if lossless { bits } else { 0 }, p.n_frames);
    let mut damage: Vec<Damage> = vec![]; let mut stop = None; let mut sb: Option<SampleBuffer<i32>> = None;
    let bad_at = |t: f64, d: String, damage: &mut Vec<Damage>| { match damage.last_mut() { Some(last) if t - last.end < 0.5 => { last.end = t + 0.05; } _ => damage.push(Damage { start: t, end: t + 0.05, detail: d }) } };
    loop {
        let pkt = match fmt.next_packet() {
            Ok(p) => p,
            Err(Error::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(Error::ResetRequired) => break,
            Err(e) => { stop = Some(e.to_string()); break; }
        };
        if pkt.track_id() != track.id { continue; }
        let t = a.frames as f64 / rate as f64;
        match dec.decode(&pkt) {
            Ok(buf) => {
                let spec = *buf.spec(); let need = buf.capacity() as u64;
                if sb.as_ref().map_or(true, |s| s.capacity() < need as usize) { sb = Some(SampleBuffer::new(need, spec)); }
                let s = sb.as_mut().unwrap(); s.copy_interleaved_ref(buf);
                if spec.channels.count() == ch { a.push(s.samples()); }
            }
            Err(Error::DecodeError(e)) => bad_at(t, format!("damaged audio: {e}"), &mut damage),
            Err(Error::IoError(_)) => { bad_at(t, "the data runs out".into(), &mut damage); }
            Err(e) => { stop = Some(e.to_string()); break; }
        }
    }
    let got = a.frames; let measures = a.finish();
    let seconds = got as f64 / rate as f64; let expected = p.n_frames.filter(|&n| n > 0).map(|n| n as f64 / rate as f64);
    let mut truncated = false;
    if let Some(e) = &stop { damage.push(Damage { start: seconds, end: expected.unwrap_or(seconds).max(seconds), detail: format!("decoding stopped: {e}") }); }
    else if let Some(exp) = expected { if seconds < exp - 0.5 { truncated = true; damage.push(Damage { start: seconds, end: exp, detail: "the file ends early".into() }); } }
    Ok(FileCheck { format: ext.into(), codec, lossless, rate, channels: ch, bits, seconds, expected_seconds: expected, damage, truncated, md5: None, decode_error: stop, measures })
}
