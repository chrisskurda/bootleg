//! `.bootleg/device.toml` (device format §2). Unknown keys are kept on rewrite.
use serde::{Deserialize, Serialize};

pub const FORMAT: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// copy in, never delete
    #[default]
    Add,
    /// the managed folder matches the selection
    Mirror,
    /// fill up to the space budget
    Fill,
}

impl std::str::FromStr for Mode {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, String> {
        match s {
            "add" => Ok(Mode::Add),
            "mirror" => Ok(Mode::Mirror),
            "fill" => Ok(Mode::Fill),
            _ => Err(format!("unknown mode {s:?} (add | mirror | fill)")),
        }
    }
}

/// A size written as bytes (`2000000000`) or with a unit (`"2GB"`, powers of 1000).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Size {
    Bytes(u64),
    Text(String),
}

impl Size {
    pub fn bytes(&self) -> Result<u64, String> {
        match self {
            Size::Bytes(n) => Ok(*n),
            Size::Text(s) => parse_size(s),
        }
    }
}

pub fn parse_size(s: &str) -> Result<u64, String> {
    let t = s.trim().to_ascii_uppercase();
    let split = t.find(|c: char| !(c.is_ascii_digit() || c == '.')).unwrap_or(t.len());
    let (num, unit) = t.split_at(split);
    let n: f64 = num.parse().map_err(|_| format!("bad size {s:?}"))?;
    let mul: f64 = match unit.trim() {
        "" | "B" => 1.0,
        "K" | "KB" => 1e3,
        "M" | "MB" => 1e6,
        "G" | "GB" => 1e9,
        "T" | "TB" => 1e12,
        _ => return Err(format!("bad size unit in {s:?}")),
    };
    Ok((n * mul) as u64)
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Fill {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keep_free: Option<Size>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_use: Option<u8>,
    #[serde(flatten)]
    pub extra: toml::Table,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Profile {
    pub codecs: Vec<String>,
    pub transcode_to: String,
    pub playlist: String,
    pub path_sep: String,
    pub max_component: usize,
    pub max_path: usize,
    pub ascii: bool,
    pub art_max: u32,
    pub folder_jpg: bool,
    #[serde(flatten)]
    pub extra: toml::Table,
}

impl Default for Profile {
    fn default() -> Self {
        Profile {
            codecs: ["flac", "mp3", "ogg", "opus", "m4a", "wav"].map(String::from).to_vec(),
            transcode_to: "mp3-v0".into(),
            playlist: "m3u8".into(),
            path_sep: "/".into(),
            max_component: 128,
            max_path: 240,
            ascii: false,
            art_max: 500,
            folder_jpg: false,
            extra: toml::Table::new(),
        }
    }
}

impl Profile {
    pub fn plays(&self, codec: &str) -> bool {
        self.codecs.iter().any(|c| c.eq_ignore_ascii_case(codec))
    }
    pub fn playlist_ext(&self) -> &'static str {
        if self.playlist.eq_ignore_ascii_case("m3u") { "m3u" } else { "m3u8" }
    }
}

fn d_kind() -> String { "generic".into() }
fn d_root() -> String { "Music/bootleg".into() }

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DeviceConfig {
    pub format: u32,
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default = "d_kind")]
    pub kind: String,
    #[serde(default)]
    pub mode: Mode,
    #[serde(default = "d_root")]
    pub root: String,
    #[serde(default)]
    pub created: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_sync: Option<u64>,
    #[serde(default)]
    pub playlists: Vec<String>,
    #[serde(default)]
    pub stems: bool,
    #[serde(default)]
    pub fill: Fill,
    #[serde(default)]
    pub profile: Profile,
    #[serde(flatten)]
    pub extra: toml::Table,
}

impl DeviceConfig {
    pub fn new(id: String, name: String, kind: String, mode: Mode, root: String, created: u64) -> Self {
        DeviceConfig {
            format: FORMAT, id, name, kind, mode, root: clean_root(&root), created,
            last_sync: None, playlists: vec![], stems: false,
            fill: Fill::default(), profile: Profile::default(), extra: toml::Table::new(),
        }
    }
    pub fn parse(text: &str) -> Result<Self, String> {
        let mut c: DeviceConfig = toml::from_str(text).map_err(|e| e.to_string())?;
        c.root = clean_root(&c.root);
        Ok(c)
    }
    pub fn to_toml(&self) -> Result<String, String> {
        toml::to_string(self).map_err(|e| e.to_string())
    }
    pub fn keep_free(&self) -> Result<u64, String> {
        self.fill.keep_free.as_ref().map(|s| s.bytes()).unwrap_or(Ok(0))
    }
}

/// `root` as a volume-relative path with `/`, no leading or trailing slash, no `..`.
pub fn clean_root(r: &str) -> String {
    r.replace('\\', "/").split('/').filter(|c| !c.is_empty() && *c != "." && *c != "..").collect::<Vec<_>>().join("/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes() {
        assert_eq!(parse_size("2GB").unwrap(), 2_000_000_000);
        assert_eq!(parse_size("1.5 gb").unwrap(), 1_500_000_000);
        assert_eq!(parse_size("512").unwrap(), 512);
        assert!(parse_size("3 parsecs").is_err());
    }

    #[test]
    fn defaults_and_unknown_keys_survive() {
        let text = "format = 1\nid = \"abc\"\nfuture_key = \"keep me\"\n\n[profile]\ncodecs = [\"mp3\"]\nnew_thing = 3\n\n[fill]\nkeep_free = \"2GB\"\n\n[later_table]\nx = 1\n";
        let c = DeviceConfig::parse(text).unwrap();
        assert_eq!(c.mode, Mode::Add);
        assert_eq!(c.root, "Music/bootleg");
        assert_eq!(c.profile.codecs, vec!["mp3"]);
        assert_eq!(c.profile.max_component, 128);
        assert_eq!(c.keep_free().unwrap(), 2_000_000_000);
        let again = DeviceConfig::parse(&c.to_toml().unwrap()).unwrap();
        assert_eq!(again, c);
        assert_eq!(again.extra["future_key"].as_str(), Some("keep me"));
        assert_eq!(again.profile.extra["new_thing"].as_integer(), Some(3));
        assert!(again.extra["later_table"].is_table());
    }

    #[test]
    fn root_is_cleaned() {
        assert_eq!(clean_root("/Music\\bootleg/../x/"), "Music/bootleg/x");
        assert_eq!(clean_root(""), "");
    }
}
