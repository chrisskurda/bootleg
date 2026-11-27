//! End-to-end checks of device format 1 on a temporary "volume". The theme of most of them: files bootleg
//! did not write are never touched.
use bootleg_sync::apply::{apply, Transcoder};
use bootleg_sync::config::{Mode, Size};
use bootleg_sync::disk::Disk;
use bootleg_sync::manifest::Kind;
use bootleg_sync::plan::{plan, Item, Op, PlanOptions, PlaylistSpec, Skip};
use bootleg_sync::{journal, outbox, players, Device, Error};
use std::fs;
use std::path::{Path, PathBuf};

const BIG: Disk = Disk { free: 1 << 40, total: 1 << 41, fat32: false };

struct Fixture {
    _tmp: tempfile::TempDir,
    vol: PathBuf,
    lib: PathBuf,
}

fn fixture() -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let vol = tmp.path().join("vol");
    let lib = tmp.path().join("lib");
    fs::create_dir_all(&vol).unwrap();
    fs::create_dir_all(&lib).unwrap();
    Fixture { _tmp: tmp, vol, lib }
}

impl Fixture {
    fn track(&self, rel: &str, bytes: &[u8]) -> Item {
        let src = self.lib.join(rel);
        fs::create_dir_all(src.parent().unwrap()).unwrap();
        fs::write(&src, bytes).unwrap();
        Item {
            track: format!("file:{rel}"),
            src,
            rel: rel.into(),
            size: bytes.len() as u64,
            src_fp: format!("{}:{}", bytes.len(), bytes.first().copied().unwrap_or(0)),
            codec: rel.rsplit('.').next().unwrap().to_lowercase(),
            range: None,
        }
    }
    fn file(&self, rel: &str) -> PathBuf {
        self.vol.join(rel)
    }
    fn foreign(&self, rel: &str, bytes: &[u8]) {
        let p = self.file(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, bytes).unwrap();
    }
}

fn sync(dev: &mut Device, items: &[Item], pls: &[PlaylistSpec]) -> bootleg_sync::plan::Plan {
    let p = plan(dev, items, pls, &BIG, &PlanOptions::default()).unwrap();
    let r = apply(dev, &p, &mut (), None).unwrap();
    assert!(r.failed.is_empty(), "{:?}", r.failed);
    p
}

#[test]
fn pairing_writes_only_the_marker() {
    let f = fixture();
    f.foreign("Music/mine.mp3", b"user's");
    assert!(matches!(Device::open(&f.vol), Err(Error::NotPaired)));
    let d = Device::init(&f.vol, "Card", "generic", Mode::Add, "Music/bootleg").unwrap();
    assert!(Device::is_paired(&f.vol));
    assert!(matches!(Device::init(&f.vol, "x", "generic", Mode::Add, ""), Err(Error::AlreadyPaired)));
    let again = Device::open(&f.vol).unwrap();
    assert_eq!(again.config.id, d.config.id);
    assert_eq!(fs::read(f.file("Music/mine.mp3")).unwrap(), b"user's");
    let names: Vec<_> = fs::read_dir(&f.vol).unwrap().flatten().map(|e| e.file_name().into_string().unwrap()).collect();
    assert_eq!(names.len(), 2, "{names:?}"); // .bootleg and Music
}

#[test]
fn add_mode_copies_once_and_never_deletes() {
    let f = fixture();
    let mut dev = Device::init(&f.vol, "Card", "generic", Mode::Add, "Music/bootleg").unwrap();
    let a = f.track("Low/Album/01 A.flac", b"aaaa");
    let b = f.track("Low/Album/02 B.mp3", b"bbbbbb");
    sync(&mut dev, &[a.clone(), b.clone()], &[]);
    assert_eq!(fs::read(f.file("Music/bootleg/Low/Album/01 A.flac")).unwrap(), b"aaaa");
    let second = plan(&dev, &[a.clone(), b.clone()], &[], &BIG, &PlanOptions::default()).unwrap();
    assert!(second.is_noop());
    assert_eq!(second.unchanged, 2);
    // dropped from the selection: still there in add mode
    let third = sync(&mut dev, &[a], &[]);
    assert_eq!(third.kept_unselected, 1);
    assert!(f.file("Music/bootleg/Low/Album/02 B.mp3").exists());
    let reopened = Device::open(&f.vol).unwrap();
    assert_eq!(reopened.manifest.len(), 2);
    assert!(reopened.config.last_sync.is_some());
    assert_eq!(reopened.verify().unwrap().ok, 2);
}

