//! Settings persistence and validation (SPEC §4, §5 first run, §6 Settings).

use super::error::{AppError, AppResult};
use super::fsutil;
use super::model::{Loader, NsfwSettings, Settings};
use super::paths;
use serde::Serialize;
use std::path::{Path, PathBuf};

pub const FILE: &str = "settings.json";

pub fn path(config_dir: &Path) -> PathBuf {
    config_dir.join(FILE)
}

pub fn load(config_dir: &Path) -> Settings {
    let p = path(config_dir);
    let mut s = match fsutil::read_json_or_bak::<Settings>(&p) {
        Ok(Some(s)) => s,
        Ok(None) => Settings::default(),
        Err(_) => {
            // keep the unreadable file for the user before defaults get saved over it
            let _ = std::fs::copy(&p, fsutil::with_suffix(&p, ".corrupt"));
            Settings::default()
        }
    };
    // a reveal hotkey that is no longer allowed (e.g. Ctrl+S, saved before it was reserved) falls back to the default
    // instead of sending the whole app back to first-run setup
    if check_hotkey(&s.nsfw.hotkey).is_err() {
        s.nsfw.hotkey = NsfwSettings::default().hotkey;
    }
    s
}

pub fn save(config_dir: &Path, s: &Settings) -> AppResult<()> {
    fsutil::write_json_atomic(&path(config_dir), s, true)?;
    Ok(())
}

/// Reject settings that would put files where 3DMigoto loads them, or that cannot work at all.
pub fn validate(s: &Settings) -> AppResult<()> {
    let lib = s.library_path.trim();
    let mods: Vec<&str> = [s.mods_path.xxmi.as_deref(), s.mods_path.migoto.as_deref()]
        .into_iter()
        .flatten()
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .collect();
    for p in mods.iter().copied().chain((!lib.is_empty()).then_some(lib)) {
        if !paths::is_absolute_like(p) {
            return Err(AppError::new(
                "relative_path",
                format!("Use a full path, e.g. D:\\mods\\SkinLibrary (got \"{p}\")."),
            ));
        }
        if paths::has_parent_ref(p) {
            return Err(AppError::new("parent_ref", format!("Paths can't contain \"..\" ({p}).")));
        }
    }
    if !lib.is_empty() && paths::is_drive_root(lib) {
        return Err(AppError::new("library_root", "Pick a folder for the Library, not a whole drive."));
    }
    for m in &mods {
        if !lib.is_empty() && paths::is_within(lib, m) {
            return Err(AppError::new(
                "library_inside_mods",
                "The Library can't be inside a Mods folder: 3DMigoto would load every stashed skin.",
            ));
        }
        if !lib.is_empty() && paths::is_within(m, lib) {
            return Err(AppError::new("mods_inside_library", "The Mods folder can't be inside the Library."));
        }
    }
    check_hotkey(&s.nsfw.hotkey)
}

/// App shortcuts the NSFW reveal hotkey may not shadow (SPEC §12), plus Alt+F4, which closes the window.
const RESERVED_HOTKEYS: &[(&str, &str)] = &[
    ("ctrl+s", "Ctrl+S applies your changes"),
    ("ctrl+z", "Ctrl+Z undoes the last pick"),
    ("ctrl+f", "Ctrl+F focuses search"),
    ("alt+f4", "Alt+F4 closes the window"),
];

/// "Shift+Ctrl+H" -> "ctrl+shift+h": modifiers in a fixed order, so equal combos compare equal. None unless it is
/// Ctrl and/or Alt (plus optional Shift) and exactly one other key: plain typing focuses search (SPEC §12), so a bare
/// key would never reach the reveal toggle.
pub fn normalize_hotkey(hotkey: &str) -> Option<String> {
    let parts: Vec<String> = hotkey.split('+').map(|p| p.trim().to_ascii_lowercase()).collect();
    let (key, mods) = parts.split_last()?;
    if key.is_empty() || matches!(key.as_str(), "ctrl" | "control" | "alt" | "shift" | "meta") {
        return None;
    }
    let (mut ctrl, mut alt, mut shift) = (false, false, false);
    for m in mods {
        match m.as_str() {
            "ctrl" | "control" => ctrl = true,
            "alt" => alt = true,
            "shift" => shift = true,
            _ => return None,
        }
    }
    if !ctrl && !alt {
        return None;
    }
    let mut out = String::new();
    for (on, name) in [(ctrl, "ctrl+"), (alt, "alt+"), (shift, "shift+")] {
        if on {
            out.push_str(name);
        }
    }
    out.push_str(key);
    Some(out)
}

