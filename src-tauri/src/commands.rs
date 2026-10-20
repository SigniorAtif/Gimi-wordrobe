//! Thin `#[tauri::command]` wrappers over `core::app::AppCore` (SPEC §13). No disk logic lives here.

use crate::core::add::{AddRequest, AddResult, ArchiveSummary};
use crate::core::app::{AppCore, ApplyOutcome, EntityPatch, IMAGE_DIRS, Picks, SkinPatch};
use crate::core::apply::Fault;
use crate::core::error::{AppError, AppResult};
use crate::core::importer::{ImportPlan, ImportRequest, ImportResult};
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

/// Disk work is serialised on purpose (an add and an Apply must never interleave). A panic in one command poisons the
/// lock; the core's state is still consistent (each operation undoes itself on error), so carry on with it.
fn lock(core: &Mutex<AppCore>) -> AppResult<MutexGuard<'_, AppCore>> {
    Ok(core.lock().unwrap_or_else(|poisoned| poisoned.into_inner()))
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

/// Debug builds only: `SKIN_SWITCHER_E2E_PICK_<WHAT>` answers a file dialog without showing it, so the e2e tests can
/// drive "+ Add" (WebDriver can't operate native dialogs or OS file drags).
fn e2e_pick(what: &str) -> Option<Option<String>> {
    #[cfg(debug_assertions)]
    if let Ok(v) = std::env::var(format!("SKIN_SWITCHER_E2E_PICK_{what}")) {
        return Some(Some(v).filter(|v| !v.is_empty()));
    }
    let _ = what;
    None
}

/// Native "open file" dialog, run off the main thread. None = cancelled.
async fn pick_file(
    app: AppHandle,
    title: &'static str,
    filter: &'static str,
    exts: &'static [&'static str],
) -> AppResult<Option<String>> {
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title(title)
            .add_filter(filter, exts)
            .blocking_pick_file()
            .and_then(|f| f.into_path().ok())
            .map(|p| p.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| AppError::new("dialog_failed", e.to_string()))
}

/// "+ Add" / "Choose another…": pick a mod archive.
#[tauri::command]
pub async fn pick_archive(app: AppHandle) -> AppResult<Option<String>> {
    if let Some(p) = e2e_pick("ARCHIVE") {
        return Ok(p);
    }
    pick_file(app, "Choose a mod archive", "Mod archives", &["zip", "rar", "7z"]).await
}

/// A portrait or preview image.
#[tauri::command]
pub async fn pick_image(app: AppHandle) -> AppResult<Option<String>> {
    if let Some(p) = e2e_pick("IMAGE") {
        return Ok(p);
    }
    pick_file(app, "Choose an image", "Images", &["png", "jpg", "jpeg", "webp"]).await
}

/// A4 / C4 summary of an archive (SPEC §9: list first, refuse unsafe archives).
#[tauri::command]
pub async fn analyze_archive(state: State<'_, AppState>, path: String) -> AppResult<ArchiveSummary> {
    state.run(move |c| c.analyze_archive(std::path::Path::new(&path))).await
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AddProgress {
    done: u64,
    total: u64,
    label: String,
}

/// Extract & add (SPEC §6 A4/C4). Emits `add-progress` while extracting.
#[tauri::command]
pub async fn add_skin(app: AppHandle, state: State<'_, AppState>, request: AddRequest) -> AppResult<AddResult> {
    let emitter = app.clone();
    state
        .run(move |c| {
            c.add_skin(request, &mut |done, total, label| {
                let _ = emitter.emit("add-progress", AddProgress { done, total, label: label.to_string() });
            })
        })
        .await
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportProgress {
    done: usize,
    total: usize,
    label: String,
}

/// First-run / Re-scan review list (SPEC §5). Reads only; emits `import-progress` while archives are read.
#[tauri::command]
pub async fn plan_import(app: AppHandle, state: State<'_, AppState>) -> AppResult<ImportPlan> {
    state
        .run(move |c| {
            c.plan_import(&mut |done, total, label| {
                let _ = app.emit("import-progress", ImportProgress { done, total, label: label.to_string() });
            })
        })
        .await
}

/// Carry out the reviewed import. Emits `import-progress`.
#[tauri::command]
pub async fn apply_import(app: AppHandle, state: State<'_, AppState>, request: ImportRequest) -> AppResult<ImportResult> {
    state
        .run(move |c| {
            c.apply_import(request, &mut |done, total, label| {
                let _ = app.emit("import-progress", ImportProgress { done, total, label: label.to_string() });
            })
        })
        .await
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
