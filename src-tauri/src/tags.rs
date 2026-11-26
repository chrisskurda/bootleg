// Native tag reading (lofty) in batches, on a few threads. Same fields the page-side reader (src/lib/tags.js) produces,
// so a library of tens of thousands of files is read in seconds instead of minutes. Cover art is returned once per unique picture.
use base64::Engine;
use lofty::{config::ParseOptions, file::{AudioFile, TaggedFileExt}, prelude::*, probe::Probe, tag::ItemKey};
use serde::Serialize;
use std::{collections::HashMap, path::Path, sync::Mutex};

#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Tags {
    #[serde(skip_serializing_if = "Option::is_none")] pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub artist: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub album_artist: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub album: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub year: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub track: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")] pub track_total: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")] pub disc: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")] pub genre: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub bpm: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")] pub key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub duration: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")] pub cover_key: Option<String>,
}
#[derive(Serialize)]
pub struct Cover { pub mime: String, pub data_b64: String }
#[derive(Serialize)]
pub struct Batch { pub tags: Vec<Option<Tags>>, pub covers: HashMap<String, Cover> }

fn clean(s: Option<impl AsRef<str>>) -> Option<String> { s.map(|x| x.as_ref().trim().to_string()).filter(|x| !x.is_empty()) }

fn read_one(path: &Path, known: &HashMap<String, ()>, covers: &Mutex<HashMap<String, Cover>>) -> Option<Tags> {
    let tf = Probe::open(path).ok()?.options(ParseOptions::new().read_properties(true).read_cover_art(true)).read().ok()?;
    let mut t = Tags { duration: Some(tf.properties().duration().as_secs_f64()).filter(|d| *d > 0.0), ..Default::default() };
    if let Some(tag) = tf.primary_tag().or_else(|| tf.first_tag()) {
        t.title = clean(tag.title()); t.artist = clean(tag.artist()); t.album = clean(tag.album()); t.genre = clean(tag.genre());
        t.album_artist = clean(tag.get_string(&ItemKey::AlbumArtist)); t.year = tag.year().map(|y| y.to_string()).or_else(|| clean(tag.get_string(&ItemKey::RecordingDate)).map(|d| d.chars().take(4).collect()));
        t.track = tag.track(); t.track_total = tag.track_total(); t.disc = tag.disk();
        t.bpm = tag.get_string(&ItemKey::IntegerBpm).or_else(|| tag.get_string(&ItemKey::Bpm)).and_then(|b| b.trim().parse::<f64>().ok());
        t.key = clean(tag.get_string(&ItemKey::InitialKey));
        if let Some(pic) = tag.pictures().iter().find(|p| p.pic_type() == lofty::picture::PictureType::CoverFront).or_else(|| tag.pictures().first()) {
            let d = pic.data(); if !d.is_empty() {
                let key = format!("{}:{}", d.len(), d.iter().take(24).map(|b| b.to_string()).collect::<Vec<_>>().join(","));
                if !known.contains_key(&key) { if let Ok(mut c) = covers.lock() { c.entry(key.clone()).or_insert_with(|| Cover { mime: pic.mime_type().map(|m| m.to_string()).unwrap_or_else(|| "image/jpeg".into()), data_b64: base64::engine::general_purpose::STANDARD.encode(d) }); } }
                t.cover_key = Some(key);
            }
        }
    }
    Some(t)
}

pub fn read_batch(paths: Vec<String>, known: Vec<String>) -> Batch {
    let known: HashMap<String, ()> = known.into_iter().map(|k| (k, ())).collect(); let covers = Mutex::new(HashMap::new());
    let next = Mutex::new(0usize); let out: Mutex<Vec<Option<Tags>>> = Mutex::new(vec![None; paths.len()]);
    let workers = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(2, 8);
    std::thread::scope(|sc| { for _ in 0..workers { sc.spawn(|| loop {
        let i = { let mut n = next.lock().unwrap(); let i = *n; *n += 1; i }; if i >= paths.len() { break; }
        let r = read_one(Path::new(&paths[i]), &known, &covers); out.lock().unwrap()[i] = r;
    }); } });
    Batch { tags: out.into_inner().unwrap(), covers: covers.into_inner().unwrap() }
}

