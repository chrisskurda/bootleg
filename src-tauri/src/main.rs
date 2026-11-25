// bootleg — desktop shell. The app is the static frontend in ../dist; this shell adds:
//   * dialogs + fs (plugins) to pick and scan folders,
//   * `allow_path`: nothing is readable until the user picks it — the picked folder/file is added to the
//     asset-protocol scope (audio streaming, range reads for tags) and the fs scope at runtime,
//   * a headless self-test hook (BOOTLEG_SELFTEST=<music dir>, BOOTLEG_SELFTEST_OUT=<result json>).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{env, fs, path::PathBuf};
mod dlna;
mod lan;

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
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

// ---- cast / network outputs ----------------------------------------------------------------------------------------
/// Makes an already-allowed local file fetchable from other devices on the network; returns its LAN URL.
#[tauri::command]
fn lan_share(app: AppHandle, path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    if !app.asset_protocol_scope().is_allowed(&p) { return Err("that file has not been opened in bootleg".into()); }
    lan::share(&p)
}
/// Shares small in-memory data (cover art) — base64 from the page — and returns its LAN URL.
#[tauri::command]
fn lan_share_bytes(data_b64: String, mime: String) -> Result<String, String> {
    use base64::Engine;
    if data_b64.len() > 12_000_000 { return Err("too large".into()); }
    let bytes = base64::engine::general_purpose::STANDARD.decode(data_b64).map_err(|e| e.to_string())?;
    lan::share_bytes(bytes, &mime)
}
#[tauri::command]
fn lan_mime(path: String) -> String { lan::mime_of(&path).to_string() }
#[tauri::command]
async fn dlna_discover(timeout_ms: u64) -> Result<Vec<dlna::Device>, String> {
    tauri::async_runtime::spawn_blocking(move || dlna::ssdp(std::time::Duration::from_millis(timeout_ms.clamp(500, 8000))).into_iter().filter_map(|l| dlna::describe(&l).ok()).collect()).await.map_err(|e| e.to_string())
}
#[tauri::command]
async fn dlna_add(location: String) -> Result<dlna::Device, String> { tauri::async_runtime::spawn_blocking(move || dlna::describe(&location)).await.map_err(|e| e.to_string())? }
#[tauri::command]
async fn dlna_play(av: String, url: String, title: String, artist: String, album: String, mime: String, art: Option<String>) -> Result<(), String> { tauri::async_runtime::spawn_blocking(move || dlna::play(&av, &url, &title, &artist, &album, &mime, art.as_deref().unwrap_or(""))).await.map_err(|e| e.to_string())? }
#[tauri::command]
async fn dlna_transport(av: String, action: String) -> Result<(), String> { tauri::async_runtime::spawn_blocking(move || dlna::transport(&av, &action)).await.map_err(|e| e.to_string())? }
#[tauri::command]
async fn dlna_seek(av: String, secs: f64) -> Result<(), String> { tauri::async_runtime::spawn_blocking(move || dlna::seek(&av, secs)).await.map_err(|e| e.to_string())? }
#[tauri::command]
async fn dlna_volume(rc: String, volume: u8) -> Result<(), String> { tauri::async_runtime::spawn_blocking(move || dlna::volume(&rc, volume)).await.map_err(|e| e.to_string())? }
#[tauri::command]
async fn dlna_status(av: String) -> Result<dlna::Status, String> { tauri::async_runtime::spawn_blocking(move || dlna::status(&av)).await.map_err(|e| e.to_string())? }

// ---- visualizer screens: a borderless fullscreen window on a chosen display (an HDMI/AirPlay-mirrored screen, a projector…)
#[derive(serde::Serialize)]
struct Mon { index: usize, name: String, w: u32, h: u32, primary: bool }
#[tauri::command]
fn screens_list(app: AppHandle) -> Result<Vec<Mon>, String> {
    let prim = app.primary_monitor().map_err(|e| e.to_string())?.map(|m| (m.position().x, m.position().y));
    Ok(app.available_monitors().map_err(|e| e.to_string())?.iter().enumerate().map(|(i, m)| Mon { index: i, name: m.name().cloned().unwrap_or_else(|| format!("Display {}", i + 1)), w: m.size().width, h: m.size().height, primary: prim == Some((m.position().x, m.position().y)) }).collect())
}
#[tauri::command]
async fn screen_open(app: AppHandle, index: usize) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("screen") { let _ = w.close(); }
    let mons = app.available_monitors().map_err(|e| e.to_string())?; let m = mons.get(index).ok_or("no such display")?;
    let f = m.scale_factor();
    let w = WebviewWindowBuilder::new(&app, "screen", WebviewUrl::App("screen.html".into())).title("bootleg visualizer").position(m.position().x as f64 / f + 40.0, m.position().y as f64 / f + 40.0).inner_size(960.0, 540.0).build().map_err(|e| e.to_string())?;
    w.set_fullscreen(true).map_err(|e| e.to_string())
}
#[tauri::command]
fn screen_close(app: AppHandle) { if let Some(w) = app.get_webview_window("screen") { let _ = w.close(); } }

/// Some(dir) when launched for the self-test.
#[tauri::command]
fn selftest_config() -> Option<String> { env::var("BOOTLEG_SELFTEST").ok() }

/// Some(url) when the self-test should also exercise a Subsonic server (BOOTLEG_SELFTEST_SUBSONIC).
#[tauri::command]
fn selftest_subsonic() -> Option<String> { env::var("BOOTLEG_SELFTEST_SUBSONIC").ok() }

/// Some(description URL) when the self-test should also drive a (mock) DLNA renderer.
#[tauri::command]
fn selftest_dlna() -> Option<String> { env::var("BOOTLEG_SELFTEST_DLNA").ok() }

#[tauri::command]
fn selftest_done(app: AppHandle, result: String) {
    if let Ok(out) = env::var("BOOTLEG_SELFTEST_OUT") { let _ = fs::write(out, result); }
    app.exit(0);
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![allow_path, screens_list, screen_open, screen_close, lan_share, lan_share_bytes, lan_mime, dlna_discover, dlna_add, dlna_play, dlna_transport, dlna_seek, dlna_volume, dlna_status, selftest_config, selftest_subsonic, selftest_dlna, selftest_done])
        .setup(|app| {
            // Self-test runs with a flag injected into the page so it never touches the user's real settings, library or notes.
            let mut b = WebviewWindowBuilder::new(app, "main", WebviewUrl::default()).title("bootleg").inner_size(1360.0, 860.0).min_inner_size(900.0, 600.0);
            if env::var("BOOTLEG_SELFTEST").is_ok() { b = b.initialization_script("window.__BOOTLEG_SELFTEST = true;"); }
            let w = b.build()?;
            let _ = w.set_focus();
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running bootleg");
}
