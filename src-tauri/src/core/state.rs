//! Where each skin is on disk right now (SPEC §4: active state is always derived from disk, never stored).

use super::model::{DiskState, Library, LibraryMod, Skin, SkinDiskState, SkinLocation};
use super::paths;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

/// Resolve a `/`-separated relative path under `base` case-insensitively (Windows rules on a case-sensitive
/// ntfs3 mount). Returns the real on-disk path when it exists.
pub fn resolve_ci(base: &Path, rel: &str) -> Option<PathBuf> {
    let mut cur = base.to_path_buf();
    for part in rel.split(['/', '\\']).filter(|s| !s.is_empty()) {
        if part == ".." || part.contains(':') {
            return None;
        }
        let exact = cur.join(part);
        if exact.symlink_metadata().is_ok() {
            cur = exact;
            continue;
        }
        let found = fs::read_dir(&cur)
            .ok()?
            .filter_map(Result::ok)
            .find(|e| e.file_name().to_string_lossy().eq_ignore_ascii_case(part))?;
        cur = found.path();
    }
    Some(cur)
}

/// Strip a leading `DISABLED`, `DISABLED_`, `DISABLED ` or `DISABLED-` (any case).
pub fn strip_disabled(name: &str) -> Option<&str> {
    if !paths::is_disabled_name(name) {
        return None;
    }
    let rest = &name[8..];
    Some(rest.strip_prefix(['_', ' ', '-']).unwrap_or(rest))
}

/// Find a skin folder that is switched off with a DISABLED prefix on itself or on any parent folder
/// (`Furina/DISABLED_Casual`, `DISABLED_Furina/Casual`). Returns the real path and its relative form.
pub fn find_disabled(mods: &Path, rel: &str) -> Option<(PathBuf, String)> {
    let parts: Vec<&str> = rel.split(['/', '\\']).filter(|s| !s.is_empty()).collect();
    let mut cur = mods.to_path_buf();
    let mut rel_parts: Vec<String> = vec![];
    let mut any_disabled = false;
    for part in parts {
        if part == ".." || part.contains(':') {
            return None;
        }
        let mut next: Option<(PathBuf, String, bool)> = None;
        for e in fs::read_dir(&cur).ok()?.filter_map(Result::ok) {
            let n = e.file_name().to_string_lossy().into_owned();
            if n.eq_ignore_ascii_case(part) {
                next = Some((e.path(), n, false));
                break;
            }
            if strip_disabled(&n).map(|s| s.eq_ignore_ascii_case(part)).unwrap_or(false) {
                next = Some((e.path(), n, true));
            }
        }
        let (p, n, disabled) = next?;
        any_disabled |= disabled;
        cur = p;
        rel_parts.push(n);
    }
    any_disabled.then(|| (cur, rel_parts.join("/")))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FolderPlace {
    Mods,
    Disabled,
    Stash,
    Missing,
}

pub fn place_of(mods: &Path, stash: Option<&Path>, rel: &str) -> FolderPlace {
    if resolve_ci(mods, rel).is_some() {
        return FolderPlace::Mods;
    }
    if find_disabled(mods, rel).is_some() {
        return FolderPlace::Disabled;
    }
    if let Some(st) = stash
        && resolve_ci(st, rel).is_some()
    {
        return FolderPlace::Stash;
    }
    FolderPlace::Missing
}

/// A skin is active when every one of its folders is in Mods and none is DISABLED-prefixed.
pub fn locate(skin: &Skin, mods: &Path, stash: Option<&Path>) -> SkinDiskState {
    let places: Vec<FolderPlace> = skin.folders.iter().map(|f| place_of(mods, stash, f)).collect();
    let all = |p: FolderPlace| !places.is_empty() && places.iter().all(|x| *x == p);
    let location = if all(FolderPlace::Mods) {
        SkinLocation::Mods
    } else if all(FolderPlace::Disabled) {
        SkinLocation::Disabled
    } else if all(FolderPlace::Stash) {
        SkinLocation::Stash
    } else if all(FolderPlace::Missing) {
        SkinLocation::Missing
    } else {
        SkinLocation::Partial
    };
    SkinDiskState { location, active: location == SkinLocation::Mods }
}

pub fn disk_state(
    lib: &Library,
    mods: Option<&Path>,
    stash: Option<&Path>,
    libraries: Vec<LibraryMod>,
    unknown_roots: Vec<String>,
) -> DiskState {
    let mut skins = BTreeMap::new();
    let mut active: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mods_exists = mods.map(Path::is_dir).unwrap_or(false);
    for s in &lib.skins {
        let st = match mods {
            Some(m) if mods_exists => locate(s, m, stash),
            _ => SkinDiskState { location: SkinLocation::Missing, active: false },
        };
        if st.active {
            active.entry(s.entity_id.clone()).or_default().push(s.id.clone());
        }
        skins.insert(s.id.clone(), st);
    }
    DiskState {
        mods_path: mods.map(|m| m.to_string_lossy().into_owned()),
        mods_exists,
        skins,
        active,
        libraries,
        unknown_roots,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::model::Skin;

    fn skin(folders: &[&str]) -> Skin {
        Skin {
            id: "s".into(),
            entity_id: "e".into(),
            folders: folders.iter().map(|s| s.to_string()).collect(),
            ..Skin::default()
        }
    }

    #[test]
    fn locates_skins_case_insensitively() {
        let t = tempfile::tempdir().unwrap();
        let mods = t.path().join("Mods");
        let stash = t.path().join("stash");
        fs::create_dir_all(mods.join("Furina/Remembrance")).unwrap();
        fs::create_dir_all(mods.join("Furina/DISABLED_Casual")).unwrap();
        fs::create_dir_all(stash.join("Furina/Party")).unwrap();
        fs::create_dir_all(mods.join("Varesa/Face")).unwrap();
        fs::create_dir_all(stash.join("Varesa/Outfit")).unwrap();
        let st = Some(stash.as_path());
        assert_eq!(locate(&skin(&["furina/REMEMBRANCE"]), &mods, st).location, SkinLocation::Mods);
        assert!(locate(&skin(&["Furina/Remembrance"]), &mods, st).active);
        assert_eq!(locate(&skin(&["Furina/Casual"]), &mods, st).location, SkinLocation::Disabled);
        assert_eq!(locate(&skin(&["Furina/Party"]), &mods, st).location, SkinLocation::Stash);
        assert_eq!(locate(&skin(&["Furina/Nope"]), &mods, st).location, SkinLocation::Missing);
        assert_eq!(locate(&skin(&["Varesa/Face", "Varesa/Outfit"]), &mods, st).location, SkinLocation::Partial);
        assert_eq!(strip_disabled("disabled Casual"), Some("Casual"));
        assert_eq!(strip_disabled("DISABLEDVaresa.ini"), Some("Varesa.ini"));
        assert!(resolve_ci(&mods, "../x").is_none());
        // a disabled parent folder switches the skin off too
        fs::create_dir_all(mods.join("DISABLED_Kazuha/Multi")).unwrap();
        assert_eq!(locate(&skin(&["Kazuha/Multi"]), &mods, st).location, SkinLocation::Disabled);
        assert_eq!(find_disabled(&mods, "kazuha/multi").unwrap().1, "DISABLED_Kazuha/Multi");
    }
}
