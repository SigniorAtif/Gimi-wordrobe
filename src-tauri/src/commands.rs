//! Thin `#[tauri::command]` wrappers over `core` (SPEC §13). No disk logic lives here.

use crate::core::error::{AppError, AppResult};
use crate::core::model::{DiskState, HashIndexInfo, Library, Settings, Snapshot};
use serde::Deserialize;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

/// Let the webview load images from the Library only (previews, portraits) via the asset protocol (SPEC §10).
pub fn sync_asset_scope(app: &AppHandle, settings: &Settings) {
    let lib = settings.library_path.trim();
    if !lib.is_empty() {
        let _ = app.asset_protocol_scope().allow_directory(lib, true);
    }
}

#[derive(Default)]
pub struct AppState {
    pub settings: Mutex<Settings>,
}

fn snapshot(settings: &Settings) -> Snapshot {
    Snapshot {
        settings: settings.clone(),
        library: Library::default(),
        disk: DiskState::default(),
        changed_outside: false,
        recovered: None,
        hash_index: HashIndexInfo::default(),
        configured: settings.is_configured(),
    }
}

#[tauri::command]
pub fn load(state: State<'_, AppState>) -> AppResult<Snapshot> {
    let s = state.settings.lock().map_err(|_| AppError::new("state", "state poisoned"))?;
    Ok(snapshot(&s))
}

#[tauri::command]
pub fn rescan(state: State<'_, AppState>) -> AppResult<Snapshot> {
    load(state)
}

#[tauri::command]
pub fn save_settings(app: AppHandle, state: State<'_, AppState>, settings: Settings) -> AppResult<Snapshot> {
    let mut s = state.settings.lock().map_err(|_| AppError::new("state", "state poisoned"))?;
    sync_asset_scope(&app, &settings);
    *s = settings;
    Ok(snapshot(&s))
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum OpenTarget {
    Mods,
    Library,
    #[serde(rename_all = "camelCase")]
    Skin { skin_id: String },
    #[serde(rename_all = "camelCase")]
    Entity { entity_id: String },
}

#[tauri::command]
pub fn open_folder(_target: OpenTarget) -> AppResult<()> {
    Err(AppError::new("not_ready", "Opening folders arrives with the Settings milestone."))
}
