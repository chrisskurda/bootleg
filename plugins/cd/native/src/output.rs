// Writing the rip: audio files (FLAC by default, verified by decoding them back), tags, cover, cue sheet, playlist.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum Format { #[default] Flac, Wav, Aiff }
impl Format { pub fn ext(self) -> &'static str { match self { Format::Flac => "flac", Format::Wav => "wav", Format::Aiff => "aiff" } } }

/// Release metadata chosen on the Rip page (MusicBrainz, gnudb, CD-Text or typed in). Everything is optional.
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Meta {
    pub album: String, pub album_artist: String, pub date: String, pub genre: String, pub label: String, pub catalog: String, pub barcode: String,
    pub disc: u32, pub discs: u32, pub release_id: String, pub release_group_id: String, pub artist_id: String,
    pub cover_jpeg_base64: String,
    pub tracks: Vec<TrackMeta>,
}
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct TrackMeta { pub number: u8, pub title: String, pub artist: String, pub recording_id: String, pub track_id: String }

impl Meta {
    pub fn track(&self, n: u8) -> TrackMeta {
        let mut t = self.tracks.iter().find(|t| t.number == n).cloned().unwrap_or_default(); t.number = n;
        if t.title.is_empty() { t.title = format!("Track {n:02}"); }
        if t.artist.is_empty() { t.artist = self.album_artist.clone(); }
        t
    }
}

/// Keep names valid on every filesystem bootleg syncs to (FAT on players included).
pub fn safe(s: &str) -> String {
    let t: String = s.chars().map(|c| if "/\\:*?\"<>|".contains(c) || c.is_control() { '_' } else { c }).collect();
    let t = t.trim().trim_end_matches('.').trim().to_string(); if t.is_empty() { "_".into() } else { t.chars().take(120).collect() }
}
/// `{albumartist}/{album}/{track} {title}` — fields: albumartist artist album title track (2 digits) disc date year genre.
pub fn render(template: &str, m: &Meta, t: &TrackMeta) -> PathBuf {
    let year = m.date.get(..4).unwrap_or(""); let aa = if m.album_artist.is_empty() { "Unknown Artist" } else { &m.album_artist }; let al = if m.album.is_empty() { "Unknown Album" } else { &m.album };
    template.split('/').map(|part| {
        let mut s = part.to_string();
        for (k, v) in [("{albumartist}", aa.to_string()), ("{artist}", t.artist.clone()), ("{album}", al.to_string()), ("{title}", t.title.clone()), ("{track}", format!("{:02}", t.number)), ("{disc}", m.disc.max(1).to_string()), ("{date}", m.date.clone()), ("{year}", year.to_string()), ("{genre}", m.genre.clone())] { s = s.replace(k, &v); }
        safe(&s)
    }).collect()
}
pub const DEFAULT_TEMPLATE: &str = "{albumartist}/{album}/{track} {title}";

pub fn i32_samples(pcm: &[u8]) -> Vec<i32> { pcm.chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]]) as i32).collect() }

