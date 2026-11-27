// bootleg AcoustID plugin, native part (plugin spec 2.0 §5): Chromaprint-compatible fingerprints of audio files.
// No platform-specific code, so no backend trait or simulator (spec §7); tested on generated audio.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rusty_chromaprint::{Configuration, FingerprintCompressor, Fingerprinter};
use serde::Serialize;
use std::{fs::File, path::Path};

/// AcoustID matches on the first two minutes, as `fpcalc` does by default.
pub const MAX_SECONDS: f64 = 120.0;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Print {
    /// The whole track's length in seconds (AcoustID needs it), not just the part fingerprinted.
    pub duration: f64,
    /// Compressed and base64 (URL-safe, no padding), as `fpcalc` prints it and the AcoustID API takes it.
    pub fingerprint: String,
}

pub fn encode(raw: &[u32], config: &Configuration) -> String { URL_SAFE_NO_PAD.encode(FingerprintCompressor::from(config).compress(raw)) }

/// Fingerprint interleaved 16-bit samples (for tests and callers that already have audio).
pub fn fingerprint_samples(samples: &[i16], rate: u32, channels: u32) -> Result<Vec<u32>, String> {
    let config = Configuration::preset_test2(); let mut p = Fingerprinter::new(&config);
    p.start(rate, channels).map_err(|e| format!("{e:?}"))?; p.consume(samples); p.finish(); Ok(p.fingerprint().to_vec())
}

pub fn fingerprint_file(path: &Path) -> Result<Print, String> {
    use symphonia::core::{audio::SampleBuffer, codecs::{DecoderOptions, CODEC_TYPE_NULL}, errors::Error, formats::FormatOptions, io::MediaSourceStream, meta::MetadataOptions, probe::Hint};
    let f = File::open(path).map_err(|e| e.to_string())?;
    let mut hint = Hint::new(); if let Some(e) = path.extension().and_then(|e| e.to_str()) { hint.with_extension(e); }
    let probed = symphonia::default::get_probe().format(&hint, MediaSourceStream::new(Box::new(f), Default::default()), &FormatOptions::default(), &MetadataOptions::default()).map_err(|e| format!("not a readable audio file: {e}"))?;
    let mut fmt = probed.format;
    let track = fmt.tracks().iter().find(|t| t.codec_params.codec != CODEC_TYPE_NULL).ok_or("no audio track")?.clone();
    let rate = track.codec_params.sample_rate.ok_or("no sample rate")?; let ch = track.codec_params.channels.map(|c| c.count()).unwrap_or(2) as u32;
    let mut dec = symphonia::default::get_codecs().make(&track.codec_params, &DecoderOptions::default()).map_err(|e| e.to_string())?;
    let config = Configuration::preset_test2(); let mut p = Fingerprinter::new(&config); p.start(rate, ch).map_err(|e| format!("{e:?}"))?;
    let limit = (MAX_SECONDS * rate as f64) as u64; let mut fed = 0u64; let mut sb: Option<SampleBuffer<i16>> = None;
    loop {
        let pkt = match fmt.next_packet() { Ok(p) => p, Err(Error::IoError(_)) | Err(Error::ResetRequired) => break, Err(e) => return Err(e.to_string()) };
        if pkt.track_id() != track.id { continue; }
        if fed >= limit { continue; }      // keep reading packets only to learn the length when the header doesn't say
        match dec.decode(&pkt) {
            Ok(buf) => {
                let spec = *buf.spec(); if sb.as_ref().map_or(true, |s| s.capacity() < buf.capacity()) { sb = Some(SampleBuffer::new(buf.capacity() as u64, spec)); }
                let s = sb.as_mut().unwrap(); s.copy_interleaved_ref(buf);
                let frames = (s.samples().len() as u64 / ch as u64).min(limit - fed); p.consume(&s.samples()[..(frames * ch as u64) as usize]); fed += frames;
            }
            Err(Error::DecodeError(_)) => continue,
            Err(e) => return Err(e.to_string()),
        }
        if fed >= limit && track.codec_params.n_frames.is_some() { break; }
    }
    p.finish();
    if p.fingerprint().is_empty() { return Err("too short to fingerprint".into()); }
    let duration = track.codec_params.n_frames.map(|n| n as f64 / rate as f64).unwrap_or(fed as f64 / rate as f64);
    Ok(Print { duration: duration.round(), fingerprint: encode(p.fingerprint(), &config) })
}

#[cfg(feature = "tauri")] pub mod plugin;
#[cfg(feature = "tauri")] pub use plugin::init;
