//! Free space, filesystem type and removable mounts. Best effort per OS.
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Disk {
    pub free: u64,
    pub total: u64,
    /// FAT32 (or older FAT): no single file may reach 4 GiB
    pub fat32: bool,
}

pub const FAT32_MAX_FILE: u64 = 4 * 1024 * 1024 * 1024 - 1;

#[cfg(unix)]
pub fn info(path: &Path) -> std::io::Result<Disk> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let c = CString::new(path.as_os_str().as_bytes()).map_err(|_| std::io::Error::other("path has a NUL byte"))?;
    let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut s) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    let frsize = if s.f_frsize > 0 { s.f_frsize as u64 } else { s.f_bsize as u64 };
    Ok(Disk { free: s.f_bavail as u64 * frsize, total: s.f_blocks as u64 * frsize, fat32: is_fat32(path) })
}

#[cfg(not(unix))]
pub fn info(_path: &Path) -> std::io::Result<Disk> {
    Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "free space is not implemented on this OS yet"))
}

#[cfg(target_os = "macos")]
fn is_fat32(path: &Path) -> bool {
    use std::ffi::{CStr, CString};
    use std::os::unix::ffi::OsStrExt;
    let Ok(c) = CString::new(path.as_os_str().as_bytes()) else { return false };
    let mut s: libc::statfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statfs(c.as_ptr(), &mut s) } != 0 {
        return false;
    }
    let name = unsafe { CStr::from_ptr(s.f_fstypename.as_ptr()) };
    name.to_bytes() == b"msdos"
}

#[cfg(target_os = "linux")]
fn is_fat32(path: &Path) -> bool {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let Ok(c) = CString::new(path.as_os_str().as_bytes()) else { return false };
    let mut s: libc::statfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statfs(c.as_ptr(), &mut s) } != 0 {
        return false;
    }
    s.f_type as i64 == 0x4d44 // MSDOS_SUPER_MAGIC (vfat)
}

#[cfg(all(unix, not(any(target_os = "macos", target_os = "linux"))))]
fn is_fat32(_: &Path) -> bool {
    false
}

/// Mount points of removable-looking filesystems.
pub fn removable_mounts() -> Vec<PathBuf> {
    #[cfg(target_os = "linux")]
    {
        const TYPES: [&str; 8] = ["vfat", "exfat", "msdos", "ntfs", "ntfs3", "fuseblk", "hfsplus", "sdcardfs"];
        let text = std::fs::read_to_string("/proc/self/mounts").unwrap_or_default();
        let mut v: Vec<PathBuf> = text
            .lines()
            .filter_map(|l| {
                let mut f = l.split_whitespace();
                let (_dev, mnt, ty) = (f.next()?, f.next()?, f.next()?);
                (TYPES.contains(&ty) && mnt != "/" && !mnt.starts_with("/boot")).then(|| PathBuf::from(mnt.replace("\\040", " ")))
            })
            .collect();
        v.dedup();
        v
    }
    #[cfg(target_os = "macos")]
    {
        std::fs::read_dir("/Volumes")
            .map(|r| r.flatten().map(|e| e.path()).filter(|p| std::fs::read_link(p).is_err()).collect())
            .unwrap_or_default()
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        vec![]
    }
}

/// Hide `.bootleg/` from players that show dot-folders. Windows: FAT hidden attribute. Elsewhere the
/// leading dot already hides it on Unix-like firmware.
pub fn hide(_dir: &Path) {
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("attrib").arg("+h").arg(_dir).status();
    }
}