/// The NSFW reveal hotkey (Settings › NSFW) must be a real combo and must not shadow another app shortcut.
pub fn check_hotkey(hotkey: &str) -> AppResult<()> {
    let Some(norm) = normalize_hotkey(hotkey) else {
        return Err(AppError::new(
            "invalid_hotkey",
            "The NSFW reveal hotkey needs Ctrl or Alt plus a key, e.g. Ctrl+H.",
        ));
    };
    match RESERVED_HOTKEYS.iter().find(|(combo, _)| *combo == norm) {
        Some((_, what)) => Err(AppError::new("reserved_hotkey", format!("{what}. Pick another reveal hotkey."))),
        None => Ok(()),
    }
}

/// Library and Mods on the same drive means a move is an instant rename (SPEC §3).
pub fn same_drive(s: &Settings) -> Option<bool> {
    let mods = s.mods_path()?;
    if s.library_path.trim().is_empty() {
        return None;
    }
    match (paths::windows_drive(mods), paths::windows_drive(&s.library_path)) {
        (Some(a), Some(b)) => Some(a == b),
        _ => same_device(Path::new(mods), Path::new(&s.library_path)),
    }
}

#[cfg(unix)]
fn same_device(a: &Path, b: &Path) -> Option<bool> {
    use std::os::unix::fs::MetadataExt;
    let dev = |p: &Path| p.ancestors().find_map(|x| std::fs::metadata(x).ok()).map(|m| m.dev());
    Some(dev(a)? == dev(b)?)
}

#[cfg(not(unix))]
fn same_device(_a: &Path, _b: &Path) -> Option<bool> {
    None
}

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct FirstRunDefaults {
    pub loader: Option<Loader>,
    pub mods_3dmigoto: Option<String>,
    pub mods_xxmi: Option<String>,
    pub library: Option<String>,
}

/// First-run pre-fill (SPEC §5). Windows paths only; Linux pre-fills nothing (SPEC §0).
#[cfg(windows)]
pub fn first_run_defaults() -> FirstRunDefaults {
    let migoto = PathBuf::from(r"D:\mods\3dmigoto\Mods");
    let xxmi = std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join("XXMI Launcher").join("GIMI").join("Mods"));
    let m = migoto.is_dir().then(|| migoto.to_string_lossy().into_owned());
    let x = xxmi.filter(|p| p.is_dir()).map(|p| p.to_string_lossy().into_owned());
    let loader = if m.is_some() {
        Some(Loader::Migoto)
    } else if x.is_some() {
        Some(Loader::Xxmi)
    } else {
        None
    };
    // Same drive as the Mods folder so moves are instant renames, and never a drive root (needs admin).
    let library = Some(if m.is_some() || x.is_none() {
        r"D:\mods\SkinLibrary".to_string()
    } else {
        // XXMI only: next to the GIMI folder, e.g. %AppData%\XXMI Launcher\SkinLibrary
        let mods = PathBuf::from(x.as_deref().unwrap_or_default());
        mods.parent()
            .and_then(Path::parent)
            .map(|p| p.join("SkinLibrary").to_string_lossy().into_owned())
            .unwrap_or_else(|| r"D:\mods\SkinLibrary".to_string())
    });
    FirstRunDefaults { loader, mods_3dmigoto: m, mods_xxmi: x, library }
}

