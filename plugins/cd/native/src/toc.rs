// The disc's table of contents and the ids derived from it (MusicBrainz, AccurateRip, CDDB/gnudb).
// LBAs are logical block addresses: sector 0 is where the program area starts (MSF 00:02:00), so lead-in is negative.
use base64::Engine;
use serde::{Deserialize, Serialize};

pub const SECTOR_BYTES: usize = 2352;
pub const SAMPLES_PER_SECTOR: usize = 588; // stereo 16-bit frames per sector
pub const FRAMES_PER_SECOND: i32 = 75;
pub const SESSION_GAP: i32 = 11_400; // lead-out + lead-in + pregap between session 1 and 2 (Enhanced CD)

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Track {
    pub number: u8,
    pub start: i32,          // LBA of index 01
    pub audio: bool,
    #[serde(default)] pub preemphasis: bool,
    #[serde(default = "one")] pub session: u8,
    #[serde(default)] pub pregap: i32,     // sectors of index 00 before `start` (from the Q subchannel when known)
    #[serde(default)] pub isrc: Option<String>,
}
fn one() -> u8 { 1 }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Toc {
    pub tracks: Vec<Track>,
    pub leadout: i32,        // LBA where the (last session's) lead-out starts
    #[serde(default)] pub mcn: Option<String>,
}

impl Toc {
    pub fn audio_tracks(&self) -> impl Iterator<Item = &Track> { self.tracks.iter().filter(|t| t.audio) }
    pub fn audio_count(&self) -> usize { self.audio_tracks().count() }
    pub fn track(&self, n: u8) -> Option<&Track> { self.tracks.iter().find(|t| t.number == n) }
    /// Last sector of track `n` (inclusive). A track followed by a new session ends `SESSION_GAP` sectors before it.
    pub fn track_end(&self, n: u8) -> i32 {
        let i = self.tracks.iter().position(|t| t.number == n).expect("track in toc");
        match self.tracks.get(i + 1) {
            Some(next) => next.start - 1 - if next.session != self.tracks[i].session { SESSION_GAP } else { 0 },
            None => self.leadout - 1,
        }
    }
    pub fn track_sectors(&self, n: u8) -> i32 { self.track_end(n) - self.track(n).map(|t| t.start).unwrap_or(0) + 1 }
    /// End (exclusive) of the audio: the lead-out for an audio-only disc, the end of the audio session for an Enhanced CD.
    pub fn audio_leadout(&self) -> i32 { self.audio_tracks().last().map(|t| self.track_end(t.number) + 1).unwrap_or(self.leadout) }

    /// MusicBrainz disc id (https://musicbrainz.org/doc/Disc_ID_Calculation): SHA-1 over the first/last audio track and
    /// the offsets (+150), base64 with `.`, `_`, `-` for `+`, `/`, `=`. A data track after the audio is left out.
    pub fn musicbrainz_id(&self) -> String {
        let audio: Vec<&Track> = self.audio_tracks().collect();
        let (first, last) = (audio.first().map(|t| t.number).unwrap_or(1), audio.last().map(|t| t.number).unwrap_or(1));
        let mut s = format!("{first:02X}{last:02X}{:08X}", self.audio_leadout() + 150);
        for i in 1..=99u8 { let off = audio.iter().find(|t| t.number == i).map(|t| t.start + 150).unwrap_or(0); s += &format!("{off:08X}"); }
        let digest = sha1_smol::Sha1::from(s.as_bytes()).digest().bytes();
        base64::engine::general_purpose::STANDARD.encode(digest).replace('+', ".").replace('/', "_").replace('=', "-")
    }
    /// The TOC string MusicBrainz's `/ws/2/discid/-?toc=` accepts as a fallback when the disc id is unknown.
    pub fn musicbrainz_toc(&self) -> String {
        let audio: Vec<&Track> = self.audio_tracks().collect();
        let mut v = vec![audio.first().map(|t| t.number as i32).unwrap_or(1), audio.last().map(|t| t.number as i32).unwrap_or(1), self.audio_leadout() + 150];
        v.extend(audio.iter().map(|t| t.start + 150));
        v.iter().map(|x| x.to_string()).collect::<Vec<_>>().join("+")
    }
    /// CDDB / gnudb disc id: digit sums of every track's start in seconds, the playing time and the track count.
    pub fn cddb_id(&self) -> u32 {
        let digits = |mut n: i32| { let mut s = 0; while n > 0 { s += n % 10; n /= 10; } s };
        let n: i32 = self.tracks.iter().map(|t| digits((t.start + 150) / FRAMES_PER_SECOND)).sum();
        let first = (self.tracks.first().map(|t| t.start).unwrap_or(0) + 150) / FRAMES_PER_SECOND;
        let t = (self.leadout + 150) / FRAMES_PER_SECOND - first;
        (((n % 0xff) as u32) << 24) | ((t as u32) << 8) | self.tracks.len() as u32
    }
    /// AccurateRip disc ids (id1, id2) over the audio tracks and the audio lead-out.
    pub fn accuraterip_ids(&self) -> (u32, u32) {
        let (mut id1, mut id2) = (0u32, 0u32);
        for t in self.audio_tracks() { id1 = id1.wrapping_add(t.start as u32); id2 = id2.wrapping_add((t.start.max(1) as u32).wrapping_mul(t.number as u32)); }
        let lo = self.audio_leadout() as u32;
        (id1.wrapping_add(lo), id2.wrapping_add(lo.wrapping_mul(self.audio_count() as u32 + 1)))
    }
    /// Path of the disc's entry in the AccurateRip database, relative to http://www.accuraterip.com/accuraterip/
    pub fn accuraterip_path(&self) -> String {
        let (id1, id2) = self.accuraterip_ids(); let h = format!("{id1:08x}");
        let c = |i: usize| &h[8 - i..9 - i];
        format!("{}/{}/{}/dBAR-{:03}-{id1:08x}-{id2:08x}-{:08x}.bin", c(1), c(2), c(3), self.audio_count(), self.cddb_id())
    }
}

