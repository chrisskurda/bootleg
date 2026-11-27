// The checks against real files: generated here (always), and made with ffmpeg where it is installed (CI has it).
use bootleg_plugin_cd::{accuraterip::checksums, output::encode_flac};
use bootleg_plugin_checker::{album, analyze::cutoff, cache::Cache, decode::check, run::{self, Hooks, Out, Request}};
use std::{path::{Path, PathBuf}, process::Command};

fn dir(name: &str) -> PathBuf { let d = std::env::temp_dir().join(format!("bootleg-checker-{name}-{}", std::process::id())); let _ = std::fs::remove_dir_all(&d); std::fs::create_dir_all(&d).unwrap(); d }
/// "Music": a few tones plus noise across the whole band, 16-bit stereo 44.1 kHz little-endian PCM.
fn music(secs: f64, seed: u32) -> Vec<u8> {
    let n = (44_100.0 * secs) as usize; let mut x = seed.max(1); let mut out = Vec::with_capacity(n * 4);
    for i in 0..n {
        let t = i as f64 / 44_100.0; x ^= x << 13; x ^= x >> 17; x ^= x << 5;
        let noise = (x as f64 / u32::MAX as f64 - 0.5) * 0.2;
        let v = 0.25 * (2.0 * std::f64::consts::PI * 220.0 * t).sin() + 0.15 * (2.0 * std::f64::consts::PI * 1760.0 * t).sin() + noise;
        let s = (v * 32767.0) as i16; out.extend_from_slice(&s.to_le_bytes()); out.extend_from_slice(&((s as i32 * 9 / 10) as i16).to_le_bytes());
    }
    out
}
fn write_flac(p: &Path, pcm: &[u8]) { std::fs::write(p, encode_flac(pcm).unwrap()).unwrap(); }
fn ffmpeg(args: &[&str]) -> bool { Command::new("ffmpeg").args(["-v", "error", "-y"]).args(args).status().map(|s| s.success()).unwrap_or(false) }
fn have_ffmpeg() -> bool { Command::new("ffmpeg").arg("-version").output().is_ok() }

#[test]
fn a_clean_flac_passes_everything() {
    let d = dir("clean"); let p = d.join("clean.flac"); write_flac(&p, &music(8.0, 7));
    let c = check(&p).unwrap();
    assert_eq!(c.md5.as_deref(), Some("ok")); assert!(c.damage.is_empty() && !c.truncated && c.lossless);
    assert_eq!((c.rate, c.channels, c.bits, c.measures.used_bits), (44_100, 2, 16, 16));
    let s = c.measures.spectrum.unwrap(); assert!(s.cutoff_hz > 20_000.0, "full band: {s:?}");
    assert_eq!(c.measures.clip_runs, 0); assert!(c.measures.dr.is_some()); assert!(c.measures.ar.is_some());
}

#[test]
fn damage_and_truncation_are_found() {
    let d = dir("damage"); let good = encode_flac(&music(10.0, 3)).unwrap();
    let mut bad = good.clone(); let mid = bad.len() / 2; for b in &mut bad[mid..mid + 64] { *b ^= 0x5a; }
    let p = d.join("bad.flac"); std::fs::write(&p, &bad).unwrap();
    let c = check(&p).unwrap();
    assert!(c.decode_error.is_some() && !c.damage.is_empty(), "{c:?}"); assert_eq!(c.md5.as_deref(), Some("mismatch"));
    assert!(c.damage[0].start > 2.0 && c.damage[0].start < 8.0, "located: {:?}", c.damage);
    let t = d.join("short.flac"); std::fs::write(&t, &good[..good.len() * 2 / 3]).unwrap();
    let c = check(&t).unwrap(); assert!(!c.damage.is_empty() && c.damage[0].end > 9.9, "{:?}", c.damage);
}

#[test]
fn a_lowpass_cliff_is_found_and_a_natural_rolloff_is_not() {
    // dB per FFT bin: flat music to 16 kHz then a 60 dB cliff (an MP3 encoder's lowpass) …
    let bins = 2048; let hz = |i: usize| i as f64 * 44_100.0 / 4096.0;
    let cliff: Vec<f64> = (0..bins).map(|i| if hz(i) < 16_000.0 { -20.0 - hz(i) / 2000.0 } else { -100.0 }).collect();
    let s = cutoff(&cliff, 44_100); assert!(s.steep && (15_500.0..16_500.0).contains(&s.cutoff_hz), "{s:?}");
    // … and an old recording that simply fades out towards the top
    let fade: Vec<f64> = (0..bins).map(|i| -20.0 - hz(i) / 250.0).collect();
    let s = cutoff(&fade, 44_100); assert!(!s.steep, "{s:?}");
}

