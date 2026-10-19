pub mod commands;
pub mod core;
pub mod net;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // SKIN_SWITCHER_CONFIG_DIR isolates e2e runs from the real settings.
            let config_dir = std::env::var_os("SKIN_SWITCHER_CONFIG_DIR")
                .map(PathBuf::from)
                .map(Ok)
                .unwrap_or_else(|| app.path().app_config_dir())?;
            std::fs::create_dir_all(&config_dir)?;
            let core = core::app::AppCore::open_with(&config_dir, app.path().resource_dir().ok());
            commands::sync_asset_scope(app.handle(), core.settings());
            app.manage(commands::AppState(Arc::new(Mutex::new(core))));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::load,
            commands::rescan,
            commands::save_settings,
            commands::first_run_defaults,
            commands::update_hash_index,
            commands::open_folder,
            commands::apply,
            commands::remove_skin,
            commands::update_skin,
            commands::update_entity,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