pub fn encode_flac(pcm: &[u8]) -> Result<Vec<u8>, String> {
    use flacenc::{component::BitRepr, error::Verify};
    let cfg = flacenc::config::Encoder::default().into_verified().map_err(|e| format!("{e:?}"))?;
    let src = flacenc::source::MemSource::from_samples(&i32_samples(pcm), 2, 16, 44_100);
    let stream = flacenc::encode_with_fixed_block_size(&cfg, src, cfg.block_size).map_err(|e| format!("FLAC encoding failed: {e:?}"))?;
    let mut sink = flacenc::bitsink::ByteSink::new(); stream.write(&mut sink).map_err(|e| format!("FLAC writing failed: {e:?}"))?;
    let mut f = sink.as_slice().to_vec();
    // flacenc marks STREAMINFO as the last metadata block; taggers that then append blocks without clearing that flag
    // (lofty 0.22 does) produce files decoders can't read. Clear it and end the metadata with padding instead, which
    // also leaves room for the tags without rewriting the audio.
    // flacenc also puts the short final block's size in STREAMINFO's minimum block size, which RFC 9639 says excludes
    // the last block; libFLAC then warns the file "might not be seekable". Fixed-blocksize stream: min = max.
    if f.len() > 42 && &f[..4] == b"fLaC" { let max = [f[10], f[11]]; f[8] = max[0]; f[9] = max[1]; }
    if f.len() > 42 && &f[..4] == b"fLaC" && f[4] & 0x7f == 0 {
        f[4] &= 0x7f; let pad = 8192u32; let mut block = vec![0x80 | 1, (pad >> 16) as u8, (pad >> 8) as u8, pad as u8]; block.resize(4 + pad as usize, 0);
        f.splice(42..42, block);
    }
    Ok(f)
}
/// Decode a FLAC file and compare it, sample for sample, with what was ripped.
pub fn verify_flac(bytes: &[u8], pcm: &[u8]) -> Result<(), String> {
    let mut r = claxon::FlacReader::new(std::io::Cursor::new(bytes)).map_err(|e| format!("cannot decode: {e}"))?;
    let want = i32_samples(pcm); let mut i = 0;
    for s in r.samples() { let s = s.map_err(|e| format!("decode error: {e}"))?; if want.get(i) != Some(&s) { return Err(format!("sample {} differs", i / 2)); } i += 1; }
    if i != want.len() { return Err(format!("{} samples decoded, {} expected", i / 2, want.len() / 2)); }
    Ok(())
}
pub fn wav(pcm: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(44 + pcm.len()); let n = pcm.len() as u32;
    v.extend(b"RIFF"); v.extend((36 + n).to_le_bytes()); v.extend(b"WAVEfmt "); v.extend(16u32.to_le_bytes()); v.extend(1u16.to_le_bytes()); v.extend(2u16.to_le_bytes());
    v.extend(44_100u32.to_le_bytes()); v.extend((44_100u32 * 4).to_le_bytes()); v.extend(4u16.to_le_bytes()); v.extend(16u16.to_le_bytes()); v.extend(b"data"); v.extend(n.to_le_bytes()); v.extend(pcm); v
}
pub fn aiff(pcm: &[u8]) -> Vec<u8> {
    let frames = (pcm.len() / 4) as u32; let mut v = vec![];
    v.extend(b"FORM"); v.extend((4 + 26 + 16 + pcm.len() as u32).to_be_bytes()); v.extend(b"AIFFCOMM"); v.extend(18u32.to_be_bytes()); v.extend(2u16.to_be_bytes()); v.extend(frames.to_be_bytes()); v.extend(16u16.to_be_bytes());
    v.extend([0x40, 0x0E, 0xAC, 0x44, 0, 0, 0, 0, 0, 0]); // 44100 as an 80-bit extended float
    v.extend(b"SSND"); v.extend((8 + pcm.len() as u32).to_be_bytes()); v.extend(0u32.to_be_bytes()); v.extend(0u32.to_be_bytes());
    v.extend(pcm.chunks_exact(2).flat_map(|c| [c[1], c[0]])); v
}

#[derive(Clone, Debug, Default)]
pub struct Extra { pub isrc: Option<String>, pub ar: String, pub tracks: u32, pub mb_disc_id: String }

/// Encode, verify, tag, and move into place atomically (a crash leaves no half-written file under the final name).
pub fn write_track(dest: &Path, format: Format, pcm: &[u8], m: &Meta, t: &TrackMeta, x: &Extra) -> Result<(), String> {
    let bytes = match format { Format::Flac => { let b = encode_flac(pcm)?; verify_flac(&b, pcm)?; b } Format::Wav => wav(pcm), Format::Aiff => aiff(pcm) };
    if let Some(dir) = dest.parent() { std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?; }
    let tmp = dest.with_file_name(format!(".bootleg-rip-{}", dest.file_name().unwrap().to_string_lossy()));
    std::fs::write(&tmp, &bytes).map_err(|e| format!("{}: {e}", tmp.display()))?;
    if let Err(e) = tag(&tmp, m, t, x) { let _ = std::fs::remove_file(&tmp); return Err(e); }
    std::fs::rename(&tmp, dest).map_err(|e| { let _ = std::fs::remove_file(&tmp); format!("{}: {e}", dest.display()) })
}

