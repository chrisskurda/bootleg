use bootleg_plugin_capture::{analyze::{analyze, suggest}, backend::{sim::Sim, Backend}, declick::{declick, Settings}, record::{record, Hooks}, save::{save, SaveRequest, TrackSpec}, wav::Writer};
use std::path::PathBuf;

fn dir(n: &str) -> PathBuf { let d = std::env::temp_dir().join(format!("bootleg-capture-{n}-{}", std::process::id())); let _ = std::fs::remove_dir_all(&d); std::fs::create_dir_all(&d).unwrap(); d }
struct Rng(u32); impl Rng { fn next(&mut self) -> f32 { self.0 ^= self.0 << 13; self.0 ^= self.0 >> 17; self.0 ^= self.0 << 5; self.0 as f32 / u32::MAX as f32 - 0.5 } }
/// "Music" (stereo): two tones that change every half second, plus a little noise.
fn music(secs: f64, rate: u32, amp: f32, rng: &mut Rng) -> Vec<f32> {
    let n = (secs * rate as f64) as usize; let mut v = Vec::with_capacity(n * 2);
    for i in 0..n { let t = i as f32 / rate as f32; let k = (t * 2.0) as u32 % 5; let f = 220.0 * (1.0 + k as f32 * 0.25);
        let s = amp * (0.6 * (2.0 * std::f32::consts::PI * f * t).sin() + 0.3 * (2.0 * std::f32::consts::PI * f * 3.0 * t).sin()) + rng.next() * 0.01; v.push(s); v.push(s * 0.9); }
    v
}
fn surface(secs: f64, rate: u32, rng: &mut Rng) -> Vec<f32> { (0..(secs * rate as f64) as usize * 2).map(|_| rng.next() * 0.004).collect() }
fn clicks(x: &mut [f32], rate: u32, every: f64, rng: &mut Rng) -> usize { let mut n = 0; let step = (every * rate as f64) as usize; let mut i = step / 2; while i + 8 < x.len() / 2 { let a = if rng.next() > 0.0 { 0.6 } else { -0.6 }; for k in 0..5 { x[(i + k) * 2] += a * (1.0 - k as f32 / 5.0); x[(i + k) * 2 + 1] += a * 0.8 * (1.0 - k as f32 / 5.0); } n += 1; i += step; } n }

#[test]
fn clicks_are_found_and_repaired_and_music_is_left_alone() {
    let rate = 48_000; let mut r = Rng(7); let clean = music(10.0, rate, 0.3, &mut r);
    let mut x = clean.clone(); let added = clicks(&mut x, rate, 0.25, &mut r);
    let found = declick(&mut x, 2, rate, &Settings::default());
    let left: Vec<_> = found.iter().collect::<Vec<_>>(); let per_ch = left.len() / 2;
    assert!(per_ch * 10 >= added * 9, "found {per_ch} of {added} per channel");
    let worst = x.iter().zip(&clean).map(|(a, b)| (a - b).abs()).fold(0f32, f32::max); assert!(worst < 0.08, "repaired close to the original: worst {worst}");
    let mut c2 = clean.clone(); assert!(declick(&mut c2, 2, rate, &Settings::default()).is_empty(), "nothing found in clean music"); assert_eq!(c2, clean);
    // sharp attacks out of silence (drum-like noise bursts) are music, not clicks
    let mut drums = vec![0f32; rate as usize * 4]; let dl = drums.len(); for b in 0..8 { let s = b * rate as usize / 2; for k in 0..4000 { let v = r.next() * 0.8 * (1.0 - k as f32 / 4000.0); drums[(s + k) * 2 % dl] = v; drums[((s + k) * 2 + 1) % dl] = v; } }
    let before = drums.clone(); let found = declick(&mut drums, 2, rate, &Settings::default()); assert!(found.len() <= 2, "{} false clicks on drum hits", found.len()); assert!(before.iter().zip(&drums).filter(|(a, b)| a != b).count() < 50);
}

#[test]
fn splits_fall_in_the_gaps_and_short_bits_are_merged() {
    let mut rms = vec![]; let mut add = |secs: f64, db: f32| for _ in 0..(secs / 0.05) as usize { rms.push(db) };
    add(2.0, -60.0); add(120.0, -18.0); add(2.0, -57.0); add(90.0, -20.0); add(1.5, -58.0); add(5.0, -22.0); add(2.0, -58.0); add(100.0, -19.0); add(10.0, -61.0);
    let total = rms.len() as f64 * 0.05; let (start, end, splits, _, _) = suggest(&rms, total);
    assert!((start - 1.7).abs() < 0.1 && (end - 323.0).abs() < 0.2, "{start} {end}");
    assert_eq!(splits.len(), 2, "{splits:?}"); assert!((splits[0] - 123.0).abs() < 0.2, "{splits:?}");
}

