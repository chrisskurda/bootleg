// WAV in and out. Recordings are written as 32-bit float WAV as they come in (nothing clips or rounds until the tracks
// are saved), and read back a stretch at a time, so a long side never has to fit in memory.
use std::{fs::File, io::{BufWriter, Read, Seek, SeekFrom, Write}, path::Path};

pub struct Wav { pub rate: u32, pub channels: u16, pub samples: Vec<f32> }

/// An open WAV file: format and where the samples are.
pub struct Reader { f: File, pub rate: u32, pub channels: u16, pub frames: u64, fmt: u16, bits: u16, data: u64 }
impl Reader {
    pub fn open(p: &Path) -> Result<Reader, String> {
        let mut f = File::open(p).map_err(|e| format!("{}: {e}", p.display()))?; let mut h = [0u8; 12]; f.read_exact(&mut h).map_err(|e| e.to_string())?;
        if &h[0..4] != b"RIFF" || &h[8..12] != b"WAVE" { return Err("not a WAV file".into()); }
        let (mut rate, mut ch, mut fmt, mut bits) = (0, 0, 0, 0);
        loop {
            let mut c = [0u8; 8]; f.read_exact(&mut c).map_err(|_| "no audio data in the WAV file".to_string())?;
            let size = u32::from_le_bytes([c[4], c[5], c[6], c[7]]) as u64;
            if &c[0..4] == b"fmt " { let mut b = vec![0u8; size as usize]; f.read_exact(&mut b).map_err(|e| e.to_string())?;
                fmt = u16::from_le_bytes([b[0], b[1]]); ch = u16::from_le_bytes([b[2], b[3]]); rate = u32::from_le_bytes([b[4], b[5], b[6], b[7]]); bits = u16::from_le_bytes([b[14], b[15]]);
                if fmt == 0xFFFE && b.len() >= 26 { fmt = u16::from_le_bytes([b[24], b[25]]); }
                if size % 2 == 1 { f.seek(SeekFrom::Current(1)).ok(); } }
            else if &c[0..4] == b"data" {
                let data = f.stream_position().map_err(|e| e.to_string())?; let len = f.metadata().map(|m| m.len()).unwrap_or(0);
                let size = if size == 0 || size == u32::MAX as u64 || data + size > len { len - data } else { size };   // a recording cut off before its header was finished
                if !(fmt == 1 && matches!(bits, 16 | 24 | 32) || fmt == 3 && bits == 32) || ch == 0 { return Err(format!("unsupported WAV format {fmt}/{bits} bit")); }
                return Ok(Reader { f, rate, channels: ch, frames: size / (ch as u64 * bits as u64 / 8), fmt, bits, data });
            } else { f.seek(SeekFrom::Current((size + size % 2) as i64)).map_err(|e| e.to_string())?; }
        }
    }
    /// `count` frames from frame `start`, interleaved.
    pub fn read(&mut self, start: u64, count: u64) -> Result<Vec<f32>, String> {
        let count = count.min(self.frames.saturating_sub(start)); let bps = self.bits as u64 / 8; let n = (count * self.channels as u64) as usize;
        self.f.seek(SeekFrom::Start(self.data + start * self.channels as u64 * bps)).map_err(|e| e.to_string())?;
        let mut b = vec![0u8; n * bps as usize]; self.f.read_exact(&mut b).map_err(|e| e.to_string())?;
        Ok(match (self.fmt, self.bits) {
            (3, 32) => b.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect(),
            (1, 16) => b.chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0).collect(),
            (1, 24) => b.chunks_exact(3).map(|c| (i32::from_le_bytes([0, c[0], c[1], c[2]]) >> 8) as f32 / 8388608.0).collect(),
            _ => b.chunks_exact(4).map(|c| i32::from_le_bytes([c[0], c[1], c[2], c[3]]) as f32 / 2147483648.0).collect(),
        })
    }
}
pub fn read(p: &Path) -> Result<Wav, String> { let mut r = Reader::open(p)?; let s = r.read(0, r.frames)?; Ok(Wav { rate: r.rate, channels: r.channels, samples: s }) }

/// A float WAV written as it goes; `finish` fills in the sizes. 4 GB at most (the WAV format's limit).
pub struct Writer { w: BufWriter<File>, pub frames: u64, channels: u16 }
pub const MAX_BYTES: u64 = 4_000_000_000;
impl Writer {
    pub fn create(p: &Path, rate: u32, channels: u16) -> Result<Writer, String> {
        let mut w = BufWriter::new(File::create(p).map_err(|e| format!("{}: {e}", p.display()))?);
        let mut h = vec![]; h.extend(b"RIFF"); h.extend(0u32.to_le_bytes()); h.extend(b"WAVEfmt "); h.extend(16u32.to_le_bytes()); h.extend(3u16.to_le_bytes()); h.extend(channels.to_le_bytes());
        h.extend(rate.to_le_bytes()); h.extend((rate * channels as u32 * 4).to_le_bytes()); h.extend((channels * 4).to_le_bytes()); h.extend(32u16.to_le_bytes()); h.extend(b"data"); h.extend(0u32.to_le_bytes());
        w.write_all(&h).map_err(|e| e.to_string())?; Ok(Writer { w, frames: 0, channels })
    }
    pub fn bytes(&self) -> u64 { self.frames * self.channels as u64 * 4 }
    pub fn write(&mut self, s: &[f32]) -> Result<(), String> {
        if self.bytes() + s.len() as u64 * 4 > MAX_BYTES { return Err("the recording reached the 4 GB limit of a WAV file".into()); }
        let mut b = Vec::with_capacity(s.len() * 4); for x in s { b.extend(x.to_le_bytes()); } self.w.write_all(&b).map_err(|e| e.to_string())?; self.frames += (s.len() / self.channels as usize) as u64; Ok(())
    }
    pub fn finish(mut self) -> Result<u64, String> {
        let data = self.bytes() as u32; self.w.flush().map_err(|e| e.to_string())?; let mut f = self.w.into_inner().map_err(|e| e.to_string())?;
        f.seek(SeekFrom::Start(4)).map_err(|e| e.to_string())?; f.write_all(&(36 + data).to_le_bytes()).map_err(|e| e.to_string())?;
        f.seek(SeekFrom::Start(40)).map_err(|e| e.to_string())?; f.write_all(&data.to_le_bytes()).map_err(|e| e.to_string())?; Ok(self.frames)
    }
}