// ---- writing (the "apply tag edits to files" feature, off unless the user turns it on) -------------------------------
// Fields given are set; an empty string (or 0 for track/disc) removes the field. The file is never written in place:
// a copy next to it gets the new tags and then replaces the original in one rename, so a crash or a dropped network share
// leaves either the old file or the new one, never half of each. Returns the new size and mtime (ms).
#[derive(Serialize)]
pub struct Written { pub size: u64, pub mtime: u64 }
pub fn write(path: &Path, fields: &serde_json::Map<String, serde_json::Value>) -> Result<Written, String> {
    use lofty::{config::WriteOptions, tag::Tag};
    let name = path.file_name().and_then(|n| n.to_str()).ok_or("bad file name")?;
    let tmp = path.with_file_name(format!(".bootleg-tmp-{name}"));      // keeps the extension: lofty picks the format by it
    std::fs::copy(path, &tmp).map_err(|e| format!("could not copy the file: {e}"))?;
    let res = (|| -> Result<(), String> {
        let mut tf = Probe::open(&tmp).and_then(|p| p.read()).map_err(|e| format!("could not read the tags: {e}"))?;
        if tf.primary_tag_mut().is_none() { let tt = tf.primary_tag_type(); tf.insert_tag(Tag::new(tt)); }
        let tag = tf.primary_tag_mut().ok_or("this file type cannot hold tags")?;
        for (k, v) in fields {
            let s = match v { serde_json::Value::String(s) => s.trim().to_string(), serde_json::Value::Number(n) => n.to_string(), serde_json::Value::Null => String::new(), _ => continue };
            let n = s.parse::<u32>().ok().filter(|n| *n > 0);
            match k.as_str() {
                "title" => if s.is_empty() { tag.remove_title() } else { tag.set_title(s) },
                "artist" => if s.is_empty() { tag.remove_artist() } else { tag.set_artist(s) },
                "album" => if s.is_empty() { tag.remove_album() } else { tag.set_album(s) },
                "genre" => if s.is_empty() { tag.remove_genre() } else { tag.set_genre(s) },
                "albumArtist" => if s.is_empty() { tag.remove_key(&ItemKey::AlbumArtist) } else { tag.insert_text(ItemKey::AlbumArtist, s); },
                "track" => match n { Some(n) => tag.set_track(n), None => tag.remove_track() },
                "disc" => match n { Some(n) => tag.set_disk(n), None => tag.remove_disk() },
                "year" => { tag.remove_year(); tag.remove_key(&ItemKey::RecordingDate); if let Some(n) = n { tag.set_year(n) } else if !s.is_empty() { tag.insert_text(ItemKey::RecordingDate, s); } }
                _ => {}
            }
        }
        tf.save_to_path(&tmp, WriteOptions::default()).map_err(|e| format!("could not write the tags: {e}"))
    })();
    if let Err(e) = res { let _ = std::fs::remove_file(&tmp); return Err(e); }
    std::fs::rename(&tmp, path).map_err(|e| { let _ = std::fs::remove_file(&tmp); format!("could not replace the file: {e}") })?;
    let md = std::fs::metadata(path).map_err(|e| e.to_string())?;
    let mtime = md.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
    Ok(Written { size: md.len(), mtime })
}

#[cfg(test)]
mod tests {
    use super::*;
    // Needs ffmpeg for fixtures (skipped without it): writes, reads back, and checks the audio survived.
    #[test]
    fn write_then_read_back() {
        let dir = std::env::temp_dir().join(format!("bootleg-tagw-{}", std::process::id())); let _ = std::fs::create_dir_all(&dir);
        for (ext, codec) in [("flac", "flac"), ("mp3", "libmp3lame"), ("m4a", "aac")] {
            let f = dir.join(format!("t.{ext}"));
            let ok = std::process::Command::new("ffmpeg").args(["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:a", codec, "-metadata", "title=Teh Song", "-metadata", "genre=Rock"]).arg(&f).status().map(|s| s.success()).unwrap_or(false);
            if !ok { eprintln!("ffmpeg missing: skipped"); return; }
            let fields: serde_json::Map<String, serde_json::Value> = serde_json::from_str(r#"{"title":"The Song","albumArtist":"Various","year":"1999","track":3,"disc":1,"genre":""}"#).unwrap();
            let w = write(&f, &fields).unwrap(); assert!(w.size > 0);
            let known = HashMap::new(); let covers = Mutex::new(HashMap::new()); let t = read_one(&f, &known, &covers).expect(ext);
            assert_eq!(t.title.as_deref(), Some("The Song"), "{ext}"); assert_eq!(t.album_artist.as_deref(), Some("Various"), "{ext}");
            assert_eq!(t.year.as_deref(), Some("1999"), "{ext}"); assert_eq!(t.track, Some(3), "{ext}"); assert_eq!(t.disc, Some(1), "{ext}");
            assert_eq!(t.genre, None, "{ext}: an empty value removes the field"); assert!(t.duration.unwrap_or(0.0) > 1.5, "{ext}: audio intact");
            assert!(!dir.join(format!(".bootleg-tmp-t.{ext}")).exists(), "{ext}: no temp file left");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
