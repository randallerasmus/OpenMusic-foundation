#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use openmusic_core::MusicApp;
use serde_json::Value;
use std::{path::PathBuf, sync::Arc};

// Commands run on a blocking worker, not the UI thread: some (folder scans, lyrics lookups) take seconds.
#[tauri::command]
async fn music_command(app: tauri::State<'_, Arc<MusicApp>>, command: String, args: Value) -> Result<Value, String> {
    let app = Arc::clone(app.inner());
    tauri::async_runtime::spawn_blocking(move || app.execute(&command, args)).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())
}
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            use tauri::Manager;
            let directory=app.path().app_data_dir().map_err(|e|e.to_string())?;
            std::fs::create_dir_all(&directory)?;
            let db=PathBuf::from(directory).join("openmusic.sqlite");
            let music=MusicApp::open(db).map_err(|e|e.to_string())?;
            app.manage(Arc::new(music));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![music_command])
        .run(tauri::generate_context!())
        .expect("Tauri application could not start");
}