#[cfg(not(windows))]
pub fn first_run_defaults() -> FirstRunDefaults {
    FirstRunDefaults::default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::model::WhenHidden;

    fn s(mods: &str, lib: &str) -> Settings {
        let mut s = Settings::default();
        s.mods_path.migoto = Some(mods.into());
        s.library_path = lib.into();
        s
    }

    #[test]
    fn library_inside_mods_is_rejected() {
        let e = validate(&s("D:\\mods\\3dmigoto\\Mods", "d:\\MODS\\3dmigoto\\mods\\SkinLibrary")).unwrap_err();
        assert_eq!(e.code, "library_inside_mods");
        let e = validate(&s("D:\\lib\\Mods", "D:\\lib")).unwrap_err();
        assert_eq!(e.code, "mods_inside_library");
        assert!(validate(&s("D:\\mods\\3dmigoto\\Mods", "D:\\mods\\SkinLibrary")).is_ok());
    }

    #[test]
    fn rejects_relative_root_and_dotdot_paths_and_bare_hotkeys() {
        assert_eq!(validate(&s("D:\\mods\\Mods", "SkinLibrary")).unwrap_err().code, "relative_path");
        assert_eq!(validate(&s("D:\\mods\\Mods", "D:\\")).unwrap_err().code, "library_root");
        assert_eq!(validate(&s("D:\\mods\\Mods", "D:\\mods\\x\\..\\Mods\\Lib")).unwrap_err().code, "parent_ref");
        let mut v = s("D:\\mods\\Mods", "D:\\mods\\Lib");
        v.nsfw.hotkey = "H".into();
        assert_eq!(validate(&v).unwrap_err().code, "invalid_hotkey");
        v.nsfw.hotkey = "Alt+Shift+N".into();
        assert!(validate(&v).is_ok());
        v.nsfw.hotkey = "Ctrl+S".into();
        assert_eq!(validate(&v).unwrap_err().code, "reserved_hotkey");
    }

    #[test]
    fn reveal_hotkey_needs_ctrl_or_alt_and_one_free_key() {
        for bad in ["H", "Shift+H", "Ctrl+", "Ctrl+Shift", "Ctrl+Alt", "Win+H", "", "+"] {
            assert_eq!(check_hotkey(bad).unwrap_err().code, "invalid_hotkey", "{bad:?}");
        }
        for reserved in ["Ctrl+S", "ctrl+z", " Ctrl + F ", "Alt+F4"] {
            assert_eq!(check_hotkey(reserved).unwrap_err().code, "reserved_hotkey", "{reserved:?}");
        }
        for ok in ["Ctrl+H", "Alt+H", "Ctrl+Shift+S", "Ctrl+Alt+F4", "Alt+Shift+N", "Ctrl+F5", "Control+H"] {
            assert!(check_hotkey(ok).is_ok(), "{ok:?}");
        }
        assert_eq!(normalize_hotkey("Shift+Alt+Ctrl+h").as_deref(), Some("ctrl+alt+shift+h"));
        assert_eq!(normalize_hotkey("Shift+Ctrl+H"), normalize_hotkey("ctrl+shift+h"));
    }

    #[test]
    fn nsfw_settings_and_pin_hash_persist() {
        let dir = tempfile::tempdir().unwrap();
        let mut v = s("D:\\mods\\3dmigoto\\Mods", "D:\\mods\\SkinLibrary");
        v.nsfw = NsfwSettings {
            hotkey: "Alt+Shift+N".into(),
            when_hidden: WhenHidden::Invisible,
            auto_rehide: false,
            pin_hash: Some("$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA".into()),
        };
        save(dir.path(), &v).unwrap();
        let raw = std::fs::read_to_string(path(dir.path())).unwrap();
        assert!(raw.contains("\"whenHidden\": \"invisible\"") && raw.contains("\"autoRehide\": false"), "{raw}");
        assert!(raw.contains("\"pinHash\""));
        assert_eq!(load(dir.path()), v);
        // no PIN: the field is left out of the file entirely
        v.nsfw.pin_hash = None;
        save(dir.path(), &v).unwrap();
        assert!(!std::fs::read_to_string(path(dir.path())).unwrap().contains("pinHash"));
        assert_eq!(load(dir.path()), v);
    }

    #[test]
    fn a_hotkey_saved_before_it_was_reserved_falls_back_to_ctrl_h() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            path(dir.path()),
            r#"{"libraryPath":"D:\\lib","nsfw":{"hotkey":"Ctrl+S","whenHidden":"invisible","autoRehide":false}}"#,
        )
        .unwrap();
        let loaded = load(dir.path());
        assert_eq!(loaded.nsfw.hotkey, "Ctrl+H");
        assert_eq!(loaded.nsfw.when_hidden, WhenHidden::Invisible);
        assert!(!loaded.nsfw.auto_rehide);
        assert_eq!(loaded.library_path, "D:\\lib");
    }

    #[test]
    fn save_and_load_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load(dir.path()), Settings::default());
        let v = s("D:\\mods\\3dmigoto\\Mods", "D:\\mods\\SkinLibrary");
        save(dir.path(), &v).unwrap();
        assert_eq!(load(dir.path()), v);
    }

    #[test]
    fn drive_detection() {
        assert_eq!(same_drive(&s("D:\\mods\\Mods", "d:\\lib")), Some(true));
        assert_eq!(same_drive(&s("D:\\mods\\Mods", "E:\\lib")), Some(false));
    }
}
