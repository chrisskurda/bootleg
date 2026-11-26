// macOS backend: the CD ioctls of IOCDMediaBSDClient.h on the raw disk node (/dev/rdiskN), as the normal user, while
// macOS keeps the disc mounted (cddafs). Struct layouts and ioctl numbers are those of the LP64 SDK headers.
//   DKIOCCDREAD      audio + C2 error flags + Q subchannel per sector; `offset` counts in units of the sum of the
//                    requested area sizes (IOCDMedia::readCD: "the sum of each area's size defines the natural block size")
//   DKIOCCDREADTOC   format 2 = full TOC (sessions, data tracks, lead-out)
//   DKIOCCDREADISRC / DKIOCCDREADMCN / DKIOCCDSETSPEED
// Drives are found with `drutil` (vendor, model, which /dev/disk holds the disc) and confirmed by reading the TOC.
use super::*;
use crate::toc::{msf_to_lba, Toc, Track, SECTOR_BYTES};
use std::{ffi::CString, process::Command};

const AREA_USER: u8 = 0x10; const AREA_C2: u8 = 0x02; const AREA_SUBQ: u8 = 0x04; const TYPE_CDDA: u8 = 0x01;
const IOC_INOUT: u64 = 0xC000_0000; const IOC_IN: u64 = 0x8000_0000;
const fn iowr(n: u64, len: u64) -> u64 { IOC_INOUT | ((len & 0x1fff) << 16) | (0x64 << 8) | n }
const DKIOCCDREAD: u64 = iowr(96, 32);
const DKIOCCDREADISRC: u64 = iowr(97, 16);
const DKIOCCDREADMCN: u64 = iowr(98, 16);
const DKIOCCDSETSPEED: u64 = IOC_IN | (2 << 16) | (0x64 << 8) | 99;
const DKIOCCDREADTOC: u64 = iowr(100, 24);

#[repr(C)] struct CdRead { offset: u64, area: u8, kind: u8, reserved: [u8; 10], len: u32, buf: *mut u8 }
#[repr(C)] struct CdReadToc { format: u8, as_time: u8, reserved: [u8; 5], address: u8, reserved2: [u8; 6], len: u16, buf: *mut u8 }
#[repr(C)] struct CdIsrc { isrc: [u8; 13], track: u8, reserved: [u8; 2] }
#[repr(C)] struct CdMcn { mcn: [u8; 14], reserved: [u8; 2] }
const _: () = { assert!(std::mem::size_of::<CdRead>() == 32); assert!(std::mem::size_of::<CdReadToc>() == 24); assert!(std::mem::size_of::<CdIsrc>() == 16); assert!(std::mem::size_of::<CdMcn>() == 16); };

fn errno() -> std::io::Error { std::io::Error::last_os_error() }

pub struct MacBackend;

/// `drutil list` rows: (index, vendor, product, revision); `drutil -drive N status` → "Name: /dev/diskX".
fn drutil_drives() -> Vec<(String, String, String, String, Option<String>)> {
    let out = Command::new("drutil").arg("list").output().ok().map(|o| String::from_utf8_lossy(&o.stdout).to_string()).unwrap_or_default();
    let mut header: Option<(usize, usize, usize, usize)> = None; let mut v = vec![];
    for line in out.lines() {
        if line.contains("Vendor") && line.contains("Product") { header = Some((line.find("Vendor").unwrap(), line.find("Product").unwrap(), line.find("Rev").unwrap_or(line.len()), line.find("Bus").unwrap_or(line.len()))); continue; }
        let Some((a, b, c, d)) = header else { continue }; let n = line.split_whitespace().next().unwrap_or("");
        if n.parse::<u32>().is_err() || line.len() < b { continue; }
        let col = |x: usize, y: usize| line.get(x..y.min(line.len())).unwrap_or("").trim().to_string();
        let status = Command::new("drutil").args(["-drive", n, "status"]).output().ok().map(|o| String::from_utf8_lossy(&o.stdout).to_string()).unwrap_or_default();
        let dev = status.lines().find_map(|l| l.trim().strip_prefix("Name:").map(|s| s.trim().to_string()));
        v.push((n.to_string(), col(a, b), col(b, c), col(c, d), dev));
    }
    v
}

