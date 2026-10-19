//! `AppCore` owns the app's state and implements every operation the commands expose.
//! Tauri-free, so integration tests can drive it directly against fixtures.

use super::error::AppResult;
use super::model::{DiskState, HashIndexInfo, Library, Settings, Snapshot};
use super::settings;
use std::fs;
use std::path::{Path, PathBuf};

/// Library sub-folders the webview may load images from (asset protocol scope).
pub const IMAGE_DIRS: [&str; 2] = ["previews", "portraits"];

pub struct AppCore {
    config_dir: PathBuf,
    settings: Settings,
    library: Library,
}

impl AppCore {
    pub fn open(config_dir: &Path) -> Self {
        let settings = settings::load(config_dir);
        AppCore { config_dir: config_dir.to_path_buf(), settings, library: Library::default() }
    }

    pub fn settings(&self) -> &Settings {
        &self.settings
    }

    pub fn snapshot(&self) -> Snapshot {
        Snapshot {
            settings: self.settings.clone(),
            library: self.library.clone(),
            disk: DiskState {
                mods_path: self.settings.mods_path().map(str::to_string),
                mods_exists: self.settings.mods_path().map(|p| Path::new(p).is_dir()).unwrap_or(false),
                ..DiskState::default()
            },
            changed_outside: false,
            recovered: None,
            hash_index: HashIndexInfo::default(),
            configured: self.settings.is_configured(),
            same_drive: settings::same_drive(&self.settings),
        }
    }

    pub fn load(&mut self) -> AppResult<Snapshot> {
        Ok(self.snapshot())
    }

    pub fn rescan(&mut self) -> AppResult<Snapshot> {
        Ok(self.snapshot())
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
        self.settings = next;
        self.rescan()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(lib.is_dir(), "library folder is created");

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
}
