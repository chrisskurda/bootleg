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
