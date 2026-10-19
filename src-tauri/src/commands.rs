//! Thin `#[tauri::command]` wrappers over `core::app::AppCore` (SPEC §13). No disk logic lives here.

use crate::core::app::{AppCore, ApplyOutcome, EntityPatch, IMAGE_DIRS, Picks, SkinPatch};
use crate::core::apply::Fault;
use crate::core::error::{AppError, AppResult};
use crate::core::model::{Settings, Snapshot};
use crate::core::settings::{self, FirstRunDefaults};
use serde::Deserialize;
use serde::Serialize;
use std::sync::{Arc, Mutex, MutexGuard};
use tauri::{AppHandle, Emitter, Manager, State};
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

/// "Update hash index" (Settings › Library): download outside the lock, then reload and re-scan.
#[tauri::command]
pub async fn update_hash_index(state: State<'_, AppState>) -> AppResult<Snapshot> {
    let dest = state.lock()?.config_dir().join(crate::core::app::HASH_INDEX_FILE);
    tauri::async_runtime::spawn_blocking(move || crate::net::update_hash_index(&dest))
        .await
        .map_err(|e| AppError::new("task", e.to_string()))??;
    state.run(|c| c.reload_index()).await
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApplyProgress {
    done: usize,
    total: usize,
    label: String,
}

/// Debug builds only: `SKIN_SWITCHER_FAULT=fail:N` or `crash:N` makes Apply fail (and roll back) or kill the app
/// before operation N, for the e2e tests of rollback and journal recovery.
fn fault_from_env() -> Fault {
    #[cfg(debug_assertions)]
    if let Ok(v) = std::env::var("SKIN_SWITCHER_FAULT") {
        let (kind, n) = v.split_once(':').unwrap_or((v.as_str(), "0"));
        let n = n.parse().unwrap_or(0);
        return match kind {
            "fail" => Fault::FailAt(n),
            "crash" => Fault::CrashAt(n),
            _ => Fault::None,
        };
    }
    Fault::None
}

/// Apply pending picks (SPEC §3). Emits `apply-progress` events while it runs.
#[tauri::command]
pub async fn apply(app: AppHandle, state: State<'_, AppState>, picks: Picks) -> AppResult<ApplyOutcome> {
    let fault = fault_from_env();
    let emitter = app.clone();
    let result = state
        .run(move |c| {
            c.apply(&picks, fault, &mut |done, total, label| {
                let _ = emitter.emit("apply-progress", ApplyProgress { done, total, label: label.to_string() });
            })
        })
        .await;
    if let Err(e) = &result
        && e.code == "crashed"
    {
        // simulated kill for the journal-recovery test: leave the journal behind, exit immediately
        std::process::exit(101);
    }
    result
}

#[tauri::command]
pub async fn update_skin(state: State<'_, AppState>, skin_id: String, patch: SkinPatch) -> AppResult<Snapshot> {
    state.run(move |c| c.update_skin(&skin_id, patch)).await
}

#[tauri::command]
pub async fn update_entity(state: State<'_, AppState>, entity_id: String, patch: EntityPatch) -> AppResult<Snapshot> {
    state.run(move |c| c.update_entity(&entity_id, patch)).await
}

/// Remove a skin: folders and previews go to the Recycle Bin (SPEC §1).
#[tauri::command]
pub async fn remove_skin(state: State<'_, AppState>, skin_id: String) -> AppResult<Snapshot> {
    state.run(move |c| c.remove_skin(&skin_id, &|p| trash::delete(p).map_err(std::io::Error::other))).await
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
    Skin {
        skin_id: String,
    },
    #[serde(rename_all = "camelCase")]
    Entity {
        entity_id: String,
    },
}

#[tauri::command]
pub fn open_folder(app: AppHandle, state: State<'_, AppState>, target: OpenTarget) -> AppResult<()> {
    let path = {
        let core = state.lock()?;
        let s = core.settings();
        match target {
            OpenTarget::Mods => s.mods_path().map(str::to_string),
            OpenTarget::Library => Some(s.library_path.clone()).filter(|p| !p.trim().is_empty()),
            OpenTarget::Skin { skin_id } => core.skin_path(&skin_id).map(|p| p.to_string_lossy().into_owned()),
            OpenTarget::Entity { entity_id } => core.entity_path(&entity_id).map(|p| p.to_string_lossy().into_owned()),
        }
    };
    let path = path.ok_or_else(|| AppError::new("no_path", "That folder isn't set yet."))?;
    if !std::path::Path::new(&path).exists() {
        return Err(AppError::new("missing", format!("{path} doesn't exist.")));
    }
    app.opener().open_path(path, None::<&str>).map_err(|e| AppError::new("open_failed", e.to_string()))
}
