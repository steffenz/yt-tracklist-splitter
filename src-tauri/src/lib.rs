mod cache;
mod commands;
mod media;
mod sh;
mod tracklist;
mod types;
mod ytdlp;

use std::sync::atomic::AtomicBool;
use std::sync::Mutex;
use tauri_plugin_shell::process::CommandChild;

/// Shared state: the currently-running sidecar child (for cancellation) and a cancel flag.
#[derive(Default)]
pub struct AppState {
    pub current_child: Mutex<Option<CommandChild>>,
    pub cancel: AtomicBool,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::fetch_info,
            commands::detect_tracklists,
            commands::parse_tracklist,
            commands::get_thumbnail,
            commands::default_output_dir,
            commands::ytdlp_version,
            commands::update_ytdlp,
            commands::clear_cache,
            commands::cancel_job,
            commands::run_job,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
