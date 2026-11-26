//! FAT32/exFAT-safe names (device format §3.3) and playlist-relative paths.
use crate::config::Profile;

const RESERVED: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
    "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

fn ascii_of(c: char) -> &'static str {
    match c {
        'À'..='Å' => "A", 'à'..='å' => "a", 'Æ' => "AE", 'æ' => "ae", 'Ç' => "C", 'ç' => "c",
        'È'..='Ë' => "E", 'è'..='ë' => "e", 'Ì'..='Ï' => "I", 'ì'..='ï' => "i", 'Ð' => "D", 'ð' => "d",
        'Ñ' => "N", 'ñ' => "n", 'Ò'..='Ö' | 'Ø' => "O", 'ò'..='ö' | 'ø' => "o", 'Ù'..='Ü' => "U", 'ù'..='ü' => "u",
        'Ý' => "Y", 'ý' | 'ÿ' => "y", 'ß' => "ss", 'Œ' => "OE", 'œ' => "oe", 'Š' => "S", 'š' => "s", 'Ž' => "Z", 'ž' => "z",
        '‘' | '’' => "'", '“' | '”' => "'", '–' | '—' => "-", '…' => "...",
        _ => "_",
    }
}

fn split_ext(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(i) if i > 0 && name.len() - i <= 6 => (&name[..i], &name[i..]),
        _ => (name, ""),
    }
}

fn cut(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// One file or folder name, safe on FAT/exFAT and within `max` characters (extension kept).
pub fn component(name: &str, ascii: bool, max: usize) -> String {
    let mut out = String::with_capacity(name.len());
    for c in name.chars() {
        if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
            out.push('_');
        } else if ascii && !c.is_ascii() {
            out.push_str(ascii_of(c));
        } else {
            out.push(c);
        }
    }
    let mut s = out.trim().trim_end_matches(['.', ' ']).trim_start_matches(' ').to_string();
    if s.is_empty() || s.chars().all(|c| c == '.') {
        s = "_".into();
    }
    let (stem, ext) = split_ext(&s);
    if RESERVED.iter().any(|r| r.eq_ignore_ascii_case(stem)) {
        s = format!("{stem}_{ext}");
    }
    let max = max.max(8);
    if s.chars().count() > max {
        let (stem, ext) = split_ext(&s);
        let keep = max.saturating_sub(ext.chars().count()).max(1);
        s = format!("{}{}", cut(stem, keep).trim_end_matches(['.', ' ']), ext);
    }
    s
}

/// Make a volume-relative path (`root` + `rel`) safe: every component of `rel` cleaned, then folders
/// shortened (then the file name) until the whole path fits `max_path`. `root` is used as given.
pub fn safe_path(root: &str, rel: &str, p: &Profile) -> String {
    let mut parts: Vec<String> = rel
        .replace('\\', "/")
        .split('/')
        .filter(|c| !c.is_empty() && *c != "." && *c != "..")
        .map(|c| component(c, p.ascii, p.max_component))
        .collect();
    if parts.is_empty() {
        parts.push("_".into());
    }
    let join = |parts: &[String]| if root.is_empty() { parts.join("/") } else { format!("{root}/{}", parts.join("/")) };
    let len = |parts: &[String]| join(parts).chars().count();
    let max_path = p.max_path.max(root.chars().count() + 16);
    // shorten folders, longest first, down to 16 chars each; then the file name
    while len(&parts) > max_path {
        let n = parts.len();
        let longest = (0..n.saturating_sub(1)).filter(|&i| parts[i].chars().count() > 16).max_by_key(|&i| parts[i].chars().count());
        match longest {
            Some(i) => {
                let c = parts[i].chars().count();
                let over = len(&parts) - max_path;
                parts[i] = component(&cut(&parts[i], c.saturating_sub(over).max(16)), p.ascii, p.max_component);
            }
            None => {
                let over = len(&parts) - max_path;
                let last = &parts[n - 1];
                let target = last.chars().count().saturating_sub(over).max(12);
                let shorter = component(last, p.ascii, target);
                if shorter.chars().count() >= last.chars().count() {
                    break;
                }
                parts[n - 1] = shorter;
            }
        }
    }
    join(&parts)
}

/// `a/b/Song.flac` → `a/b/Song (bootleg).flac`, `(bootleg 2)`, … for name collisions with foreign files.
pub fn alternative(path: &str, n: u32) -> String {
    let (dir, file) = match path.rfind('/') {
        Some(i) => (&path[..=i], &path[i + 1..]),
        None => ("", path),
    };
    let (stem, ext) = split_ext(file);
    let tag = if n <= 1 { " (bootleg)".to_string() } else { format!(" (bootleg {n})") };
    format!("{dir}{stem}{tag}{ext}")
}

/// Path of `to` as seen from the folder `from_dir` (both volume-relative, `/`-separated).
pub fn relative(from_dir: &str, to: &str) -> String {
    let a: Vec<&str> = from_dir.split('/').filter(|c| !c.is_empty()).collect();
    let b: Vec<&str> = to.split('/').filter(|c| !c.is_empty()).collect();
    let common = a.iter().zip(&b).take_while(|(x, y)| x.eq_ignore_ascii_case(y)).count();
    let mut out: Vec<&str> = vec![".."; a.len() - common];
    out.extend(&b[common..]);
    out.join("/")
}

/// Case-insensitive key for a volume-relative path (FAT and exFAT ignore case).
pub fn key(path: &str) -> String {
    path.to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleans_components() {
        assert_eq!(component("AC/DC: Live?", false, 128), "AC_DC_ Live_");
        assert_eq!(component("trailing. . ", false, 128), "trailing");
        assert_eq!(component("CON.mp3", false, 128), "CON_.mp3");
        assert_eq!(component("", false, 128), "_");
        assert_eq!(component("...", false, 128), "_");
        assert_eq!(component("Sigur Rós – Hoppípolla.flac", true, 128), "Sigur Ros - Hoppipolla.flac");
        let long = format!("{}.flac", "x".repeat(300));
        let c = component(&long, false, 40);
        assert_eq!(c.chars().count(), 40);
        assert!(c.ends_with(".flac"));
    }

    #[test]
    fn fits_max_path() {
        let p = Profile { max_path: 80, ..Profile::default() };
        let s = safe_path("Music/bootleg", &format!("{}/{}/01 {}.flac", "A".repeat(60), "B".repeat(60), "C".repeat(60)), &p);
        assert!(s.chars().count() <= 80, "{s} ({})", s.len());
        assert!(s.starts_with("Music/bootleg/"));
        assert!(s.ends_with(".flac"));
    }

    #[test]
    fn alternatives_and_relative() {
        assert_eq!(alternative("M/a/Song.flac", 1), "M/a/Song (bootleg).flac");
        assert_eq!(alternative("Song.flac", 3), "Song (bootleg 3).flac");
        assert_eq!(relative("Music/bootleg/Playlists", "Music/bootleg/A/B/x.mp3"), "../A/B/x.mp3");
        assert_eq!(relative("Music/bootleg/Playlists", "Other/x.mp3"), "../../../Other/x.mp3");
        assert_eq!(relative("", "x.mp3"), "x.mp3");
    }
}
