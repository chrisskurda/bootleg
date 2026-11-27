// The `secret_*` commands: JS's way into the OS credential store (bootleg_plugin_api::secrets, docs/SECRETS.md).
// async: a keychain call can wait on the user (an unlock or access prompt), which must not block the main thread.
use bootleg_plugin_api::secrets::{self, Status};

#[tauri::command]
pub fn secret_status() -> Status { secrets::status() }
#[tauri::command]
pub async fn secret_get(key: String) -> Result<Option<String>, String> { secrets::get(&key) }
#[tauri::command]
pub async fn secret_set(key: String, value: String) -> Result<(), String> { secrets::set(&key, &value) }
#[tauri::command]
pub async fn secret_delete(key: String) -> Result<(), String> { secrets::delete(&key) }