impl Backend for MacBackend {
    fn name(&self) -> &'static str { "macos-iokit" }
    fn drives(&self) -> Result<Vec<DriveInfo>> {
        Ok(drutil_drives().into_iter().map(|(n, vendor, model, revision, dev)| {
            let path = dev.clone().map(|d| d.replace("/dev/disk", "/dev/rdisk")).unwrap_or_default();
            DriveInfo { id: format!("drive{n}"), vendor, model, revision, has_disc: dev.is_some(), path }
        }).collect())
    }
    fn open(&self, id: &str) -> Result<Box<dyn Drive>> {
        let info = self.drives()?.into_iter().find(|d| d.id == id).ok_or_else(|| Error::NotFound(id.into()))?;
        if info.path.is_empty() { return Err(Error::NoDisc); }
        let c = CString::new(info.path.clone()).unwrap();
        let fd = unsafe { libc::open(c.as_ptr(), libc::O_RDONLY | libc::O_NONBLOCK) };
        if fd < 0 { let e = errno(); return Err(if e.kind() == std::io::ErrorKind::PermissionDenied { Error::Permission(format!("{}: {e}", info.path)) } else { Error::Io(format!("{}: {e}", info.path)) }); }
        let mut d = MacDrive { fd, info, caps: None }; d.toc()?; Ok(Box::new(d))
    }
}

pub struct MacDrive { fd: i32, info: DriveInfo, caps: Option<Capabilities> }
impl Drop for MacDrive { fn drop(&mut self) { unsafe { libc::close(self.fd); } } }

impl MacDrive {
    fn raw_read(&self, lba: i32, count: u32, area: u8) -> std::result::Result<Vec<u8>, std::io::Error> {
        let block = SECTOR_BYTES as u64 + if area & AREA_C2 != 0 { C2_BYTES as u64 } else { 0 } + if area & AREA_SUBQ != 0 { SUBQ_BYTES as u64 } else { 0 };
        if lba < 0 { return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "lead-in is not readable")); }
        let mut buf = vec![0u8; (block * count as u64) as usize];
        let mut r = CdRead { offset: lba as u64 * block, area, kind: TYPE_CDDA, reserved: [0; 10], len: buf.len() as u32, buf: buf.as_mut_ptr() };
        if unsafe { libc::ioctl(self.fd, DKIOCCDREAD as libc::c_ulong, &mut r) } < 0 { return Err(errno()); }
        if (r.len as usize) < buf.len() { return Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, format!("short read: {} of {} bytes", r.len, buf.len()))); }
        Ok(buf)
    }
}

/// Parse a full TOC (MMC READ TOC format 0010b): 4-byte header, then 11-byte descriptors.
pub fn parse_full_toc(b: &[u8]) -> Result<Toc> {
    if b.len() < 4 { return Err(Error::NoDisc); }
    let len = (u16::from_be_bytes([b[0], b[1]]) as usize + 2).min(b.len());
    let mut tracks: Vec<Track> = vec![]; let mut leadout: Option<i32> = None;
    for d in b[4..len].chunks_exact(11) {
        let (session, ctrl, point) = (d[0], d[1] & 0x0f, d[3]); let adr = d[1] >> 4; if adr != 1 { continue; }
        let lba = msf_to_lba(d[8], d[9], d[10]);
        match point {
            1..=99 => tracks.push(Track { number: point, start: lba, audio: ctrl & 0x04 == 0, preemphasis: ctrl & 0x01 != 0, session, pregap: 0, isrc: None }),
            0xA2 => leadout = Some(leadout.map_or(lba, |l: i32| l.max(lba))),
            _ => {}
        }
    }
    tracks.sort_by_key(|t| t.number); tracks.dedup_by_key(|t| t.number);
    if tracks.is_empty() || !tracks.iter().any(|t| t.audio) { return Err(Error::NoDisc); }
    Ok(Toc { tracks, leadout: leadout.ok_or(Error::NoDisc)?, mcn: None })
}

