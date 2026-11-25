// bootleg — desktop shell. The app is the static frontend in ../dist; this shell adds:
//   * dialogs + fs (plugins) to pick and scan folders,
//   * `allow_path`: nothing is readable until the user picks it — the picked folder/file is added to the
//     asset-protocol scope (audio streaming, range reads for tags) and the fs scope at runtime,
//   * a headless self-test hook (BOOTLEG_SELFTEST=<music dir>, BOOTLEG_SELFTEST_OUT=<result json>).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{env, fs, path::PathBuf};
use tauri::{AppHandle, Manager};
use tauri_plugin_fs::FsExt;

#[tauri::command]
fn allow_path(app: AppHandle, path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.exists() { return Err(format!("no such path: {path}")); }
    let (asset, files) = (app.asset_protocol_scope(), app.fs_scope());
    if p.is_dir() {
        asset.allow_directory(&p, true).map_err(|e| e.to_string())?;
        files.allow_directory(&p, true).map_err(|e| e.to_string())?;
    } else {
        asset.allow_file(&p).map_err(|e| e.to_string())?;
        files.allow_file(&p).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Some(dir) when launched for the self-test.
#[tauri::command]
fn selftest_config() -> Option<String> { env::var("BOOTLEG_SELFTEST").ok() }

#[tauri::command]
fn selftest_done(app: AppHandle, result: String) {
    if let Ok(out) = env::var("BOOTLEG_SELFTEST_OUT") { let _ = fs::write(out, result); }
    app.exit(0);
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![allow_path, selftest_config, selftest_done])
        .setup(|app| {
            if let Some(w) = app.get_webview_window("main") { let _ = w.set_focus(); }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running bootleg");
}
