//! Thin `#[tauri::command]` wrappers over `core` (SPEC §13). No disk logic lives here.

use crate::core::error::{AppError, AppResult};
use crate::core::model::{DiskState, HashIndexInfo, Library, Settings, Snapshot};
use serde::Deserialize;
use std::sync::Mutex;
use tauri::State;

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
pub fn save_settings(state: State<'_, AppState>, settings: Settings) -> AppResult<Snapshot> {
    let mut s = state.settings.lock().map_err(|_| AppError::new("state", "state poisoned"))?;
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