#[test]
fn mirror_deletes_only_its_own_files() {
    let f = fixture();
    let mut dev = Device::init(&f.vol, "Card", "generic", Mode::Mirror, "Music/bootleg").unwrap();
    let a = f.track("X/One/a.flac", b"a");
    let b = f.track("Y/Two/b.flac", b"b");
    let c = f.track("X/One/c.flac", b"c");
    sync(&mut dev, &[a.clone(), b, c], &[]);
    f.foreign("Music/bootleg/X/One/cover-i-made.jpg", b"jpg");
    f.foreign("Music/bootleg/Y/Two/notes.txt", b"mine");
    fs::remove_file(f.file("Music/bootleg/Y/Two/notes.txt")).unwrap(); // leaves Y/Two empty but for bootleg's file
    let p = sync(&mut dev, &[a], &[]);
    assert_eq!(p.ops.iter().filter(|o| matches!(o, Op::Delete { .. })).count(), 2);
    assert!(!f.file("Music/bootleg/X/One/c.flac").exists());
    assert!(f.file("Music/bootleg/X/One/cover-i-made.jpg").exists(), "foreign file kept");
    assert!(f.file("Music/bootleg/X/One").is_dir(), "folder with a foreign file kept");
    assert!(!f.file("Music/bootleg/Y").exists(), "emptied folders pruned");
    assert!(f.file("Music/bootleg").is_dir(), "managed root itself is never pruned");
}

#[test]
fn foreign_file_at_the_wanted_path_is_left_alone() {
    let f = fixture();
    f.foreign("Music/bootleg/Low/Album/01 A.flac", b"the user's own copy");
    let mut dev = Device::init(&f.vol, "Card", "generic", Mode::Mirror, "Music/bootleg").unwrap();
    let a = f.track("Low/Album/01 A.flac", b"bootleg's");
    let p = sync(&mut dev, &[a], &[]);
    assert_eq!(p.renamed.len(), 1);
    assert_eq!(fs::read(f.file("Music/bootleg/Low/Album/01 A.flac")).unwrap(), b"the user's own copy");
    assert_eq!(fs::read(f.file("Music/bootleg/Low/Album/01 A (bootleg).flac")).unwrap(), b"bootleg's");
    // and mirroring an empty selection deletes only bootleg's copy
    sync(&mut dev, &[], &[]);
    assert!(f.file("Music/bootleg/Low/Album/01 A.flac").exists());
    assert!(!f.file("Music/bootleg/Low/Album/01 A (bootleg).flac").exists());
}

#[test]
fn changed_source_replaces_in_place() {
    let f = fixture();
    let mut dev = Device::init(&f.vol, "Card", "generic", Mode::Add, "").unwrap();
    let a = f.track("A/x.flac", b"v1");
    sync(&mut dev, &[a], &[]);
    let a2 = f.track("A/x.flac", b"version two");
    let p = sync(&mut dev, &[a2], &[]);
    assert!(matches!(&p.ops[..], [Op::Copy { replaces: true, .. }]));
    assert_eq!(fs::read(f.file("A/x.flac")).unwrap(), b"version two");
    assert_eq!(dev.manifest.len(), 1);
}

