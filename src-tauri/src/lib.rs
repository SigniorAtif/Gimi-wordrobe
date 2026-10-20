pub mod commands;
pub mod core;
pub mod net;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager, WindowEvent};

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
        .on_window_event(|window, event| {
            // auto re-hide NSFW on minimize (SPEC §11). Minimizing shows up as a resize and a focus loss; checking
            // both means one skipped event can't leave 18+ skins showing. Re-hiding twice is harmless.
            if matches!(event, WindowEvent::Resized(_) | WindowEvent::Focused(false))
                && window.is_minimized().unwrap_or(false)
            {
                let _ = window.emit("window-minimized", ());
            }
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
            commands::pick_archive,
            commands::pick_image,
            commands::analyze_archive,
            commands::add_skin,
            commands::plan_import,
            commands::apply_import,
            commands::verify_pin,
            commands::set_pin,
            commands::gamebanana_info,
            commands::fetch_gamebanana_previews,
            commands::find_folder_previews,
            commands::add_preview,
            commands::paste_preview,
            commands::remove_preview,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
