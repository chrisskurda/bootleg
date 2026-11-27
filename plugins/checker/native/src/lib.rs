// bootleg library checker, native part (plugin spec 2.0 §5). Design: docs/plugins/CHECKER.md.
//   analyze  one pass over the samples: peak, clipping, DR, spectrum cutoff, bits used, AccurateRip sums
//   decode   FLAC (claxon: frame CRCs + the stored MD5) and everything else (symphonia), with damage located
//   album    AccurateRip for rips already in the library, from the track lengths
//   cache    results kept between runs
//   run      a whole check: files on a few threads, then albums
//   plugin   (feature "tauri") the Tauri plugin `bootleg-checker`
// There is no platform-specific code, so no backend trait or simulator (spec §7): the tests run on generated files.
pub mod album;
pub mod analyze;
pub mod cache;
pub mod decode;
pub mod run;
#[cfg(feature = "tauri")] pub mod plugin;
#[cfg(feature = "tauri")] pub use plugin::init;