#[test]
fn hand_built_plan_cannot_touch_foreign_files() {
    let f = fixture();
    f.foreign("Music/keep.mp3", b"keep");
    let mut dev = Device::init(&f.vol, "Card", "generic", Mode::Mirror, "Music").unwrap();
    let mut p = plan(&dev, &[], &[], &BIG, &PlanOptions::default()).unwrap();
    p.ops.push(Op::Delete { path: "Music/keep.mp3".into(), size: 4 });
    assert!(matches!(apply(&mut dev, &p, &mut (), None), Err(Error::Refused(_))));
    let it = f.track("keep.mp3", b"overwrite!");
    p.ops = vec![Op::Copy { track: it.track, src: it.src, range: None, dest: "Music/keep.mp3".into(), size: 10, src_fp: "x".into(), transcode: None, replaces: false }];
    assert!(matches!(apply(&mut dev, &p, &mut (), None), Err(Error::Refused(_))));
    assert_eq!(fs::read(f.file("Music/keep.mp3")).unwrap(), b"keep");
}

#[test]
fn space_budget_fill_and_mirror() {
    let f = fixture();
    let mut dev = Device::init(&f.vol, "Card", "generic", Mode::Fill, "M").unwrap();
    dev.config.fill.keep_free = Some(Size::Text("100B".into()));
    let items: Vec<Item> = (0..5).map(|i| f.track(&format!("t{i}.flac"), &[b'x'; 40])).collect();
    let disk = Disk { free: 230, total: 1000, fat32: false }; // 130 usable → 3 tracks
    let p = plan(&dev, &items, &[], &disk, &PlanOptions::default()).unwrap();
    assert_eq!(p.ops.len(), 3);
    assert_eq!(p.skipped.iter().filter(|s| s.1 == Skip::NoSpace).count(), 2);
    apply(&mut dev, &p, &mut (), None).unwrap();
    // rotate: a new selection frees the old tracks first
    let next: Vec<Item> = (5..8).map(|i| f.track(&format!("t{i}.flac"), &[b'y'; 40])).collect();
    let p2 = plan(&dev, &next, &[], &Disk { free: 110, ..disk }, &PlanOptions::default()).unwrap();
    assert_eq!(p2.ops.iter().filter(|o| matches!(o, Op::Copy { .. })).count(), 3, "{:?}", p2.skipped);
    // max_use caps it too
    dev.config.fill.keep_free = None;
    dev.config.fill.max_use = Some(50);
    let p3 = plan(&dev, &next, &[], &Disk { free: 600, total: 1000, fat32: false }, &PlanOptions::default()).unwrap();
    // used 400 → cap 500 → 100 + 120 freed = 220 → all 3
    assert!(p3.skipped.is_empty());
    // mirror refuses to start when short
    dev.config.mode = Mode::Mirror;
    let p4 = plan(&dev, &next, &[], &Disk { free: 0, total: 1000, fat32: false }, &PlanOptions::default()).unwrap();
    assert!(p4.short_by.is_some());
    assert!(matches!(apply(&mut dev, &p4, &mut (), None), Err(Error::Refused(_))));
}

#[test]
fn fat32_and_codecs() {
    let f = fixture();
    let mut dev = Device::init(&f.vol, "Card", "generic", Mode::Add, "").unwrap();
    dev.config.profile.codecs = vec!["mp3".into()];
    let mut huge = f.track("big.mp3", b"x");
    huge.size = 5 << 30;
    let flac = f.track("lossless.flac", b"flacdata");
    let p = plan(&dev, &[huge.clone(), flac.clone()], &[], &Disk { fat32: true, ..BIG }, &PlanOptions::default()).unwrap();
    assert_eq!(p.skipped, vec![(huge.track.clone(), Skip::TooBigForFat32), (flac.track.clone(), Skip::NeedsTranscode)]);

    struct Fake;
    impl Transcoder for Fake {
        fn transcode(&self, src: &Path, dest: &Path, target: &str) -> Result<(), String> {
            let mut b = fs::read(src).map_err(|e| e.to_string())?;
            b.extend_from_slice(target.as_bytes());
            fs::write(dest, b).map_err(|e| e.to_string())
        }
    }
    let p = plan(&dev, &[flac], &[], &BIG, &PlanOptions { can_transcode: true }).unwrap();
    let r = apply(&mut dev, &p, &mut (), Some(&Fake)).unwrap();
    assert_eq!(r.transcoded, 1);
    assert_eq!(fs::read(f.file("lossless.mp3")).unwrap(), b"flacdatamp3-v0");
}

