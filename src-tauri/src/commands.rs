//! Thin `#[tauri::command]` wrappers over `core::app::AppCore` (SPEC §13). No disk logic lives here.

use crate::core::app::AppCore;
use crate::core::error::{AppError, AppResult};
use crate::core::model::{Settings, Snapshot};
use crate::core::settings::{self, FirstRunDefaults};
use serde::Deserialize;
use std::sync::{Mutex, MutexGuard};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

/// Let the webview load images from the Library only (previews, portraits) via the asset protocol (SPEC §10).
pub fn sync_asset_scope(app: &AppHandle, settings: &Settings) {
    let lib = settings.library_path.trim();
    if !lib.is_empty() {
        let _ = app.asset_protocol_scope().allow_directory(lib, true);
    }
}

pub struct AppState(pub Mutex<AppCore>);

impl AppState {
    fn lock(&self) -> AppResult<MutexGuard<'_, AppCore>> {
        self.0.lock().map_err(|_| AppError::new("state", "Internal state is unavailable; restart the app."))
    }
}

#[tauri::command]
pub fn load(state: State<'_, AppState>) -> AppResult<Snapshot> {
    state.lock()?.load()
}

#[tauri::command]
pub fn rescan(state: State<'_, AppState>) -> AppResult<Snapshot> {
    state.lock()?.rescan()
}

#[tauri::command]
pub fn save_settings(app: AppHandle, state: State<'_, AppState>, settings: Settings) -> AppResult<Snapshot> {
    let snap = state.lock()?.save_settings(settings)?;
    sync_asset_scope(&app, &snap.settings);
    Ok(snap)
}

#[tauri::command]
pub fn first_run_defaults() -> FirstRunDefaults {
    settings::first_run_defaults()
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
pub fn open_folder(app: AppHandle, state: State<'_, AppState>, target: OpenTarget) -> AppResult<()> {
    let path = {
        let core = state.lock()?;
        let s = core.settings();
        match target {
            OpenTarget::Mods => s.mods_path().map(str::to_string),
            OpenTarget::Library => Some(s.library_path.clone()).filter(|p| !p.trim().is_empty()),
            OpenTarget::Skin { .. } | OpenTarget::Entity { .. } => None,
        }
    };
    let path = path.ok_or_else(|| AppError::new("no_path", "That folder isn't set yet."))?;
    if !std::path::Path::new(&path).exists() {
        return Err(AppError::new("missing", format!("{path} doesn't exist.")));
    }
    app.opener().open_path(path, None::<&str>).map_err(|e| AppError::new("open_failed", e.to_string()))
}
