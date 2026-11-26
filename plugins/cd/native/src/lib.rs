// bootleg CD plugin, native part (plugin spec 2.0 §5). Design: docs/plugins/CD.md.
//   toc         disc layout and ids (MusicBrainz, AccurateRip, CDDB)
//   backend     the platform contract; sim (always), macos (IOKit)
//   secure      secure reading (multi-pass, cache defeat, re-read rounds with slow-down) → sector map + damage
//   salvage     what fills damage, and the defects the library shows
//   accuraterip checksums and the database format
//   output      FLAC/WAV/AIFF, verification, tags, naming
//   rip         a whole rip, its cue sheet, log and playlist
//   plugin      (feature "tauri") the Tauri plugin `bootleg-cd`
pub mod accuraterip;
pub mod backend;
pub mod output;
pub mod rip;
pub mod salvage;
pub mod secure;
pub mod toc;
#[cfg(feature = "tauri")] pub mod plugin;
#[cfg(feature = "tauri")] pub use plugin::init;