impl Drive for MacDrive {
    fn info(&self) -> DriveInfo { self.info.clone() }
    fn capabilities(&mut self) -> Capabilities {
        if let Some(c) = &self.caps { return c.clone(); }
        let c = Capabilities {
            c2: self.raw_read(0, 1, AREA_USER | AREA_C2).is_ok(), subchannel_q: self.raw_read(0, 1, AREA_USER | AREA_SUBQ).is_ok(),
            set_speed: true, isrc: true, mcn: true, overread_leadin: false, overread_leadout: false,
        };
        self.caps = Some(c.clone()); c
    }
    fn toc(&mut self) -> Result<Toc> {
        let mut buf = vec![0u8; 4 + 11 * 110];
        let mut r = CdReadToc { format: 2, as_time: 1, reserved: [0; 5], address: 0, reserved2: [0; 6], len: buf.len() as u16, buf: buf.as_mut_ptr() };
        if unsafe { libc::ioctl(self.fd, DKIOCCDREADTOC as libc::c_ulong, &mut r) } < 0 { let e = errno(); return Err(if e.raw_os_error() == Some(libc::ENOTTY) { Error::Unsupported(format!("{} is not a CD", self.info.path)) } else { Error::Io(format!("reading the TOC: {e}")) }); }
        buf.truncate(r.len as usize); parse_full_toc(&buf)
    }
    fn read(&mut self, lba: i32, count: u32, opts: ReadOpts) -> Result<Sectors> {
        let area = AREA_USER | if opts.c2 { AREA_C2 } else { 0 } | if opts.subq { AREA_SUBQ } else { 0 };
        let raw = self.raw_read(lba, count, area).map_err(|e| Error::Read { lba, msg: e.to_string() })?;
        if area == AREA_USER { return Ok(Sectors { audio: raw, c2: None, subq: None }); }
        let block = raw.len() / count as usize; let mut s = Sectors { audio: Vec::with_capacity(count as usize * SECTOR_BYTES), c2: opts.c2.then(Vec::new), subq: opts.subq.then(Vec::new) };
        for blk in raw.chunks_exact(block) {          // per sector: user data, then C2, then subchannel (MMC READ CD order)
            s.audio.extend(&blk[..SECTOR_BYTES]); let mut at = SECTOR_BYTES;
            if let Some(v) = s.c2.as_mut() { v.extend(&blk[at..at + C2_BYTES]); at += C2_BYTES; }
            if let Some(v) = s.subq.as_mut() { v.extend(&blk[at..at + SUBQ_BYTES]); }
        }
        Ok(s)
    }
    fn set_speed(&mut self, kbps: Option<u16>) -> Result<()> {
        let mut v: u16 = kbps.unwrap_or(0xFFFF);
        if unsafe { libc::ioctl(self.fd, DKIOCCDSETSPEED as libc::c_ulong, &mut v) } < 0 { return Err(Error::Io(format!("set speed: {}", errno()))); } Ok(())
    }
    fn isrc(&mut self, track: u8) -> Option<String> {
        let mut r = CdIsrc { isrc: [0; 13], track, reserved: [0; 2] };
        if unsafe { libc::ioctl(self.fd, DKIOCCDREADISRC as libc::c_ulong, &mut r) } < 0 { return None; }
        let s: String = r.isrc.iter().take_while(|c| **c != 0).map(|c| *c as char).collect(); (!s.is_empty()).then_some(s)
    }
    fn mcn(&mut self) -> Option<String> {
        let mut r = CdMcn { mcn: [0; 14], reserved: [0; 2] };
        if unsafe { libc::ioctl(self.fd, DKIOCCDREADMCN as libc::c_ulong, &mut r) } < 0 { return None; }
        let s: String = r.mcn.iter().take_while(|c| **c != 0).map(|c| *c as char).collect(); (!s.trim_matches('0').is_empty()).then_some(s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn ioctl_numbers_match_the_sdk() {
        // values of the SDK macros (_IOWR('d', n, struct) with the LP64 struct sizes)
        assert_eq!(DKIOCCDREAD, 0xC020_6460); assert_eq!(DKIOCCDREADTOC, 0xC018_6464); assert_eq!(DKIOCCDSETSPEED, 0x8002_6463);
        assert_eq!(DKIOCCDREADISRC, 0xC010_6461); assert_eq!(DKIOCCDREADMCN, 0xC010_6462);
    }
    #[test] fn full_toc_with_a_data_session() {
        // 2 audio tracks in session 1, a data track in session 2 (Enhanced CD)
        let mut b = vec![0, 0, 1, 2]; let desc = |s: u8, ctrl: u8, point: u8, m: u8, sec: u8, f: u8| vec![s, 0x10 | ctrl, 0, point, 0, 0, 0, 0, m, sec, f];
        for d in [desc(1, 0, 0xA0, 1, 0, 0), desc(1, 0, 0xA1, 2, 0, 0), desc(1, 0, 0xA2, 10, 0, 0), desc(1, 0, 1, 0, 2, 0), desc(1, 1, 2, 4, 0, 0), desc(2, 4, 3, 13, 0, 0), desc(2, 4, 0xA2, 20, 0, 0), desc(1, 0, 0xB0, 0, 0, 0).into_iter().map(|x| x).collect()] { b.extend(d); }
        let n = (b.len() - 2) as u16; b[0..2].copy_from_slice(&n.to_be_bytes());
        let t = parse_full_toc(&b).unwrap();
        assert_eq!(t.tracks.len(), 3); assert_eq!(t.tracks[0].start, 0); assert!(t.tracks[1].preemphasis); assert!(!t.tracks[2].audio); assert_eq!(t.tracks[2].session, 2);
        assert_eq!(t.leadout, msf_to_lba(20, 0, 0));
    }
}