#[test]
fn playlists_point_at_where_tracks_landed() {
    let f = fixture();
    let mut dev = Device::init(&f.vol, "Card", "generic", Mode::Mirror, "Music/bootleg").unwrap();
    f.foreign("Music/bootleg/A/1.flac", b"foreign");
    let a = f.track("A/1.flac", b"a");
    let b = f.track("B/2.flac", b"b");
    let pl = PlaylistSpec { name: "Road: Night".into(), tracks: vec![b.track.clone(), a.track.clone(), "file:missing".into()] };
    sync(&mut dev, &[a.clone(), b.clone()], &[pl]);
    let text = fs::read_to_string(f.file("Music/bootleg/Playlists/Road_ Night.m3u8")).unwrap();
    assert_eq!(text, "#EXTM3U\n../B/2.flac\n../A/1 (bootleg).flac\n");
    assert_eq!(dev.manifest.iter().filter(|e| e.kind == Kind::Playlist).count(), 1);
    // unchanged playlist → no op; dropped playlist → deleted in mirror mode
    let same = PlaylistSpec { name: "Road: Night".into(), tracks: vec![b.track.clone(), a.track.clone()] };
    assert!(plan(&dev, &[a.clone(), b.clone()], &[same], &BIG, &PlanOptions::default()).unwrap().is_noop());
    sync(&mut dev, &[a, b], &[]);
    assert!(!f.file("Music/bootleg/Playlists/Road_ Night.m3u8").exists());
}

#[test]
fn interrupted_sync_is_recovered_on_open() {
    let f = fixture();
    let dev = Device::init(&f.vol, "Card", "generic", Mode::Add, "").unwrap();
    // a sync that wrote one file, left a half-written one, and never recorded either
    f.foreign("done.flac", b"finished");
    f.foreign("half.flac.bootleg-tmp", b"hal");
    let intents = [
        journal::Intent { op: "copy".into(), path: "done.flac".into(), track: Some("t:done".into()), src: Some("1".into()), kind: Some(Kind::Track) },
        journal::Intent { op: "copy".into(), path: "half.flac".into(), track: Some("t:half".into()), src: Some("2".into()), kind: Some(Kind::Track) },
    ];
    journal::begin(&dev, &intents).unwrap();
    drop(dev);
    let dev = Device::open(&f.vol).unwrap();
    let r = dev.recovered.clone().unwrap();
    assert_eq!(r.adopted, vec!["done.flac"]);
    assert_eq!(r.temps_removed, 1);
    assert_eq!(dev.track_for("done.flac"), Some("t:done"));
    assert!(!f.file("half.flac.bootleg-tmp").exists());
    assert!(!journal::path(&dev).exists());
}

#[test]
fn newer_device_format_is_refused() {
    let f = fixture();
    fs::create_dir_all(f.vol.join(".bootleg")).unwrap();
    fs::write(f.vol.join(".bootleg/device.toml"), "format = 2\nid = \"x\"\n").unwrap();
    assert!(matches!(Device::open(&f.vol), Err(Error::NewerFormat(2))));
}