fn tag(path: &Path, m: &Meta, t: &TrackMeta, x: &Extra) -> Result<(), String> {
    use lofty::{config::WriteOptions, picture::{MimeType, Picture, PictureType}, prelude::*, probe::Probe, tag::{ItemKey, Tag}};
    let mut tf = Probe::open(path).map_err(|e| format!("tags: {e}"))?.guess_file_type().map_err(|e| format!("tags: {e}"))?.read().map_err(|e| format!("tags: {e}"))?;
    if tf.primary_tag_mut().is_none() { let tt = tf.primary_tag_type(); tf.insert_tag(Tag::new(tt)); }
    let tag = tf.primary_tag_mut().ok_or("this format cannot hold tags")?;
    let mut set = |k: ItemKey, v: &str| { if !v.is_empty() { tag.insert_text(k, v.to_string()); } };
    set(ItemKey::TrackTitle, &t.title); set(ItemKey::TrackArtist, &t.artist); set(ItemKey::AlbumTitle, &m.album); set(ItemKey::AlbumArtist, &m.album_artist);
    set(ItemKey::RecordingDate, &m.date); set(ItemKey::Genre, &m.genre); set(ItemKey::Label, &m.label); set(ItemKey::CatalogNumber, &m.catalog); set(ItemKey::Barcode, &m.barcode);
    set(ItemKey::TrackNumber, &t.number.to_string()); set(ItemKey::TrackTotal, &x.tracks.to_string());
    if m.disc > 0 { set(ItemKey::DiscNumber, &m.disc.to_string()); } if m.discs > 0 { set(ItemKey::DiscTotal, &m.discs.to_string()); }
    set(ItemKey::Isrc, x.isrc.as_deref().unwrap_or(""));
    set(ItemKey::MusicBrainzReleaseId, &m.release_id); set(ItemKey::MusicBrainzReleaseGroupId, &m.release_group_id); set(ItemKey::MusicBrainzReleaseArtistId, &m.artist_id);
    set(ItemKey::MusicBrainzRecordingId, &t.recording_id); set(ItemKey::MusicBrainzTrackId, &t.track_id);
    set(ItemKey::Unknown("MUSICBRAINZ_DISCID".into()), &x.mb_disc_id); set(ItemKey::Unknown("ACCURATERIPRESULT".into()), &x.ar);
    set(ItemKey::EncodedBy, "bootleg CD");
    if !m.cover_jpeg_base64.is_empty() {
        use base64::Engine; if let Ok(img) = base64::engine::general_purpose::STANDARD.decode(&m.cover_jpeg_base64) { tag.push_picture(Picture::new_unchecked(PictureType::CoverFront, Some(MimeType::Jpeg), None, img)); }
    }
    tf.save_to_path(path, WriteOptions::default()).map_err(|e| format!("tags: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn pcm(n: usize) -> Vec<u8> { (0..n).flat_map(|i| { let v = ((i as f64 * 0.05).sin() * 9000.0) as i16; [v.to_le_bytes(), (v / 2).to_le_bytes()].concat() }).collect() }
    #[test] fn flac_round_trip_is_exact() { let p = pcm(44_100); let f = encode_flac(&p).unwrap(); assert!(f.len() < p.len()); verify_flac(&f, &p).unwrap(); let mut q = p.clone(); q[1001] ^= 1; assert!(verify_flac(&f, &q).is_err()); }
    #[test] fn names() {
        let m = Meta { album: "A/B: C?".into(), album_artist: "Band".into(), date: "1994-03-01".into(), ..Default::default() };
        assert_eq!(render(DEFAULT_TEMPLATE, &m, &m.track(3)), PathBuf::from("Band/A_B_ C_/03 Track 03"));
        assert_eq!(render("{year} - {album}/{disc}-{track}", &m, &m.track(1)), PathBuf::from("1994 - A_B_ C_/1-01"));
    }
    #[test] fn writes_tagged_files() {
        let dir = std::env::temp_dir().join(format!("bootleg-cd-out-{}", std::process::id())); let p = pcm(30_000);
        let m = Meta { album: "Album".into(), album_artist: "Artist".into(), tracks: vec![TrackMeta { number: 1, title: "Song".into(), ..Default::default() }], ..Default::default() };
        for f in [Format::Flac, Format::Wav, Format::Aiff] {
            let dest = dir.join(format!("01 Song.{}", f.ext())); write_track(&dest, f, &p, &m, &m.track(1), &Extra { isrc: Some("USX9P0000001".into()), tracks: 1, ..Default::default() }).unwrap();
            use lofty::{prelude::*, probe::Probe}; let tf = Probe::open(&dest).unwrap().read().unwrap(); let t = tf.primary_tag().unwrap();
            assert_eq!(t.title().as_deref(), Some("Song"), "{f:?}"); assert_eq!(t.album().as_deref(), Some("Album"), "{f:?}");
            assert!((tf.properties().duration().as_secs_f64() - 30_000.0 / 44_100.0).abs() < 0.01, "{f:?}");
            if f == Format::Flac {
                verify_flac(&std::fs::read(&dest).unwrap(), &p).expect("the tagged FLAC still decodes to the same audio");
                // the reference decoder, when installed, must accept it without a single warning
                if let Ok(o) = std::process::Command::new("flac").args(["-t", "-s"]).arg(&dest).output() { assert!(o.status.success() && o.stderr.is_empty(), "flac -t: {}", String::from_utf8_lossy(&o.stderr)); }
            }
        }
        std::fs::remove_dir_all(&dir).ok();
    }
}