/// MSF (minutes, seconds, frames, absolute time including the 2 s pregap) → LBA.
pub fn msf_to_lba(m: u8, s: u8, f: u8) -> i32 { (m as i32 * 60 + s as i32) * FRAMES_PER_SECOND + f as i32 - 150 }
pub fn lba_to_msf(lba: i32) -> (i32, i32, i32) { let a = lba + 150; (a / 4500, a / 75 % 60, a % 75) }
/// mm:ss:ff relative time (cue sheets, logs).
pub fn fmt_frames(n: i32) -> String { format!("{:02}:{:02}:{:02}", n / 4500, n / 75 % 60, n % 75) }

#[cfg(test)]
mod tests {
    use super::*;
    fn tr(number: u8, start: i32) -> Track { Track { number, start, audio: true, preemphasis: false, session: 1, pregap: 0, isrc: None } }

    // The worked example on https://musicbrainz.org/doc/Disc_ID_Calculation
    // (6 tracks, offsets 150 15363 32314 46592 63414 80489, lead-out 95462) → 49HHV7Eb8UKF3aQiNmu1GR8vKTY-
    fn mb_example() -> Toc { Toc { tracks: [150, 15363, 32314, 46592, 63414, 80489].iter().enumerate().map(|(i, o)| tr(i as u8 + 1, o - 150)).collect(), leadout: 95462 - 150, mcn: None } }

    #[test] fn musicbrainz_disc_id() { assert_eq!(mb_example().musicbrainz_id(), "49HHV7Eb8UKF3aQiNmu1GR8vKTY-"); }
    #[test] fn musicbrainz_toc_string() { assert_eq!(mb_example().musicbrainz_toc(), "1+6+95462+150+15363+32314+46592+63414+80489"); }
    #[test] fn cddb_id() {
        // starts 2, 204, 430, 621, 845, 1073 s: digit sums 2+6+7+9+17+11 = 52 → 0x34; playing time 1272-2 = 1270 s = 0x4f6; 6 tracks
        assert_eq!(mb_example().cddb_id(), 0x3404f606);
    }
    #[test] fn enhanced_cd_leaves_out_the_data_track() {
        let mut t = mb_example(); let audio_end = t.leadout;
        t.tracks.push(Track { number: 7, start: audio_end + SESSION_GAP, audio: false, preemphasis: false, session: 2, pregap: 0, isrc: None });
        t.leadout = audio_end + SESSION_GAP + 20_000;
        assert_eq!(t.audio_leadout(), audio_end);
        assert_eq!(t.musicbrainz_id(), mb_example().musicbrainz_id());
        assert_eq!(t.track_end(6), audio_end - 1);
        assert_eq!(t.accuraterip_ids(), mb_example().accuraterip_ids());
    }
    #[test] fn accuraterip_ids_and_path() {
        let t = mb_example(); let (id1, id2) = t.accuraterip_ids();
        let starts = [0, 15213, 32164, 46442, 63264, 80339]; let lo = 95312u32;
        assert_eq!(id1, starts.iter().sum::<u32>() + lo);
        assert_eq!(id2, starts.iter().enumerate().map(|(i, s)| (*s).max(1) * (i as u32 + 1)).sum::<u32>() + lo * 7);
        let p = t.accuraterip_path(); let h = format!("{id1:08x}");
        assert!(p.starts_with(&format!("{}/{}/{}/dBAR-006-{h}-", &h[7..8], &h[6..7], &h[5..6])), "{p}");
    }
    #[test] fn msf() { assert_eq!(msf_to_lba(0, 2, 0), 0); assert_eq!(lba_to_msf(0), (0, 2, 0)); assert_eq!(fmt_frames(4500 + 75 + 1), "01:01:01"); }
}