#[test]
fn ffmpeg_made_fakes() {
    if !have_ffmpeg() { eprintln!("ffmpeg not installed: skipped"); return; }
    let d = dir("fakes"); let src = d.join("src.flac"); write_flac(&src, &music(12.0, 11));
    let (mp3, fake) = (d.join("a.mp3"), d.join("fake.flac"));
    assert!(ffmpeg(&["-i", src.to_str().unwrap(), "-c:a", "libmp3lame", "-b:a", "128k", mp3.to_str().unwrap()]));
    assert!(ffmpeg(&["-i", mp3.to_str().unwrap(), "-c:a", "flac", fake.to_str().unwrap()]));
    let c = check(&fake).unwrap(); let s = c.measures.spectrum.clone().unwrap(); eprintln!("128k MP3 in FLAC: cutoff {} Hz, drop {} dB", s.cutoff_hz, s.drop_db);
    assert!(c.lossless && s.steep && s.cutoff_hz < 18_000.0, "a 128 kbps MP3 in a FLAC: {s:?} {:?}", s.bands.iter().map(|b| *b as i32).collect::<Vec<_>>());
    let m = check(&mp3).unwrap(); assert!(!m.lossless && m.damage.is_empty(), "{m:?}");
    // upsampled 44.1 → 96 kHz
    let up = d.join("up.flac"); assert!(ffmpeg(&["-i", src.to_str().unwrap(), "-ar", "96000", "-c:a", "flac", up.to_str().unwrap()]));
    let c = check(&up).unwrap(); let s = c.measures.spectrum.unwrap(); eprintln!("44.1 → 96 kHz: cutoff {} Hz, drop {} dB", s.cutoff_hz, s.drop_db); assert!(c.rate == 96_000 && s.steep && s.cutoff_hz < 23_000.0, "{s:?}");
    // 16-bit audio in a 24-bit file
    let pad = d.join("pad.flac"); assert!(ffmpeg(&["-i", src.to_str().unwrap(), "-sample_fmt", "s32", "-bits_per_raw_sample", "24", "-c:a", "flac", pad.to_str().unwrap()]));
    let c = check(&pad).unwrap(); assert_eq!((c.bits, c.measures.used_bits), (24, 16));
    // a damaged MP3: symphonia carries on and says where
    let mut b = std::fs::read(&mp3).unwrap(); let mid = b.len() / 2; for x in &mut b[mid..mid + 2000] { *x = 0; } let bad = d.join("bad.mp3"); std::fs::write(&bad, &b).unwrap();
    let c = check(&bad).unwrap(); assert!(c.seconds > 10.0, "decoding went on past the damage: {c:?}");
}

#[test]
fn accuraterip_for_an_album_in_the_library() {
    let d = dir("album"); let lens = [588 * 400, 588 * 300, 588 * 500];
    let mut paths = vec![]; let mut frames = vec![];
    for (i, &n) in lens.iter().enumerate() {
        let pcm = music(n as f64 / 44_100.0, 100 + i as u32); assert_eq!(pcm.len(), n * 4);
        let p = d.join(format!("{:02}.flac", i + 1)); write_flac(&p, &pcm); paths.push(p.to_string_lossy().to_string());
        frames.push(pcm.chunks_exact(4).map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect::<Vec<u32>>());
    }
    let toc = album::toc_from(&lens.iter().map(|&n| n as u64).collect::<Vec<_>>()).unwrap(); let (i1, i2) = toc.accuraterip_ids();
    let db = |good: bool| { let mut b = vec![3u8]; for v in [i1, i2, toc.cddb_id()] { b.extend(v.to_le_bytes()); }
        for (k, f) in frames.iter().enumerate() { let (_, v2) = checksums(f, k == 0, k == 2); b.push(12); b.extend((if good || k != 1 { v2 } else { v2 ^ 1 }).to_le_bytes()); b.extend(0u32.to_le_bytes()); } b };
    for good in [true, false] {
        let mut outs = vec![]; let mut cache = Cache::default(); let expect_path = toc.accuraterip_path();
        let fetch = |p: &str| { assert_eq!(p, expect_path); Some(Some(db(good))) };
        let req = Request { files: paths.clone(), albums: vec![paths.clone()], accuraterip: true, ..Default::default() };
        let sum = run::run(&req, &mut cache, &mut Hooks { emit: &mut |o| outs.push(o), progress: &mut |_, _| {}, cancelled: &|| false, fetch: &fetch });
        assert_eq!((sum.files, sum.read, sum.failed, sum.albums), (3, 3, 0, 1));
        let Some(Out::Album { check, .. }) = outs.iter().find(|o| matches!(o, Out::Album { .. })) else { panic!() };
        assert_eq!(check.state, "checked");
        let m: Vec<_> = check.tracks.iter().map(|t| t.matched.is_some()).collect();
        assert_eq!(m, if good { vec![true, true, true] } else { vec![true, false, true] });
        // a second run reads nothing
        let mut n = 0; let s2 = run::run(&req, &mut cache, &mut Hooks { emit: &mut |_| n += 1, progress: &mut |_, _| {}, cancelled: &|| false, fetch: &fetch });
        assert_eq!((s2.read, s2.cached), (0, 3));
    }
    // not whole sectors: not a CD rip
    assert!(album::toc_from(&[588 * 10 + 1]).is_err());
}
