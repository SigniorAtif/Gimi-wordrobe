//! `AppCore` owns the app's state and implements every operation the commands expose.
//! Tauri-free, so integration tests can drive it directly against fixtures.

use super::error::{AppError, AppResult};
use super::hashindex::HashIndex;
use super::import;
use super::library;
use super::model::{Library, Settings, Snapshot};
use super::scanner::{self, ScanContext, ScanResult};
use super::settings;
use super::state;
use std::fs;
use std::path::{Path, PathBuf};

/// Library sub-folders the webview may load images from (asset protocol scope).
pub const IMAGE_DIRS: [&str; 2] = ["previews", "portraits"];
pub const STASH_DIR: &str = "stash";
pub const HASH_INDEX_FILE: &str = "hash_index.json";

pub struct AppCore {
    config_dir: PathBuf,
    /// Bundled resources (hash_index.json); None in tests.
    resource_dir: Option<PathBuf>,
    settings: Settings,
    library: Library,
    index: HashIndex,
    last_scan: Option<ScanResult>,
    /// library.json exists but can't be read: nothing is adopted or saved until it's fixed.
    library_error: Option<String>,
    /// settings.json on disk fails validation (hand-edited): treated as not configured.
    settings_error: Option<String>,
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
            last_scan: None,
            library_error: None,
            settings_error: None,
        };
        if core.settings.is_configured()
            && let Err(e) = settings::validate(&core.settings)
        {
            core.settings_error = Some(format!("Your saved settings need fixing: {}", e.message));
        }
        core.index = core.load_index();
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
        Snapshot {
            settings: self.settings.clone(),
            library: self.library.clone(),
            disk: state::disk_state(&self.library, mods.as_deref(), stash.as_deref(), libraries, unknown),
            changed_outside: false,
            recovered: None,
            hash_index: self.index.info(),
            configured: self.settings.is_configured() && self.settings_error.is_none(),
            notice: self.settings_error.clone().or_else(|| self.library_error.clone()),
            same_drive: settings::same_drive(&self.settings),
        }
    }

    pub fn load(&mut self) -> AppResult<Snapshot> {
        self.rescan()
    }

    /// Re-read the Mods folder. On the very first scan of an empty library every mod root is adopted
    /// (the review screen of SPEC §5 refines this in the import milestone).
    pub fn rescan(&mut self) -> AppResult<Snapshot> {
        let Some(mods) = self.mods_dir().filter(|m| m.is_dir()) else {
            self.last_scan = None;
            return Ok(self.snapshot());
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
        let mut changed = false;
        if self.library.skins.is_empty() && !scan.candidates.is_empty() {
            changed |= import::adopt_unowned(&mut self.library, &scan) > 0;
        }
        changed |= self.refresh_active_skins(&scan);
        self.last_scan = Some(scan);
        if changed {
            self.save_library()?;
        }
        Ok(self.snapshot())
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
    pub fn save_settings(&mut self, next: Settings) -> AppResult<Snapshot> {
        settings::validate(&next)?;
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
}