#[test]
fn outbox_and_players_round_trip() {
    let f = fixture();
    let mut dev = Device::init(&f.vol, "Card", "pod", Mode::Add, "").unwrap();
    let a = f.track("A/x.flac", b"a");
    sync(&mut dev, &[a.clone()], &[]);
    let mut ob = outbox::Outbox::new(&f.vol, "pod-123");
    ob.append(&outbox::Event::for_file(&dev, "A/x.flac", "play", serde_json::json!({"seconds": 12, "complete": false}))).unwrap();
    ob.append(&outbox::Event::for_file(&dev, "Other/y.mp3", "rating", serde_json::json!({"stars": 4.5}))).unwrap();
    let files = outbox::read_all(&f.vol).unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].events[0].track, a.track);
    assert_eq!(files[0].events[1].track, "file:Other/y.mp3");
    assert_eq!(files[0].events[1].data["stars"], 4.5);
    outbox::ack(&files[0]).unwrap();
    assert!(outbox::read_all(&f.vol).unwrap().is_empty());

    let rec = players::PlayerRecord { id: "pod-123".into(), name: "R36S".into(), model: "Anbernic R36S".into(), app: "bootleg-pod 0.0.1".into(), last_seen: 0, extra: Default::default() };
    players::touch(&f.vol, &rec).unwrap();
    let list = players::list(&f.vol);
    assert_eq!(list.len(), 1);
    assert!(list[0].last_seen > 0);
}

#[test]
fn copies_a_byte_range_out_of_a_package() {
    let f = fixture();
    let mut dev = Device::init(&f.vol, "Card", "generic", Mode::Add, "Music").unwrap();
    // a fake package: 7 bytes of header, the 5-byte "audio" entry, then a trailer
    let pkg = f.lib.join("song.bstem");
    fs::write(&pkg, b"HEADER!audioTRAILER").unwrap();
    let it = Item { track: "pkg:song".into(), src: pkg.clone(), rel: "Stem sets/song/mix.flac".into(), size: 5, src_fp: "19:1@7+5".into(), codec: "flac".into(), range: Some((7, 5)) };
    let p = plan(&dev, &[it.clone()], &[], &BIG, &PlanOptions { can_transcode: true }).unwrap();
    let r = apply(&mut dev, &p, &mut (), None).unwrap();
    assert_eq!(r.copied, 1, "{:?}", r.failed);
    assert_eq!(fs::read(f.file("Music/Stem sets/song/mix.flac")).unwrap(), b"audio");
    assert!(dev.verify().unwrap().changed.is_empty());

    // a range past the end of the file fails that one copy, and nothing half-written is left
    let short = Item { track: "pkg:short".into(), rel: "Stem sets/short/mix.flac".into(), range: Some((15, 50)), size: 50, src_fp: "x".into(), ..it.clone() };
    let p = plan(&dev, &[short], &[], &BIG, &PlanOptions::default()).unwrap();
    let r = apply(&mut dev, &p, &mut (), None).unwrap();
    assert_eq!((r.copied, r.failed.len()), (0, 1));
    assert!(!f.file("Music/Stem sets/short/mix.flac").exists());

    // a ranged source the player can't play is skipped, not handed to a transcoder (which needs a whole file)
    let wav = Item { track: "pkg:wav".into(), rel: "Stem sets/w/mix.caf".into(), codec: "caf".into(), ..it };
    let p = plan(&dev, &[wav], &[], &BIG, &PlanOptions { can_transcode: true }).unwrap();
    assert!(matches!(p.skipped.as_slice(), [(_, Skip::NeedsTranscode)]), "{:?}", p.skipped);
}

#[test]
fn a_playlist_with_nothing_on_the_card_is_not_written() {
    let f = fixture();
    let mut dev = Device::init(&f.vol, "Card", "generic", Mode::Add, "Music").unwrap();
    // its tracks are on a server: the desktop sends the playlist but no files for them
    let pl = PlaylistSpec { name: "TestPlaylist".into(), tracks: vec!["file:subsonic:a/1#".into(), "file:subsonic:a/2#".into()] };
    let p = plan(&dev, &[], &[pl], &BIG, &PlanOptions::default()).unwrap();
    assert!(p.ops.is_empty(), "{:?}", p.ops);
    assert!(matches!(p.skipped.as_slice(), [(k, Skip::EmptyPlaylist)] if k == "playlist:TestPlaylist"), "{:?}", p.skipped);
    apply(&mut dev, &p, &mut (), None).unwrap();
    assert!(!f.file("Music/Playlists/TestPlaylist.m3u8").exists());
}
