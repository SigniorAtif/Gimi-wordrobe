//! Thin `#[tauri::command]` wrappers over `core::app::AppCore` (SPEC §13). No disk logic lives here.

use crate::core::add::{AddRequest, AddResult, ArchiveSummary};
use crate::core::app::{AppCore, ApplyOutcome, EntityPatch, IMAGE_DIRS, Picks, SkinPatch};
use crate::core::apply::Fault;
use crate::core::error::{AppError, AppResult};
use crate::core::importer::{ImportPlan, ImportRequest, ImportResult};
use crate::core::model::{Settings, Snapshot};
use crate::core::previews::{self, GameBananaInfo, PreviewFetch};
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

/// Check the NSFW PIN before revealing (SPEC §11). Wrong guesses are throttled in the core.
#[tauri::command]
pub async fn verify_pin(state: State<'_, AppState>, pin: String) -> AppResult<crate::core::pin::PinCheck> {
    state.run(move |c| Ok(c.verify_pin(&pin))).await
}

/// Set, change or remove the PIN (Settings › NSFW). Changing or removing needs the current PIN.
#[tauri::command]
pub async fn set_pin(state: State<'_, AppState>, current: Option<String>, next: Option<String>) -> AppResult<Snapshot> {
    state.run(move |c| c.set_pin(current.as_deref(), next.as_deref())).await
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
pub async fn apply_import(
    app: AppHandle,
    state: State<'_, AppState>,
    request: ImportRequest,
) -> AppResult<ImportResult> {
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
    state.run(move |c| c.remove_skin(&skin_id, &bin)).await
}

fn bin(p: &std::path::Path) -> std::io::Result<()> {
    trash::delete(p).map_err(std::io::Error::other)
}

/// Network work off the async runtime, without holding the core lock.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> AppResult<T> + Send + 'static) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| AppError::new("task", e.to_string()))?
}

/// A pasted GameBanana link (A4 / C4): name, author, NSFW hint and image count. Nothing is written.
#[tauri::command]
pub async fn gamebanana_info(url: String) -> AppResult<GameBananaInfo> {
    blocking(move || crate::net::gamebanana_info(&url)).await
}

/// Fetch a skin's previews from its GameBanana page: download outside the lock, then store (SPEC §10). A failure
/// changes nothing, so the UI can fall back to the empty state with "Retry". The link and the free preview slots are
/// read together; a full skin is refused before anything is downloaded, and only as many images as fit are fetched.
#[tauri::command]
pub async fn fetch_gamebanana_previews(state: State<'_, AppState>, skin_id: String) -> AppResult<PreviewFetch> {
    let id = skin_id.clone();
    let (url, room) = state.run(move |c| Ok((c.gamebanana_url(&id)?, c.preview_room(&id)?))).await?;
    let fetched = blocking(move || crate::net::fetch_gamebanana(&url, room)).await?;
    state.run(move |c| c.add_gamebanana_previews(&skin_id, &fetched.info, &fetched.images, fetched.failed)).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderPreviews {
    snapshot: Snapshot,
    added: usize,
}

/// Look for preview images inside the skin's own folders (installed mods have no archive).
#[tauri::command]
pub async fn find_folder_previews(state: State<'_, AppState>, skin_id: String) -> AppResult<FolderPreviews> {
    let (snapshot, added) = state.run(move |c| c.find_folder_previews(&skin_id)).await?;
    Ok(FolderPreviews { snapshot, added })
}

/// An image file dropped on a skin card or the gallery, or picked. Any path is taken (the webview is our own), but
/// the core refuses symlinks and files over 25 MB.
#[tauri::command]
pub async fn add_preview(state: State<'_, AppState>, skin_id: String, path: String) -> AppResult<Snapshot> {
    state.run(move |c| c.add_preview_file(&skin_id, std::path::Path::new(&path))).await
}

/// Ctrl+V on a skin (SPEC §13): the image bytes are the raw request body, the skin id is the `x-skin-id` header.
#[tauri::command]
pub async fn paste_preview(state: State<'_, AppState>, request: tauri::ipc::Request<'_>) -> AppResult<Snapshot> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(AppError::new("bad_paste", "The pasted image didn't arrive."));
    };
    if bytes.len() as u64 > previews::MAX_IMAGE_BYTES {
        return Err(AppError::new("not_an_image", "That image is over 25 MB."));
    }
    let skin_id = request
        .headers()
        .get("x-skin-id")
        .and_then(|v| v.to_str().ok())
        .and_then(previews::percent_decode)
        .ok_or_else(|| AppError::new("bad_paste", "The pasted image didn't say which skin it's for."))?;
    let bytes = bytes.clone();
    state.run(move |c| c.add_preview_bytes(&skin_id, &bytes)).await
}

/// Remove one preview; its file goes to the Recycle Bin.
#[tauri::command]
pub async fn remove_preview(state: State<'_, AppState>, skin_id: String, file: String) -> AppResult<Snapshot> {
    state.run(move |c| c.remove_preview(&skin_id, &file, &bin)).await
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
