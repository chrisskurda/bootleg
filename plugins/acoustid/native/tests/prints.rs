use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use bootleg_plugin_acoustid::{fingerprint_file, fingerprint_samples, encode};
use rusty_chromaprint::{match_fingerprints, Configuration};

fn tune(secs: f64, rate: u32, seed: u32, shift: f64) -> Vec<i16> {
    // a little "melody": notes changing every 250 ms, so the chroma moves
    let notes = [261.6, 293.7, 329.6, 349.2, 392.0, 440.0, 493.9, 523.3]; let mut x = seed;
    let n = (secs * rate as f64) as usize; let mut out = Vec::with_capacity(n * 2); let mut f = 440.0;
    for i in 0..n { if i % (rate as usize / 4) == 0 { x = x.wrapping_mul(1103515245).wrapping_add(12345); f = notes[(x >> 16) as usize % 8] * shift; }
        let v = ((2.0 * std::f64::consts::PI * f * i as f64 / rate as f64).sin() * 12000.0) as i16; out.push(v); out.push(v); }
    out
}
fn wav(path: &std::path::Path, s: &[i16], rate: u32) {
    let data: Vec<u8> = s.iter().flat_map(|v| v.to_le_bytes()).collect(); let mut b = vec![];
    b.extend(b"RIFF"); b.extend((36 + data.len() as u32).to_le_bytes()); b.extend(b"WAVEfmt "); b.extend(16u32.to_le_bytes()); b.extend(1u16.to_le_bytes()); b.extend(2u16.to_le_bytes());
    b.extend(rate.to_le_bytes()); b.extend((rate * 4).to_le_bytes()); b.extend(4u16.to_le_bytes()); b.extend(16u16.to_le_bytes()); b.extend(b"data"); b.extend((data.len() as u32).to_le_bytes()); b.extend(data);
    std::fs::write(path, b).unwrap();
}

#[test]
fn the_same_tune_matches_and_a_different_one_does_not() {
    let a = fingerprint_samples(&tune(30.0, 44_100, 1, 1.0), 44_100, 2).unwrap();
    let a2 = fingerprint_samples(&tune(30.0, 48_000, 1, 1.0), 48_000, 2).unwrap();       // the same tune at another rate
    let b = fingerprint_samples(&tune(30.0, 44_100, 99, 1.0), 44_100, 2).unwrap();
    let c = Configuration::preset_test2();
    let same = match_fingerprints(&a, &a2, &c).unwrap(); let diff = match_fingerprints(&a, &b, &c).unwrap();
    assert!(same.iter().any(|s| s.items_count > 150 && s.score < 5.0), "the same tune at another rate matches: {same:?}");
    assert!(diff.is_empty(), "a different tune does not: {diff:?}");
}

#[test]
fn a_file_gives_a_compressed_print_and_its_length() {
    let d = std::env::temp_dir().join(format!("bootleg-acoustid-{}", std::process::id())); std::fs::create_dir_all(&d).unwrap();
    let p = d.join("t.wav"); wav(&p, &tune(150.0, 44_100, 5, 1.0), 44_100);
    let fp = fingerprint_file(&p).unwrap();
    assert_eq!(fp.duration, 150.0, "the whole length, though only 120 s are fingerprinted");
    let raw = URL_SAFE_NO_PAD.decode(&fp.fingerprint).unwrap();
    assert_eq!(raw[0], 1, "algorithm 1 (Chromaprint's default, test2)");
    let n = (raw[1] as usize) << 16 | (raw[2] as usize) << 8 | raw[3] as usize;
    let direct = fingerprint_samples(&tune(120.0, 44_100, 5, 1.0), 44_100, 2).unwrap();
    assert_eq!(n, direct.len(), "120 s worth of sub-fingerprints"); assert_eq!(fp.fingerprint, encode(&direct, &Configuration::preset_test2()));
    assert!(fingerprint_file(&d.join("missing.wav")).is_err());
}