#[test]
fn record_a_side_from_the_simulated_turntable_and_save_its_tracks() {
    let d = dir("e2e"); let sim = d.join("sim"); std::fs::create_dir_all(&sim).unwrap(); let rate = 44_100; let mut r = Rng(3);
    let mut side = surface(1.5, rate, &mut r); for (i, len) in [25.0, 30.0, 22.0].iter().enumerate() { side.extend(music(*len, rate, 0.25 + i as f32 * 0.05, &mut r)); side.extend(surface(2.0, rate, &mut r)); }
    side.extend(surface(4.0, rate, &mut r)); let n_clicks = clicks(&mut side, rate, 1.3, &mut r);
    let mut w = Writer::create(&sim.join("Turntable.wav"), rate, 2).unwrap(); w.write(&side).unwrap(); w.finish().unwrap();
    let b = Sim::new(sim.clone(), 400.0); let devs = b.devices().unwrap(); assert_eq!(devs[0].id, "sim:Turntable");
    let raw = d.join("side-a.wav"); let mut lv = 0;
    let rec = record(&b, "sim:Turntable", 0, &raw, &mut Hooks { levels: &mut |_| lv += 1, finish: &|| false, cancelled: &|| false }).unwrap();
    assert!((rec.seconds - side.len() as f64 / 2.0 / rate as f64).abs() < 0.05 && lv > 100 && rec.ended == "the input ended", "{rec:?} levels {lv}");
    let a = analyze(&raw, 800).unwrap(); assert_eq!(a.splits.len(), 2, "{:?}", a.splits);
    for (s, want) in a.splits.iter().zip([1.5 + 25.0 + 1.0, 1.5 + 25.0 + 2.0 + 30.0 + 1.0]) { assert!((s - want).abs() < 0.6, "split {s} vs {want}"); }
    assert!(a.start > 1.0 && a.start < 1.6 && a.overview.len() >= 790, "start {} overview {}", a.start, a.overview.len());
    let mut edges = vec![a.start]; edges.extend(&a.splits); edges.push(a.end);
    let tracks: Vec<_> = edges.windows(2).enumerate().map(|(i, w)| TrackSpec { start: w[0], end: w[1], number: i as u32 + 1, title: format!("Song {}", i + 1), artist: String::new() }).collect();
    let out = d.join("Library"); let req = SaveRequest { recording: raw.to_string_lossy().into(), dest: out.to_string_lossy().into(), album: "Side A".into(), album_artist: "The Band".into(), year: "1977".into(), tracks, device: "Sim deck".into(), ..Default::default() };
    let saved = save(&req, &mut |_, _| {}, &|| false).unwrap();
    assert_eq!(saved.len(), 3); let total: usize = saved.iter().map(|s| s.clicks).sum(); assert!(total >= n_clicks, "clicks repaired {total} (added {n_clicks}, both channels)");
    let f = &saved[1]; assert!(std::path::Path::new(&f.path).ends_with("The Band/Side A/02 Song 2.flac"), "{}", f.path);      // (by components: \ on Windows)
    let fr = claxon::FlacReader::open(&f.path).unwrap(); assert_eq!((fr.streaminfo().bits_per_sample, fr.streaminfo().sample_rate), (24, 44_100));
    use lofty::{prelude::*, probe::Probe}; let tf = Probe::open(&f.path).unwrap().read().unwrap(); let t = tf.primary_tag().unwrap();
    assert_eq!(t.title().as_deref(), Some("Song 2")); assert_eq!(t.artist().as_deref(), Some("The Band")); assert!(t.comment().unwrap().contains("vinyl (Sim deck)"));
    // cancelling a recording deletes it
    let raw2 = d.join("cancelled.wav"); let mut n = 0; let stop = std::cell::Cell::new(0);
    let r2 = record(&b, "sim:Turntable", 0, &raw2, &mut Hooks { levels: &mut |_| n += 1, finish: &|| false, cancelled: &|| { stop.set(stop.get() + 1); stop.get() > 5 } });
    assert!(r2.is_err() && !raw2.exists());
}

/// The real inputs on this machine (lists them only; nothing is opened or recorded): `cargo test -- --ignored`
#[test]
#[ignore]
fn list_system_inputs() {
    let d = bootleg_plugin_capture::backend::system::System.devices().unwrap();
    for x in &d { eprintln!("{} default={} rates={:?} ch={} default_rate={}", x.name, x.default, x.rates, x.channels, x.default_rate); }
}
