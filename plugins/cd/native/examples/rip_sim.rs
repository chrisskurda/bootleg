// cargo run --example rip_sim -- <sim dir> <drive id> <out dir>: rip a simulated disc with the engine, print the outcome.
use bootleg_plugin_cd::{backend::{sim::SimBackend, Backend}, rip::{rip, RipRequest}, secure::{Hooks, SecureSettings}};
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let b = SimBackend::from_dir(&a[1]); let mut d = b.open(&a[2]).expect("drive");
    let req = RipRequest { dest: a[3].clone(), secure: SecureSettings { offset: 6, cache_defeat: 80, ..Default::default() }, ..Default::default() };
    let (mut p, c, mut l) = (|_: f64, _: &str| {}, || false, |s: &str| eprintln!("  {s}")); let mut h = Hooks { progress: &mut p, cancelled: &c, log: &mut l };
    let t0 = std::time::Instant::now(); let r = rip(d.as_mut(), &req, &mut h).expect("rip");
    for t in &r.tracks { println!("track {} {:?} unreadable {} uncertain {} reads(max) {} defects {:?}", t.number, t.status, t.unreadable, t.uncertain, t.max_reads, t.defects.iter().map(|d| (d.kind, (d.start * 100.0).round() / 100.0)).collect::<Vec<_>>()); }
    println!("{} in {:?}\nlog: {}", r.summary, t0.elapsed(), r.log);
}
