//! `AppCore` owns the app's state and implements every operation the commands expose.
//! Tauri-free, so integration tests can drive it directly against fixtures.

use super::apply::{self, ExecError, Fault, Roots};
use super::error::{AppError, AppResult};
use super::hashindex::HashIndex;
use super::import;
use super::library;
use super::model::{Library, RecoveryInfo, Settings, Skin, Snapshot};
use super::modfix::{self, FixData, FixReport};
use super::persist;
use super::scanner::{self, ScanContext, ScanResult};
use super::settings;
use super::state;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

/// entityId -> chosen skin id, or None for "Original / no mod".
pub type Picks = BTreeMap<String, Option<String>>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyOutcome {
    pub snapshot: Snapshot,
    /// Skins enabled or disabled by this Apply.
    pub changed: usize,
    /// The disk changed since the UI last looked: nothing was applied, the UI shows the fresh state.
    pub changed_outside: bool,
    pub warnings: Vec<String>,
}

/// Edits to a skin's metadata (A3 / Edit details). Only library.json changes, never the mod's files (SPEC §6 A3).
/// Empty strings clear optional fields.
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SkinPatch {
    pub name: Option<String>,
    pub author: Option<String>,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub nsfw: Option<bool>,
    pub game_banana_url: Option<String>,
    /// Move the skin to another entity (its folders stay where they are).
    pub entity_id: Option<String>,
    pub hotkey_labels: Option<Vec<HotkeyLabel>>,
    /// Preview files in the new order; the first is the cover. Files left out keep their order after these.
    pub preview_order: Option<Vec<String>>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyLabel {
    pub section: String,
    pub ini_file: String,
    pub keys: String,
    pub label: String,
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EntityPatch {
    pub name: Option<String>,
    pub category: Option<super::model::Category>,
    /// "" clears the parent.
    pub parent_id: Option<String>,
    pub aliases: Option<Vec<String>>,
}

fn opt(v: String) -> Option<String> {
    let t = v.trim();
    (!t.is_empty()).then(|| t.to_string())
}

/// A fingerprint of what's on disk, to notice changes made outside the app (SPEC §3).
fn signature(s: &Snapshot) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    for (id, st) in &s.disk.skins {
        id.hash(&mut h);
        format!("{:?}", st.location).hash(&mut h);
    }
    s.disk.unknown_roots.hash(&mut h);
    h.finish()
}

/// Library sub-folders the webview may load images from (asset protocol scope).
pub const IMAGE_DIRS: [&str; 2] = ["previews", "portraits"];
pub const STASH_DIR: &str = "stash";
pub const HASH_INDEX_FILE: &str = "hash_index.json";

pub struct AppCore {
    config_dir: PathBuf,
    /// Bundled resources (hash_index.json); None in tests.
    resource_dir: Option<PathBuf>,
    pub(super) settings: Settings,
    pub(super) library: Library,
    pub(super) index: HashIndex,
    /// Tables for updating old mods on add (modfix.rs); None when modfix_data.json wasn't built.
    pub(super) fix_data: Option<std::sync::Arc<FixData>>,
    pub(super) last_scan: Option<ScanResult>,
    /// library.json exists but can't be read: nothing is adopted or saved until it's fixed.
    library_error: Option<String>,
    /// settings.json on disk fails validation (hand-edited): treated as not configured.
    settings_error: Option<String>,
    /// Disk fingerprint of the last snapshot handed to the UI.
    last_sig: Option<u64>,
    recovered: Option<RecoveryInfo>,
    /// The review list last handed to the UI, until it is applied (SPEC §5).
    pub(super) pending_import: Option<super::importer::PlanState>,
    /// Wrong NSFW PIN guesses (SPEC §6 PIN lock).
    pub(super) pin_throttle: super::pin::Throttle,
}

impl AppCore {
    pub fn open(config_dir: &Path) -> Self {
        Self::open_with(config_dir, None)
    }

    pub fn open_with(config_dir: &Path, resource_dir: Option<PathBuf>) -> Self {
        let settings = settings::load(config_dir);
        let mut core = AppCore {
            config_dir: config_dir.to_path_buf(),
            resource_dir,
            settings,
            library: Library::default(),
            index: HashIndex::empty(),
            fix_data: None,
            last_scan: None,
            library_error: None,
            settings_error: None,
            last_sig: None,
            recovered: None,
            pending_import: None,
            pin_throttle: Default::default(),
        };
        if core.settings.is_configured()
            && let Err(e) = settings::validate(&core.settings)
        {
            core.settings_error = Some(format!("Your saved settings need fixing: {}", e.message));
        }
        core.index = core.load_index();
        core.fix_data = core.load_fix_data();
        core.reload_library();
        core
    }

    pub fn config_dir(&self) -> &Path {
        &self.config_dir
    }

    /// Re-read the hash index after "Update hash index" wrote a new one, then re-scan.
    pub fn reload_index(&mut self) -> AppResult<Snapshot> {
        self.index = self.load_index();
        self.rescan()
    }

    /// Use a specific hash index (tests).
    pub fn set_index(&mut self, index: HashIndex) {
        self.index = index;
    }

    /// Use specific mod fix tables (tests).
    pub fn set_fix_data(&mut self, data: Option<FixData>) {
        self.fix_data = data.map(std::sync::Arc::new);
    }

    /// The mod fix tables: one in the config dir wins over the bundled one.
    fn load_fix_data(&self) -> Option<std::sync::Arc<FixData>> {
        let mut candidates: Vec<PathBuf> = vec![self.config_dir.join(modfix::DATA_FILE)];
        if let Some(r) = &self.resource_dir {
            candidates.push(r.join("resources").join(modfix::DATA_FILE));
            candidates.push(r.join(modfix::DATA_FILE));
        }
        // not under cargo test: a locally built table would change what the fixture tests see
        #[cfg(all(debug_assertions, not(test)))]
        candidates.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("resources").join(modfix::DATA_FILE));
        candidates.iter().find_map(|p| FixData::load(p).ok()).map(std::sync::Arc::new)
    }

    /// Bring a freshly extracted tree up to date for the current game, unless turned off in Settings.
    pub(super) fn fix_mods(&self, root: &Path) -> FixReport {
        match &self.fix_data {
            Some(d) if !self.settings.skip_mod_fixes => modfix::fix_tree(root, d),
            _ => FixReport::default(),
        }
    }

    /// The newer of the bundled index and one fetched by "Update hash index" into the config dir.
    fn load_index(&self) -> HashIndex {
        let mut candidates: Vec<PathBuf> = vec![self.config_dir.join(HASH_INDEX_FILE)];
        if let Some(r) = &self.resource_dir {
            candidates.push(r.join("resources").join(HASH_INDEX_FILE));
            candidates.push(r.join(HASH_INDEX_FILE));
        }
        #[cfg(debug_assertions)]
        candidates.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("resources").join(HASH_INDEX_FILE));
        candidates
            .iter()
            .filter_map(|p| HashIndex::load(p).ok())
            .max_by(|a, b| a.date.cmp(&b.date).then(a.info().entries.cmp(&b.info().entries)))
            .unwrap_or_default()
    }

    pub fn settings(&self) -> &Settings {
        &self.settings
    }

    pub fn library(&self) -> &Library {
        &self.library
    }

    pub fn index(&self) -> &HashIndex {
        &self.index
    }

    pub fn library_dir(&self) -> Option<PathBuf> {
        let p = self.settings.library_path.trim();
        (!p.is_empty() && self.settings_error.is_none()).then(|| PathBuf::from(p))
    }

    pub fn mods_dir(&self) -> Option<PathBuf> {
        self.settings.mods_path().filter(|_| self.settings_error.is_none()).map(PathBuf::from)
    }

    pub fn stash_dir(&self) -> Option<PathBuf> {
        self.library_dir().map(|l| l.join(STASH_DIR))
    }

    fn reload_library(&mut self) {
        self.library_error = None;
        self.library = match self.library_dir().map(|d| library::load(&d)) {
            Some(Ok(l)) => l,
            Some(Err(e)) => {
                self.library_error = Some(format!(
                    "library.json in the Library folder can't be read ({}). Nothing will be changed until it's fixed or removed.",
                    e.message
                ));
                Library::default()
            }
            None => Library::default(),
        };
    }

    pub fn save_library(&self) -> AppResult<()> {
        if self.library_error.is_some() {
            return Err(AppError::new("library_unreadable", self.library_error.clone().unwrap_or_default()));
        }
        if let Some(d) = self.library_dir() {
            library::save(&d, &self.library)?;
        }
        Ok(())
    }

    pub fn snapshot(&self) -> Snapshot {
        let mods = self.mods_dir();
        let stash = self.stash_dir();
        let archives = self.last_scan.as_ref().map(|s| s.archives.clone()).unwrap_or_default();
        let (libraries, unknown) = match &self.last_scan {
            Some(scan) => (
                scan.libraries.clone(),
                scan.candidates
                    .iter()
                    .filter(|c| !c.folders.iter().any(|f| self.library.owner_of(f).is_some()))
                    .map(|c| c.folders[0].clone())
                    .collect(),
            ),
            None => (vec![], vec![]),
        };
        let mut settings = self.settings.clone();
        // the PIN hash stays in the backend; the UI only learns whether one is set
        settings.nsfw.pin_hash = None;
        Snapshot {
            pin_set: self.pin_set(),
            settings,
            library: self.library.clone(),
            disk: super::model::DiskState {
                archives,
                ..state::disk_state(&self.library, mods.as_deref(), stash.as_deref(), libraries, unknown)
            },
            changed_outside: false,
            recovered: self.recovered.clone(),
            hash_index: self.index.info(),
            mod_fixes: self.fix_data.is_some(),
            configured: self.settings.is_configured() && self.settings_error.is_none(),
            notice: self.settings_error.clone().or_else(|| self.library_error.clone()),
            same_drive: settings::same_drive(&self.settings),
        }
    }

    /// Hand a snapshot to the UI and remember what the disk looked like.
    pub(super) fn publish(&mut self) -> Snapshot {
        let s = self.snapshot();
        self.last_sig = Some(signature(&s));
        s
    }

    pub(super) fn journal_path(&self) -> Option<PathBuf> {
        self.library_dir().map(|d| d.join(apply::JOURNAL_FILE))
    }

    /// Startup: roll back an interrupted Apply (SPEC §3 journal), then scan.
    pub fn load(&mut self) -> AppResult<Snapshot> {
        self.recovered = None;
        // extracted copies a crashed add left behind belong to nobody
        if let Some(lib) = self.library_dir() {
            super::add::sweep_staging(&lib);
        }
        if let Some(j) = self.journal_path() {
            self.recovered = match apply::recover(&j) {
                Ok(Some(n)) => Some(RecoveryInfo {
                    rolled_back: n,
                    message: "The last Apply was interrupted, so the Mods folder was put back the way it was.".into(),
                }),
                Ok(None) => None,
                Err(e) => Some(RecoveryInfo {
                    rolled_back: 0,
                    message: format!("The last Apply was interrupted and couldn't be fully undone: {}", e.message),
                }),
            };
        }
        let snap = self.rescan();
        self.recovered = None;
        snap
    }

    /// Re-read the Mods folder. Unknown mod roots are only reported (`disk.unknownRoots`); they join the library through
    /// the import review (SPEC §5), never silently.
    pub fn rescan(&mut self) -> AppResult<Snapshot> {
        let Some(mods) = self.mods_dir().filter(|m| m.is_dir()) else {
            self.last_scan = None;
            return Ok(self.publish());
        };
        let scan = {
            let ctx = ScanContext::new(&self.index, &self.library);
            scanner::scan(&mods, &ctx)
        };
        if self.library_error.is_some() {
            // never adopt into, or save over, a library.json we couldn't read
            self.last_scan = Some(scan);
            return Ok(self.snapshot());
        }
        let mut changed = self.refresh_active_skins(&scan);
        changed |= self.backup_persist(&mods);
        self.last_scan = Some(scan);
        if changed {
            self.save_library()?;
        }
        Ok(self.publish())
    }

    /// Copy active skins' d3dx_user.ini lines into the library (SPEC §3).
    fn backup_persist(&mut self, mods: &Path) -> bool {
        let Some(user_ini) = persist::user_ini_path(mods) else { return false };
        let stash = self.stash_dir();
        let active: BTreeSet<String> = self
            .library
            .skins
            .iter()
            .filter(|s| state::locate(s, mods, stash.as_deref()).active)
            .map(|s| s.id.clone())
            .collect();
        let mut refs: Vec<&mut Skin> = self.library.skins.iter_mut().filter(|s| active.contains(&s.id)).collect();
        persist::backup(&user_ini, &mut refs)
    }

    /// Undo an unfinished batch before starting a new one, so its journal (the only undo record) is never lost.
    pub(super) fn recover_pending(&mut self) -> AppResult<()> {
        if let Some(j) = self.journal_path().filter(|j| j.exists()) {
            apply::recover(&j).map_err(|e| {
                AppError::new(
                    "journal_recovery",
                    format!("An earlier Apply wasn't finished and couldn't be undone yet: {}", e.message),
                )
            })?;
        }
        Ok(())
    }

    pub(super) fn roots(&self) -> AppResult<(PathBuf, PathBuf)> {
        let mods = self
            .mods_dir()
            .filter(|m| m.is_dir())
            .ok_or_else(|| AppError::new("no_mods", "The Mods folder isn't set or doesn't exist."))?;
        let stash = self.stash_dir().ok_or_else(|| AppError::new("no_library", "Choose a Library folder first."))?;
        Ok((mods, stash))
    }

    /// Apply pending picks as one batch (SPEC §3): re-scan, refuse if the disk changed under the UI, move folders
    /// with a journal, verify, roll back on any failure, then restore the activated skins' toggles.
    pub fn apply(
        &mut self,
        picks: &Picks,
        fault: Fault,
        progress: &mut dyn FnMut(usize, usize, &str),
    ) -> AppResult<ApplyOutcome> {
        let (mods, stash) = self.roots()?;
        self.recover_pending()?;
        let seen = self.last_sig;
        let fresh = self.rescan()?;
        if seen.is_some() && seen != Some(signature(&fresh)) {
            return Ok(ApplyOutcome { snapshot: fresh, changed: 0, changed_outside: true, warnings: vec![] });
        }
        let plan =
            apply::plan(&self.library, picks, Roots { mods: &mods, stash: &stash }, self.settings.disable_method)?;
        if plan.is_empty() {
            return Ok(ApplyOutcome { snapshot: fresh, changed: 0, changed_outside: false, warnings: vec![] });
        }
        let lib = &self.library;
        let verify = || -> AppResult<()> {
            for (entity, target) in picks {
                for s in lib.skins.iter().filter(|s| &s.entity_id == entity) {
                    let want = target.as_deref() == Some(s.id.as_str());
                    if state::locate(s, &mods, Some(&stash)).active != want {
                        let what = if want { "enabled" } else { "disabled" };
                        return Err(AppError::new("verify_failed", format!("{} didn't end up {what}.", s.name)));
                    }
                }
            }
            Ok(())
        };
        let journal = self.journal_path();
        match apply::execute_verified(&plan, &mods, journal.as_deref(), fault, progress, &verify) {
            Ok(_) => apply::tidy_stash(&plan, &stash),
            Err(ExecError::Crashed) => return Err(AppError::new("crashed", "Apply was interrupted.")),
            Err(e) => {
                let _ = self.rescan();
                return Err(e.into());
            }
        }
        let mut warnings = self.unimported_same_entity(picks);
        let activated: Vec<&Skin> = plan.activate.iter().filter_map(|id| self.library.skin(id)).collect();
        if let Some(ui) = persist::user_ini_path(&mods)
            && let Err(e) = persist::restore(&ui, &activated)
        {
            warnings.push(format!("Saved in-mod toggles couldn't be restored: {}", e.message));
        }
        let changed = plan.activate.len() + plan.deactivate.len();
        // the batch is committed; a failing re-scan must not turn it into "Apply failed"
        let snapshot = match self.rescan() {
            Ok(s) => s,
            Err(e) => {
                warnings.push(format!("Applied, but re-reading the Mods folder failed: {}", e.message));
                self.publish()
            }
        };
        Ok(ApplyOutcome { snapshot, changed, changed_outside: false, warnings })
    }

    /// Mod roots of a picked entity that aren't in the library yet stay enabled; say so (SPEC §16 one enabled copy).
    fn unimported_same_entity(&self, picks: &Picks) -> Vec<String> {
        let Some(scan) = &self.last_scan else { return vec![] };
        let mut out = vec![];
        for entity_id in picks.keys() {
            let Some(e) = self.library.entity(entity_id) else { continue };
            let key = super::names::compact(&e.name);
            for c in &scan.candidates {
                if c.folders.iter().any(|f| self.library.owner_of(f).is_some()) {
                    continue;
                }
                if c.guess.as_ref().map(|g| g.key() == key).unwrap_or(false) {
                    out.push(format!(
                        "{} looks like another {} mod that isn't in the library yet, so it stays on. Use Re-scan in Settings to add it.",
                        c.folders.join(" + "),
                        e.name
                    ));
                }
            }
        }
        out
    }

    /// Move a skin's folders, previews and library entry to the Recycle Bin (SPEC §1 never hard delete).
    /// `delete` is the trash function (injected so tests don't touch the real Recycle Bin).
    pub fn remove_skin(&mut self, id: &str, delete: &dyn Fn(&Path) -> std::io::Result<()>) -> AppResult<Snapshot> {
        let skin = self
            .library
            .skin(id)
            .cloned()
            .ok_or_else(|| AppError::new("unknown_skin", "That skin no longer exists."))?;
        let (mods, stash) = self.roots()?;
        // a broken library entry must never point the Recycle Bin at Mods itself
        for f in &skin.folders {
            let clean = f.trim_matches(['/', '\\', '.', ' ']);
            if clean.is_empty() || super::paths::has_parent_ref(f) || f.contains(':') {
                return Err(AppError::new(
                    "invalid_folder",
                    format!("{} has an invalid folder path ({f:?}); fix library.json first.", skin.name),
                ));
            }
        }
        let mut parents = vec![];
        let mut trashed: Vec<String> = vec![];
        for f in &skin.folders {
            let mut found: Vec<PathBuf> = vec![];
            if let Some(p) = state::resolve_ci(&mods, f) {
                found.push(p);
            }
            if let Some((p, _)) = state::find_disabled(&mods, f) {
                found.push(p);
            }
            if let Some(p) = state::resolve_ci(&stash, f) {
                found.push(p);
            }
            for p in found {
                if p.starts_with(&mods)
                    && let Some(parent) = p.parent()
                {
                    parents.push(parent.to_path_buf());
                }
                if let Err(e) = delete(&p) {
                    let done = if trashed.is_empty() {
                        String::new()
                    } else {
                        format!(" {} already went to the Recycle Bin.", trashed.join(", "))
                    };
                    let _ = self.rescan();
                    return Err(AppError::new(
                        "trash_failed",
                        format!("Couldn't move {} to the Recycle Bin: {e}.{done}", p.display()),
                    ));
                }
                trashed.push(p.display().to_string());
            }
        }
        if let Some(previews) = self.library_dir().map(|l| l.join("previews").join(&skin.id)).filter(|p| p.exists()) {
            let _ = delete(&previews);
        }
        // tidy folders under Mods that are now empty
        for start in parents {
            let mut cur = Some(start.as_path());
            while let Some(dir) = cur {
                if dir == mods || !dir.starts_with(&mods) || fs::remove_dir(dir).is_err() {
                    break;
                }
                cur = dir.parent();
            }
        }
        self.library.remove_skin(id);
        self.save_library()?;
        self.rescan()
    }

    pub fn update_skin(&mut self, id: &str, patch: SkinPatch) -> AppResult<Snapshot> {
        let before = self.library.clone();
        let result = self.update_skin_inner(id, patch).and_then(|_| self.save_library());
        if let Err(e) = result {
            // a failed save must not leave the edit in memory for the next save to persist
            self.library = before;
            return Err(e);
        }
        Ok(self.snapshot())
    }

    fn update_skin_inner(&mut self, id: &str, patch: SkinPatch) -> AppResult<()> {
        if let Some(e) = &patch.entity_id
            && self.library.entity(e).is_none()
        {
            return Err(AppError::new("unknown_entity", "That character or item doesn't exist."));
        }
        // moving a skin that is switched on would leave it enabled under the old entity's name
        if let Some(to) = &patch.entity_id
            && let Some(skin) = self.library.skin(id)
            && &skin.entity_id != to
            && let Ok((mods, stash)) = self.roots()
            && skin.folders.iter().any(|f| state::place_of(&mods, Some(&stash), f) == state::FolderPlace::Mods)
        {
            return Err(AppError::new(
                "skin_enabled",
                format!("{} is switched on. Turn it off (pick Original) and Apply before moving it.", skin.name),
            ));
        }
        let skin =
            self.library.skin_mut(id).ok_or_else(|| AppError::new("unknown_skin", "That skin no longer exists."))?;
        if let Some(n) = patch.name {
            skin.name = opt(n).ok_or_else(|| AppError::new("invalid_name", "A skin needs a name."))?;
        }
        if let Some(v) = patch.author {
            skin.author = opt(v);
        }
        if let Some(v) = patch.version {
            skin.version = opt(v);
        }
        if let Some(v) = patch.notes {
            skin.notes = (!v.trim().is_empty()).then_some(v);
        }
        if let Some(v) = patch.nsfw {
            skin.nsfw = v;
        }
        if let Some(v) = patch.game_banana_url {
            skin.game_banana_url = opt(v);
        }
        if let Some(labels) = patch.hotkey_labels {
            for l in labels {
                if let Some(h) = skin.hotkeys.iter_mut().find(|h| {
                    h.section.eq_ignore_ascii_case(&l.section)
                        && h.ini_file.eq_ignore_ascii_case(&l.ini_file)
                        && h.keys == l.keys
                }) {
                    h.label = opt(l.label).unwrap_or_else(|| super::hotkeys::label_for(&h.section));
                }
            }
        }
        if let Some(order) = patch.preview_order {
            skin.previews = super::previews::reorder(&skin.previews, &order);
        }
        let moved = patch.entity_id.filter(|e| e != &skin.entity_id);
        if let Some(to) = moved {
            let from = std::mem::replace(&mut skin.entity_id, to.clone());
            if let Some(e) = self.library.entity_mut(&from) {
                e.skin_ids.retain(|s| s != id);
            }
            if let Some(e) = self.library.entity_mut(&to) {
                e.skin_ids.push(id.to_string());
            }
        }
        Ok(())
    }

    pub fn update_entity(&mut self, id: &str, patch: EntityPatch) -> AppResult<Snapshot> {
        let before = self.library.clone();
        let result = self.update_entity_inner(id, patch).and_then(|_| self.save_library());
        if let Err(e) = result {
            self.library = before;
            return Err(e);
        }
        Ok(self.snapshot())
    }

    fn update_entity_inner(&mut self, id: &str, patch: EntityPatch) -> AppResult<()> {
        if let Some(p) = patch.parent_id.as_deref().filter(|p| !p.is_empty())
            && (p == id || self.library.entity(p).is_none())
        {
            return Err(AppError::new("invalid_parent", "Pick another character as the parent."));
        }
        let e = self
            .library
            .entity_mut(id)
            .ok_or_else(|| AppError::new("unknown_entity", "That character or item doesn't exist."))?;
        if let Some(n) = patch.name {
            e.name = opt(n).ok_or_else(|| AppError::new("invalid_name", "It needs a name."))?;
        }
        if let Some(c) = patch.category {
            e.category = c;
        }
        if let Some(p) = patch.parent_id {
            e.parent_id = opt(p);
        }
        if let Some(a) = patch.aliases {
            e.aliases = a.into_iter().filter_map(opt).collect();
        }
        Ok(())
    }

    /// Where a skin's first folder is right now (Mods, DISABLED_ in Mods, or the stash).
    pub fn skin_path(&self, id: &str) -> Option<PathBuf> {
        let skin = self.library.skin(id)?;
        let (mods, stash) = self.roots().ok()?;
        let f = skin.folders.first()?;
        state::resolve_ci(&mods, f)
            .or_else(|| state::find_disabled(&mods, f).map(|(p, _)| p))
            .or_else(|| state::resolve_ci(&stash, f))
    }

    /// The folder holding an entity's skins in Mods when they share one, else the Mods folder.
    pub fn entity_path(&self, id: &str) -> Option<PathBuf> {
        let mods = self.mods_dir()?;
        let parents: BTreeSet<String> = self
            .library
            .skins
            .iter()
            .filter(|s| s.entity_id == id)
            .flat_map(|s| {
                s.folders.iter().map(|f| f.rsplit_once('/').map(|(p, _)| p.to_lowercase()).unwrap_or_default())
            })
            .collect();
        match parents.iter().next() {
            Some(p) if parents.len() == 1 && !p.is_empty() => state::resolve_ci(&mods, p).or(Some(mods)),
            _ => Some(mods),
        }
    }

    /// Re-parse hotkeys and hashes of skins whose inis are in Mods, keeping user-edited labels.
    fn refresh_active_skins(&mut self, scan: &ScanResult) -> bool {
        let mut changed = false;
        for skin in &mut self.library.skins {
            let Some(c) = scan.candidates.iter().find(|c| {
                c.folders.len() == skin.folders.len()
                    && c.folders.iter().all(|f| skin.folders.iter().any(|g| f.eq_ignore_ascii_case(g)))
            }) else {
                continue;
            };
            let fresh = import::merge_hotkey_labels(&skin.hotkeys, scan.hotkeys_of(c));
            let hashes: Vec<String> = c.hashes.iter().cloned().collect();
            if fresh != skin.hotkeys || hashes != skin.hashes {
                skin.hotkeys = fresh;
                skin.hashes = hashes;
                changed = true;
            }
        }
        changed
    }

    /// Settings save instantly (SPEC §6). Creates the Library folder (and its image folders) when one is set.
    pub fn save_settings(&mut self, mut next: Settings) -> AppResult<Snapshot> {
        // the UI never has the PIN hash; only set_pin changes it
        next.nsfw.pin_hash = self.settings.nsfw.pin_hash.clone();
        settings::validate(&next)?;
        // switching the disable method migrates every inactive skin in one batch with rollback (SPEC §3)
        let same_paths =
            next.mods_path() == self.settings.mods_path() && next.library_path == self.settings.library_path;
        if same_paths
            && next.disable_method != self.settings.disable_method
            && self.settings.is_configured()
            && let Ok((mods, stash)) = self.roots()
        {
            self.recover_pending()?;
            let plan = apply::plan_migration(&self.library, Roots { mods: &mods, stash: &stash }, next.disable_method)?;
            if !plan.is_empty() {
                let journal = self.journal_path();
                apply::execute(&plan, &mods, journal.as_deref(), Fault::None, &mut |_, _, _| {})
                    .map_err(AppError::from)?;
            }
        }
        let lib = next.library_path.trim();
        if !lib.is_empty() {
            for sub in IMAGE_DIRS {
                fs::create_dir_all(Path::new(lib).join(sub))?;
            }
        }
        settings::save(&self.config_dir, &next)?;
        let library_moved = next.library_path != self.settings.library_path || self.settings_error.is_some();
        self.settings = next;
        self.settings_error = None;
        if library_moved || self.library_error.is_some() {
            self.reload_library();
        }
        self.rescan()
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::core::hashindex::tests::test_index;
    use crate::core::model::SkinLocation;

    /// Copy fixtures/Mods into a temp dir so tests can change it freely.
    pub fn fixture_world() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let t = tempfile::tempdir().unwrap();
        let mods = t.path().join("Mods");
        copy_dir(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/Mods"), &mods);
        fs::copy(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/d3dx_user.ini"),
            t.path().join("d3dx_user.ini"),
        )
        .unwrap();
        let lib = t.path().join("SkinLibrary");
        (t, mods, lib)
    }

    pub fn copy_dir(from: &Path, to: &Path) {
        fs::create_dir_all(to).unwrap();
        for e in fs::read_dir(from).unwrap() {
            let e = e.unwrap();
            let dst = to.join(e.file_name());
            if e.file_type().unwrap().is_dir() {
                copy_dir(&e.path(), &dst);
            } else {
                fs::copy(e.path(), dst).unwrap();
            }
        }
    }

    pub fn configured_core(cfg: &Path, mods: &Path, lib: &Path) -> AppCore {
        let mut core = AppCore::open(cfg);
        core.set_index(test_index());
        let mut s = core.settings().clone();
        s.mods_path.migoto = Some(mods.to_string_lossy().into());
        s.library_path = lib.to_string_lossy().into();
        core.save_settings(s).unwrap();
        // what accepting the import review unchanged does for installed mods (most tests start from that library)
        let scan = core.last_scan.clone().unwrap();
        if import::adopt_unowned(&mut core.library, &scan) > 0 {
            core.save_library().unwrap();
            core.rescan().unwrap();
        }
        core
    }

    #[test]
    fn settings_persist_across_restarts() {
        let cfg = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        let mods = work.path().join("Mods");
        fs::create_dir_all(&mods).unwrap();
        let lib = work.path().join("SkinLibrary");

        let mut core = AppCore::open(cfg.path());
        assert!(!core.snapshot().configured);
        let mut s = core.settings().clone();
        s.mods_path.migoto = Some(mods.to_string_lossy().into());
        s.library_path = lib.to_string_lossy().into();
        let snap = core.save_settings(s.clone()).unwrap();
        assert!(snap.configured);
        assert!(snap.disk.mods_exists);
        assert!(lib.join("previews").is_dir(), "library folders are created");

        let reopened = AppCore::open(cfg.path());
        assert_eq!(reopened.settings(), &s);
    }

    #[test]
    fn invalid_settings_are_not_saved() {
        let cfg = tempfile::tempdir().unwrap();
        let mut core = AppCore::open(cfg.path());
        let mut s = core.settings().clone();
        s.mods_path.migoto = Some("/x/Mods".into());
        s.library_path = "/x/Mods/lib".into();
        assert!(core.save_settings(s).is_err());
        assert!(!settings::path(cfg.path()).exists());
    }

    #[test]
    fn first_scan_adopts_installed_mods_and_derives_active_state() {
        let cfg = tempfile::tempdir().unwrap();
        let (_t, mods, lib) = fixture_world();
        let core = configured_core(cfg.path(), &mods, &lib);
        let snap = core.snapshot();
        let names: Vec<String> = snap
            .library
            .skins
            .iter()
            .map(|s| format!("{} › {}", snap.library.entity(&s.entity_id).unwrap().name, s.name))
            .collect();
        for want in [
            "Sandrone › Marionette",
            "Paimon › CC116",
            "A Teaspoon of Transcendence › Sandrone Marionette",
            "Furina › Remembrance",
            "Furina › Casual",
            "Kazuha › Multi",
            "Odette › Black Swan",
            "Varesa › Varesa mod",
        ] {
            assert!(names.contains(&want.to_string()), "{want} in {names:?}");
        }
        let teaspoon = snap.library.find_entity_by_name("A Teaspoon of Transcendence").unwrap();
        assert_eq!(teaspoon.category, crate::core::model::Category::Weapon);
        // two Furina skins are enabled at once: the UI asks which to keep (SPEC §5 step 5)
        assert_eq!(snap.disk.active["furina"].len(), 2);
        assert!(snap.disk.skins.values().all(|s| s.location == SkinLocation::Mods));
        assert!(lib.join("library.json").exists());
        assert_eq!(snap.disk.libraries.len(), 4);
        assert!(snap.disk.unknown_roots.is_empty());

        // a restart reads library.json instead of adopting again
        let mut again = AppCore::open(cfg.path());
        again.set_index(test_index());
        let snap2 = again.rescan().unwrap();
        assert_eq!(snap2.library.skins.len(), snap.library.skins.len());
    }

    #[test]
    fn an_unreadable_library_json_is_never_overwritten() {
        let cfg = tempfile::tempdir().unwrap();
        let (_t, mods, lib) = fixture_world();
        drop(configured_core(cfg.path(), &mods, &lib));
        let file = lib.join("library.json");
        fs::write(&file, b"\xff\xfe{ not json").unwrap();
        let _ = fs::remove_file(lib.join("library.json.bak"));
        let mut core = AppCore::open(cfg.path());
        core.set_index(test_index());
        let snap = core.rescan().unwrap();
        assert!(snap.notice.unwrap().contains("library.json"));
        assert!(snap.library.skins.is_empty());
        assert_eq!(fs::read(&file).unwrap(), b"\xff\xfe{ not json", "left untouched");
    }

    #[test]
    fn invalid_settings_on_disk_count_as_not_configured() {
        let cfg = tempfile::tempdir().unwrap();
        fs::write(settings::path(cfg.path()), r#"{"modsPath":{"3dmigoto":"/x/Mods"},"libraryPath":"/x/Mods/Lib"}"#)
            .unwrap();
        let core = AppCore::open(cfg.path());
        let snap = core.snapshot();
        assert!(!snap.configured);
        assert!(snap.notice.unwrap().contains("settings"));
        assert!(core.library_dir().is_none(), "no writes land inside Mods");
    }

    #[test]
    fn new_folders_after_the_first_import_are_reported_not_adopted() {
        let cfg = tempfile::tempdir().unwrap();
        let (_t, mods, lib) = fixture_world();
        let mut core = configured_core(cfg.path(), &mods, &lib);
        let before = core.snapshot().library.skins.len();
        copy_dir(&mods.join("Odette"), &mods.join("Ganyu"));
        let snap = core.rescan().unwrap();
        assert_eq!(snap.library.skins.len(), before);
        assert_eq!(snap.disk.unknown_roots, vec!["Ganyu".to_string()]);
        // a new mod root next to an imported skin is reported too, not hidden by its parent
        copy_dir(&mods.join("Furina/Casual"), &mods.join("Furina/Party"));
        let snap = core.rescan().unwrap();
        assert!(snap.disk.unknown_roots.contains(&"Furina/Party".to_string()), "{:?}", snap.disk.unknown_roots);
    }

    fn picks(v: &[(&str, Option<&str>)]) -> Picks {
        v.iter().map(|(e, s)| (e.to_string(), s.map(str::to_string))).collect()
    }

    fn noop(_: usize, _: usize, _: &str) {}

    #[test]
    fn apply_leaves_exactly_one_enabled_skin_per_entity() {
        let cfg = tempfile::tempdir().unwrap();
        let (_t, mods, lib) = fixture_world();
        let mut core = configured_core(cfg.path(), &mods, &lib);
        let out = core.apply(&picks(&[("furina", Some("furina--casual"))]), Fault::None, &mut noop).unwrap();
        assert!(!out.changed_outside);
        assert_eq!(out.changed, 1, "Casual was already on; only Remembrance moves");
        assert_eq!(out.snapshot.disk.active["furina"], vec!["furina--casual".to_string()]);
        let out = core.apply(&picks(&[("furina", None)]), Fault::None, &mut noop).unwrap();
        assert!(!out.snapshot.disk.active.contains_key("furina"));
    }

    #[test]
    fn failed_apply_changes_nothing() {
        let cfg = tempfile::tempdir().unwrap();
        let (_t, mods, lib) = fixture_world();
        let mut core = configured_core(cfg.path(), &mods, &lib);
        let before = crate::core::apply::tests::tree(&mods);
        let e = core.apply(&picks(&[("sandrone", None), ("paimon", None)]), Fault::FailAt(2), &mut noop).unwrap_err();
        assert!(e.message.contains("Nothing was changed"), "{}", e.message);
        assert_eq!(crate::core::apply::tests::tree(&mods), before);
    }

    #[test]
    fn changes_made_outside_the_app_stop_the_apply() {
        let cfg = tempfile::tempdir().unwrap();
        let (_t, mods, lib) = fixture_world();
        let mut core = configured_core(cfg.path(), &mods, &lib);
        fs::rename(mods.join("Furina/Casual"), mods.join("Furina/DISABLED_Casual")).unwrap();
        let out = core.apply(&picks(&[("paimon", None)]), Fault::None, &mut noop).unwrap();
        assert!(out.changed_outside);
        assert_eq!(out.changed, 0);
        assert!(mods.join("paimon_cc116").is_dir(), "nothing moved");
        // the UI now has the fresh state; applying again works
        let out = core.apply(&picks(&[("paimon", None)]), Fault::None, &mut noop).unwrap();
        assert!(!out.changed_outside);
        assert!(!mods.join("paimon_cc116").exists());
    }

    #[test]
    fn restart_after_a_killed_apply_restores_the_disk() {
        let cfg = tempfile::tempdir().unwrap();
        let (_t, mods, lib) = fixture_world();
        let before = crate::core::apply::tests::tree(&mods);
        {
            let mut core = configured_core(cfg.path(), &mods, &lib);
            let e =
                core.apply(&picks(&[("sandrone", None), ("odette", None)]), Fault::CrashAt(3), &mut noop).unwrap_err();
            assert_eq!(e.code, "crashed");
        }
        assert_ne!(crate::core::apply::tests::tree(&mods), before);
        let mut core = AppCore::open(cfg.path());
        core.set_index(test_index());
        let snap = core.load().unwrap();
        let rec = snap.recovered.expect("recovery reported");
        assert!(rec.rolled_back > 0);
        assert_eq!(crate::core::apply::tests::tree(&mods), before);
        assert!(core.load().unwrap().recovered.is_none(), "reported once");
    }

    #[test]
    fn in_mod_toggles_survive_switching_away_and_back() {
        let cfg = tempfile::tempdir().unwrap();
        let (t, mods, lib) = fixture_world();
        let user_ini = t.path().join("d3dx_user.ini");
        let mut core = configured_core(cfg.path(), &mods, &lib);
        // the scan backed up Sandrone's hat = 2
        let s = core.library().skin("sandrone--marionette").unwrap();
        assert_eq!(
            s.persist.as_ref().unwrap()["$\\mods\\sandrone_marionette_by_neyori\\outfit\\sandrone.ini\\hat"],
            2.0
        );
        core.apply(&picks(&[("sandrone", None)]), Fault::None, &mut noop).unwrap();
        // the game exits with Sandrone disabled and rewrites d3dx_user.ini without her lines
        fs::write(&user_ini, "[Constants]\r\n$version = 7\r\n$\\global\\healthbar\\health = -1\r\n").unwrap();
        core.rescan().unwrap();
        core.apply(&picks(&[("sandrone", Some("sandrone--marionette"))]), Fault::None, &mut noop).unwrap();
        let text = fs::read_to_string(&user_ini).unwrap();
        assert!(text.contains("$\\mods\\sandrone_marionette_by_neyori\\outfit\\sandrone.ini\\hat = 2"), "{text}");
        assert!(text.contains("$\\global\\healthbar\\health = -1"));
    }

    #[test]
    fn activating_a_skin_leaves_no_empty_folders_in_the_stash() {
        let cfg = tempfile::tempdir().unwrap();
        let (_t, mods, lib) = fixture_world();
        let mut core = configured_core(cfg.path(), &mods, &lib);
        core.apply(&picks(&[("kazuha", None)]), Fault::None, &mut noop).unwrap();
        assert!(lib.join("stash/Kazuha/Multi").is_dir());
        core.apply(&picks(&[("kazuha", Some("kazuha--multi"))]), Fault::None, &mut noop).unwrap();
        assert!(mods.join("Kazuha/Multi").is_dir());
        assert!(!lib.join("stash/Kazuha").exists(), "the emptied container is gone");
        assert!(lib.join("stash").is_dir(), "the stash itself stays");
    }

    #[test]
    fn switching_the_disable_method_migrates_inactive_skins() {
        let cfg = tempfile::tempdir().unwrap();
        let (_t, mods, lib) = fixture_world();
        let mut core = configured_core(cfg.path(), &mods, &lib);
        core.apply(&picks(&[("furina", Some("furina--remembrance"))]), Fault::None, &mut noop).unwrap();
        assert!(lib.join("stash/Furina/Casual").is_dir());
        let mut s = core.settings().clone();
        s.disable_method = crate::core::model::DisableMethod::Prefix;
        core.save_settings(s.clone()).unwrap();
        assert!(mods.join("Furina/DISABLED_Casual").is_dir());
        assert!(!lib.join("stash/Furina/Casual").exists());
        // and Apply now uses the prefix
        core.apply(&picks(&[("furina", Some("furina--casual"))]), Fault::None, &mut noop).unwrap();
        assert!(mods.join("Furina/DISABLED_Remembrance").is_dir());
        s.disable_method = crate::core::model::DisableMethod::Move;
        core.save_settings(s).unwrap();
        assert!(lib.join("stash/Furina/Remembrance").is_dir());
    }

    #[test]
    fn removing_a_skin_sends_its_folders_to_the_bin() {
        let cfg = tempfile::tempdir().unwrap();
        let (t, mods, lib) = fixture_world();
        let bin = t.path().join("bin");
        fs::create_dir_all(&bin).unwrap();
        let mut core = configured_core(cfg.path(), &mods, &lib);
        let odette = core.library().skins.iter().find(|s| s.entity_id == "odette").unwrap().id.clone();
        let to_bin = |p: &Path| fs::rename(p, bin.join(p.file_name().unwrap()));
        let snap = core.remove_skin(&odette, &to_bin).unwrap();
        assert!(bin.join("Odette").is_dir());
        assert!(!mods.join("Odette").exists());
        assert!(snap.library.skin(&odette).is_none());
    }

    #[test]
    fn removal_refuses_folders_that_would_point_at_mods_itself() {
        let cfg = tempfile::tempdir().unwrap();
        let (_t, mods, lib) = fixture_world();
        let mut core = configured_core(cfg.path(), &mods, &lib);
        core.library.skins[0].folders = vec!["".into()];
        let id = core.library.skins[0].id.clone();
        let deleted = std::cell::RefCell::new(vec![]);
        let e = core.remove_skin(&id, &|p| {
            deleted.borrow_mut().push(p.to_path_buf());
            Ok(())
        });
        assert_eq!(e.unwrap_err().code, "invalid_folder");
        assert!(deleted.borrow().is_empty());
        assert!(mods.is_dir());
    }

    #[test]
    fn apply_warns_about_unimported_mods_of_the_same_character() {
        let cfg = tempfile::tempdir().unwrap();
        let (_t, mods, lib) = fixture_world();
        let mut core = configured_core(cfg.path(), &mods, &lib);
        copy_dir(&mods.join("Furina/Casual"), &mods.join("Furina/Party"));
        core.rescan().unwrap();
        let out = core.apply(&picks(&[("furina", Some("furina--remembrance"))]), Fault::None, &mut noop).unwrap();
        assert!(out.warnings.iter().any(|w| w.contains("Furina/Party")), "{:?}", out.warnings);
    }

    #[test]
    fn editing_metadata_only_touches_library_json() {
        let cfg = tempfile::tempdir().unwrap();
        let (_t, mods, lib) = fixture_world();
        let mut core = configured_core(cfg.path(), &mods, &lib);
        let before = crate::core::apply::tests::tree(&mods);
        let snap = core
            .update_skin(
                "sandrone--marionette",
                SkinPatch {
                    name: Some("Marionette (Neyori)".into()),
                    notes: Some("hat 2 looks best".into()),
                    hotkey_labels: Some(vec![HotkeyLabel {
                        section: "KeyHat".into(),
                        ini_file: "sandrone_marionette_by_neyori/outfit/Sandrone.ini".into(),
                        keys: "no_modifiers 8".into(),
                        label: "Hat style".into(),
                    }]),
                    ..SkinPatch::default()
                },
            )
            .unwrap();
        let s = snap.library.skin("sandrone--marionette").unwrap();
        assert_eq!(s.name, "Marionette (Neyori)");
        assert_eq!(s.notes.as_deref(), Some("hat 2 looks best"));
        assert!(s.hotkeys.iter().any(|h| h.label == "Hat style"));
        assert_eq!(crate::core::apply::tests::tree(&mods), before, "mod files untouched");
        // labels survive a re-scan
        let snap = core.rescan().unwrap();
        assert!(snap.library.skin("sandrone--marionette").unwrap().hotkeys.iter().any(|h| h.label == "Hat style"));
        assert!(
            core.update_skin("sandrone--marionette", SkinPatch { name: Some("  ".into()), ..SkinPatch::default() })
                .is_err()
        );
    }

    #[test]
    fn a_skin_can_move_to_another_entity() {
        let cfg = tempfile::tempdir().unwrap();
        let (_t, mods, lib) = fixture_world();
        let mut core = configured_core(cfg.path(), &mods, &lib);
        // enabled skins can't move (their folder would stay on under the old name)
        let e =
            core.update_skin("furina--casual", SkinPatch { entity_id: Some("kazuha".into()), ..SkinPatch::default() });
        assert_eq!(e.unwrap_err().code, "skin_enabled");
        core.apply(&picks(&[("furina", Some("furina--remembrance"))]), Fault::None, &mut noop).unwrap();
        let snap = core
            .update_skin("furina--casual", SkinPatch { entity_id: Some("kazuha".into()), ..SkinPatch::default() })
            .unwrap();
        assert_eq!(snap.library.skin("furina--casual").unwrap().entity_id, "kazuha");
        assert!(snap.library.entity("kazuha").unwrap().skin_ids.contains(&"furina--casual".to_string()));
        assert!(!snap.library.entity("furina").unwrap().skin_ids.contains(&"furina--casual".to_string()));
        let snap = core
            .update_entity(
                "kazuha",
                EntityPatch { aliases: Some(vec!["Kaz".into(), " ".into()]), ..EntityPatch::default() },
            )
            .unwrap();
        assert_eq!(snap.library.entity("kazuha").unwrap().aliases, vec!["Kaz".to_string()]);
    }
}
