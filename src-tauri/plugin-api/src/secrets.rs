// Secrets (passwords, tokens, API keys, certificates: any credential) in the OS credential store: the macOS Keychain,
// the Windows Credential Manager, or the Secret Service on Linux (GNOME Keyring, KWallet). See docs/SECRETS.md.
//
// Every item is stored under the service "org.skurda.bootleg" with the key as the account name:
//   source/<plugin>/<connection>   a library connection's secret config (written by the app's JS)
//   plugin/<id>/<name>             a plugin's own secrets: `plugin(id)` here, `api.secrets` in JS (the same items)
// The core exposes this to JS as the `secret_*` commands; JS falls back to app storage when `status()` says there is
// no store. The self-test (and BOOTLEG_SECRETS=memory) uses a store in memory, so it never touches the real keychain.
use std::{collections::HashMap, sync::{Arc, Mutex, OnceLock}};

use keyring_core::{CredentialStore, Entry, Error};
use serde::Serialize;

const SERVICE: &str = "org.skurda.bootleg";

enum Backend {
    Os(Arc<CredentialStore>, &'static str),
    Memory(Mutex<HashMap<String, String>>),
    None(String),
}

static BACKEND: OnceLock<Backend> = OnceLock::new();

fn os_store() -> Result<(Arc<CredentialStore>, &'static str), Error> {
    #[cfg(target_os = "macos")]
    { Ok((apple_native_keyring_store::keychain::Store::new()?, "macOS Keychain")) }
    #[cfg(target_os = "windows")]
    { Ok((windows_native_keyring_store::Store::new()?, "Windows Credential Manager")) }
    #[cfg(target_os = "linux")]
    { Ok((zbus_secret_service_keyring_store::Store::new()?, "Secret Service")) }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    { Err(Error::NotSupportedByStore("no credential store on this platform".into())) }
}

fn backend() -> &'static Backend {
    BACKEND.get_or_init(|| {
        let memory = std::env::var("BOOTLEG_SECRETS").map(|v| v == "memory").unwrap_or(false) || std::env::var("BOOTLEG_SELFTEST").is_ok();
        if memory { return Backend::Memory(Mutex::new(HashMap::new())); }
        match os_store() { Ok((s, name)) => Backend::Os(s, name), Err(e) => Backend::None(e.to_string()) }
    })
}

/// Keys are short, ASCII and path-like, so they read well in Keychain Access and can't be confused with each other.
fn check_key(key: &str) -> Result<(), String> {
    let ok = !key.is_empty() && key.len() <= 200 && key.bytes().all(|b| b.is_ascii_alphanumeric() || b"/:._-".contains(&b));
    if ok { Ok(()) } else { Err(format!("bad secret key {key:?}")) }
}

fn entry(store: &Arc<CredentialStore>, key: &str) -> Result<Entry, String> { Entry::new_in_store(store, SERVICE, key).map_err(|e| e.to_string()) }

#[derive(Serialize, Clone, Debug)]
pub struct Status { pub store: String, pub kind: &'static str, pub error: Option<String> }

/// Where secrets go on this machine: `kind` is "os", "memory" or "none".
pub fn status() -> Status {
    match backend() {
        Backend::Os(_, name) => Status { store: name.to_string(), kind: "os", error: None },
        Backend::Memory(_) => Status { store: "memory (self-test)".into(), kind: "memory", error: None },
        Backend::None(e) => Status { store: String::new(), kind: "none", error: Some(e.clone()) },
    }
}

pub fn get(key: &str) -> Result<Option<String>, String> {
    check_key(key)?;
    match backend() {
        Backend::Os(s, _) => match entry(s, key)?.get_password() { Ok(v) => Ok(Some(v)), Err(Error::NoEntry) => Ok(None), Err(e) => Err(e.to_string()) },
        Backend::Memory(m) => Ok(m.lock().unwrap().get(key).cloned()),
        Backend::None(e) => Err(format!("no credential store: {e}")),
    }
}

pub fn set(key: &str, value: &str) -> Result<(), String> {
    check_key(key)?;
    match backend() {
        Backend::Os(s, _) => entry(s, key)?.set_password(value).map_err(|e| e.to_string()),
        Backend::Memory(m) => { m.lock().unwrap().insert(key.to_string(), value.to_string()); Ok(()) }
        Backend::None(e) => Err(format!("no credential store: {e}")),
    }
}

pub fn delete(key: &str) -> Result<(), String> {
    check_key(key)?;
    match backend() {
        Backend::Os(s, _) => match entry(s, key)?.delete_credential() { Ok(()) | Err(Error::NoEntry) => Ok(()), Err(e) => Err(e.to_string()) },
        Backend::Memory(m) => { m.lock().unwrap().remove(key); Ok(()) }
        Backend::None(e) => Err(format!("no credential store: {e}")),
    }
}

/// A native plugin's own secrets, in the same `plugin/<id>/<name>` items its JS half reaches with `api.secrets`.
/// Calls can block on the user (an unlock or access prompt): make them from a job or another worker thread.
pub fn plugin(id: &str) -> Scoped { Scoped(format!("plugin/{id}/")) }
pub struct Scoped(String);
impl Scoped {
    fn key(&self, name: &str) -> Result<String, String> {
        if name.is_empty() || name.len() > 80 || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b)) { return Err(format!("bad secret name {name:?}")); }
        Ok(format!("{}{name}", self.0))
    }
    pub fn get(&self, name: &str) -> Result<Option<String>, String> { get(&self.key(name)?) }
    pub fn set(&self, name: &str, value: &str) -> Result<(), String> { set(&self.key(name)?, value) }
    pub fn delete(&self, name: &str) -> Result<(), String> { delete(&self.key(name)?) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn keys() {
        assert!(check_key("source/subsonic/c1a2").is_ok());
        assert!(check_key("plugin/scrobble/listenbrainz.token").is_ok());
        for bad in ["", "a b", "x\n", "ünï", &"k".repeat(201)] { assert!(check_key(bad).is_err(), "{bad:?}"); }
    }
    /// The real OS store (writes one item and deletes it again): `cargo test secrets -- --ignored`
    #[test]
    #[ignore]
    fn os_roundtrip() {
        let (store, name) = os_store().expect("credential store");
        let e = Entry::new_in_store(&store, SERVICE, "test/bootleg-check").unwrap();
        e.set_password("s3cret").unwrap();
        assert_eq!(e.get_password().unwrap(), "s3cret", "{name}");
        e.delete_credential().unwrap();
        assert!(matches!(e.get_password(), Err(Error::NoEntry)));
    }
    #[test]
    fn memory_roundtrip() {
        std::env::set_var("BOOTLEG_SECRETS", "memory");
        assert_eq!(status().kind, "memory");
        assert_eq!(get("t/a").unwrap(), None);
        set("t/a", "s3cret").unwrap();
        assert_eq!(get("t/a").unwrap().as_deref(), Some("s3cret"));
        delete("t/a").unwrap(); delete("t/a").unwrap();
        assert_eq!(get("t/a").unwrap(), None);
        let p = plugin("scrobble");
        p.set("token", "x").unwrap();
        assert_eq!(get("plugin/scrobble/token").unwrap().as_deref(), Some("x"));
        assert!(p.get("../cd/x").is_err());
    }
}
