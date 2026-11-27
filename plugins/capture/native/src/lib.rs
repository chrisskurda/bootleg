// bootleg capture plugin, native part (plugin spec 2.0 §5). Design: docs/plugins/CAPTURE.md.
//   backend  audio inputs: system (cpal) and sim (WAV files played as if from a turntable)
//   wav      float WAV written while recording, read back a stretch at a time
//   record   a recording, with levels
//   analyze  an overview, and where the tracks probably are (the quiet gaps)
//   declick  click removal
//   save     tracks: declick, fades, dither, FLAC, tags
//   plugin   (feature "tauri") the Tauri plugin `bootleg-capture`
pub mod analyze;
pub mod backend;
pub mod declick;
pub mod record;
pub mod save;
pub mod wav;
#[cfg(feature = "tauri")] pub mod plugin;
#[cfg(feature = "tauri")] pub use plugin::init;
