//! Thin `#[tauri::command]` wrappers over `core::app::AppCore` (SPEC §13). No disk logic lives here.

use crate::core::app::{AppCore, IMAGE_DIRS};
use crate::core::error::{AppError, AppResult};
use crate::core::model::{Settings, Snapshot};
use crate::core::settings::{self, FirstRunDefaults};
use serde::Deserialize;
use std::sync::{Arc, Mutex, MutexGuard};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

/// Let the webview load images only from the Library's previews and portraits folders (SPEC §10).
pub fn sync_asset_scope(app: &AppHandle, settings: &Settings) {
    let lib = settings.library_path.trim();
    if !lib.is_empty() {
        for sub in IMAGE_DIRS {
            let _ = app.asset_protocol_scope().allow_directory(std::path::Path::new(lib).join(sub), true);
        }
    }
}

pub struct AppState(pub Arc<Mutex<AppCore>>);

fn lock(core: &Mutex<AppCore>) -> AppResult<MutexGuard<'_, AppCore>> {
    core.lock().map_err(|_| AppError::new("state", "Internal state is unavailable; restart the app."))
}

impl AppState {
    fn lock(&self) -> AppResult<MutexGuard<'_, AppCore>> {
        lock(&self.0)
    }

    /// Run disk work on a blocking thread so a slow drive never freezes the window.
    async fn run<T, F>(&self, f: F) -> AppResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut AppCore) -> AppResult<T> + Send + 'static,
    {
        let core = self.0.clone();
        tauri::async_runtime::spawn_blocking(move || f(&mut *lock(&core)?))
            .await
            .map_err(|e| AppError::new("task", e.to_string()))?
    }
}

#[tauri::command]
pub async fn load(state: State<'_, AppState>) -> AppResult<Snapshot> {
    state.run(|c| c.load()).await
}

#[tauri::command]
pub async fn rescan(state: State<'_, AppState>) -> AppResult<Snapshot> {
    state.run(|c| c.rescan()).await
}

#[tauri::command]
pub async fn save_settings(app: AppHandle, state: State<'_, AppState>, settings: Settings) -> AppResult<Snapshot> {
    let snap = state.run(move |c| c.save_settings(settings)).await?;
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
