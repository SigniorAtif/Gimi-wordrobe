//! Adding skins from archives (SPEC §5, §6 A4/C4, §9): analyse an archive for the dialog, then extract it, split
//! out nested roots of other entities, place every skin inactive (stash or DISABLED_), record it in the library,
//! and optionally make it active through a normal Apply.

use super::app::AppCore;
use super::apply::{self, Fault};
use super::archive::{self, Entry};
use super::error::{AppError, AppResult};
use super::import;
use super::model::{Category, DisableMethod, Hotkey, Preview, PreviewSource, Skin, Snapshot};
use super::names;
use super::paths;
use super::scanner::{self, Guess, GuessReason, ScanContext, ScanResult};
use super::state;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveRoot {
    /// First folder of the root, relative to the archive's content root ("" = the whole archive).
    pub path: String,
    pub folders: Vec<String>,
    pub inis: Vec<String>,
    pub hotkeys: usize,
    pub hashes: Vec<String>,
    pub guess: Option<Guess>,
    /// Nested inside another root (Bennett's sword, Oz): split it out to toggle it on its own.
    pub nested: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveSummary {
    pub path: String,
    pub file_name: String,
    pub size: u64,
    pub file_count: usize,
    pub ini_count: usize,
    pub images: Vec<String>,
    pub entries: Vec<Entry>,
    pub roots: Vec<ArchiveRoot>,
    pub skipped: Vec<String>,
    pub suggested_name: String,
    pub nsfw_guess: bool,
    pub wrapper: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewEntity {
    pub name: String,
    pub category: Category,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub portrait_path: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddTarget {
    #[serde(default)]
    pub entity_id: Option<String>,
    #[serde(default)]
    pub new_entity: Option<NewEntity>,
    pub skin_name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddSplit {
    /// Root folder inside the archive (relative to the content root) that becomes its own skin.
    pub root_path: String,
    #[serde(flatten)]
    pub target: AddTarget,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddRequest {
    pub archive_path: String,
    pub main: AddTarget,
    #[serde(default)]
    pub splits: Vec<AddSplit>,
    /// Roots the user unticked: left out entirely.
    #[serde(default)]
    pub exclude: Vec<String>,
    #[serde(default)]
    pub nsfw: bool,
    #[serde(default)]
    pub game_banana_url: Option<String>,
    /// "archive" | "user" | "gamebanana" | "later"
    #[serde(default)]
    pub preview_source: String,
    #[serde(default)]
    pub user_image_path: Option<String>,
    #[serde(default)]
    pub make_active: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddResult {
    pub snapshot: Snapshot,
    pub skin_ids: Vec<String>,
    pub warnings: Vec<String>,
}

fn stage_dir(lib: &Path, tag: &str) -> PathBuf {
    let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    lib.join("tmp").join(format!("{tag}-{n}"))
}

/// The folder an archive sits in names its character in the user's archive library ("Benny", "Veresa/nsfw").
pub fn folder_hint(archive: &Path) -> Option<String> {
    let mut p = archive.parent()?;
    loop {
        let name = p.file_name()?.to_string_lossy().into_owned();
        let l = name.to_lowercase();
        if l == "nsfw" || l == "sfw" {
            p = p.parent()?;
            continue;
        }
        return Some(name);
    }
}

/// Group a scan of an extracted archive into dialog roots; use the folder hint when nothing better is known.
fn roots_of(scan: &ScanResult, hint: Option<&Guess>) -> Vec<ArchiveRoot> {
    let mut out = vec![];
    for c in &scan.candidates {
        let mut guess = c.guess.clone();
        if let Some(h) = hint
            && guess.as_ref().map(|g| g.reason <= GuessReason::NewName).unwrap_or(true)
        {
            guess = Some(h.clone());
        }
        let inis: Vec<String> = c.inis.iter().map(|&i| scan.inis[i].rel.clone()).collect();
        out.push(ArchiveRoot {
            path: c.folders.first().cloned().unwrap_or_default(),
            folders: c.folders.clone(),
            hotkeys: c.inis.iter().map(|&i| scan.inis[i].hotkeys.len()).sum(),
            inis,
            hashes: c.hashes.iter().cloned().collect(),
            guess,
            nested: false,
        });
        for n in &c.nested {
            out.push(ArchiveRoot {
                path: n.folder.clone(),
                folders: vec![n.folder.clone()],
                inis: n.inis.iter().map(|&i| scan.inis[i].rel.clone()).collect(),
                hotkeys: n.inis.iter().map(|&i| scan.inis[i].hotkeys.len()).sum(),
                hashes: n.hashes.iter().cloned().collect(),
                guess: n.guess.clone(),
                nested: true,
            });
        }
    }
    out
}

impl AppCore {
    fn hint_guess(&self, archive: &Path) -> (Option<String>, Option<Guess>) {
        let Some(hint) = folder_hint(archive) else { return (None, None) };
        // "Benny" -> Bennett via the library or the hash index names; else the folder name itself
        let lib = &self.library;
        let mut best: Option<(f32, String, Category, Option<String>)> = None;
        for e in &lib.entities {
            let s = names::name_score(&hint, &e.name, &e.aliases);
            if s >= 0.75 && best.as_ref().map(|b| s > b.0).unwrap_or(true) {
                best = Some((s, e.name.clone(), e.category, Some(e.id.clone())));
            }
        }
        for (i, n) in self.index.entity_names() {
            let s = names::name_score(&hint, n, &[]);
            if s >= 0.75 && best.as_ref().map(|b| s > b.0).unwrap_or(true) {
                best = Some((s, n.to_string(), self.index.category(i), None));
            }
        }
        let guess = match best {
            Some((s, name, category, id)) => Guess {
                entity_id: id.or_else(|| lib.find_entity_by_name(&name).map(|e| e.id.clone())),
                name,
                category,
                parent_name: None,
                confidence: 0.5 + 0.2 * s,
                reason: GuessReason::Folder,
            },
            None => Guess {
                entity_id: lib.find_entity_by_name(&hint).map(|e| e.id.clone()),
                name: names::display_name(&hint),
                category: Category::Character,
                parent_name: None,
                confidence: 0.45,
                reason: GuessReason::Folder,
            },
        };
        (Some(hint), Some(guess))
    }

    /// A4 / C4 summary: list, refuse unsafe archives, extract only the inis to read hashes and hotkeys.
    pub fn analyze_archive(&mut self, archive: &Path) -> AppResult<ArchiveSummary> {
        let lib = self.library_dir().ok_or_else(|| AppError::new("no_library", "Choose a Library folder first."))?;
        let entries = archive::list(archive)?;
        archive::check_entries(&entries)?;
        let stage = stage_dir(&lib, "analyze");
        let result = (|| {
            archive::extract(archive, &stage, &["*.[iI][nN][iI]"], &mut |_| {})?;
            archive::strip_unwanted(&stage)?;
            archive::sanitize_tree(&stage)?;
            let wrapper = archive::wrapper_of(&entries);
            let root = match &wrapper {
                Some(w) => stage.join(paths::sanitize_component(w.trim_end_matches('/'))),
                None => stage.clone(),
            };
            let (hint, hint_guess) = self.hint_guess(archive);
            let mut ctx = ScanContext::new(&self.index, &self.library);
            ctx.archive_root = true;
            if let Some(h) = &hint {
                ctx.extra_names.push(names::display_name(h));
            }
            let scan = scanner::scan(&root, &ctx);
            let roots = roots_of(&scan, hint_guess.as_ref());
            let prefix = wrapper.clone().unwrap_or_default();
            let files: Vec<String> = entries
                .iter()
                .filter(|e| !e.is_dir)
                .map(|e| e.path.strip_prefix(&prefix).unwrap_or(&e.path).to_string())
                .collect();
            let images = archive::preview_candidates(&files, &scan);
            let left_out = |p: &str| {
                p.split('/')
                    .any(|c| paths::is_junk_name(c) || scanner::is_library_dir(c) || scanner::is_library_file(c))
            };
            let skipped: Vec<String> = entries.iter().filter(|e| left_out(&e.path)).map(|e| e.path.clone()).collect();
            let file_name = archive.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let entity_name = roots.first().and_then(|r| r.guess.as_ref()).map(|g| g.name.clone()).unwrap_or_default();
            let base =
                wrapper.as_deref().map(|w| w.trim_end_matches('/').to_string()).unwrap_or_else(|| file_name.clone());
            let (suggested_name, _) = import::suggest_name(&[base], &entity_name, Some(&file_name), None);
            Ok(ArchiveSummary {
                path: archive.to_string_lossy().into_owned(),
                size: fs::metadata(archive).map(|m| m.len()).unwrap_or(0),
                file_count: files.len(),
                // only the inis that will actually be added (not desktop.ini or bundled library copies)
                ini_count: files.iter().filter(|f| f.to_lowercase().ends_with(".ini") && !left_out(f)).count(),
                file_name,
                images,
                entries,
                roots,
                skipped,
                suggested_name,
                nsfw_guess: archive::nsfw_guess(archive),
                wrapper,
            })
        })();
        let _ = fs::remove_dir_all(&stage);
        result
    }

    fn resolve_target(&mut self, t: &AddTarget) -> AppResult<String> {
        if let Some(id) = t.entity_id.as_ref().filter(|id| self.library.entity(id).is_some()) {
            return Ok(id.clone());
        }
        let ne =
            t.new_entity.as_ref().ok_or_else(|| AppError::new("no_entity", "Pick a character, weapon or extra."))?;
        let name = ne.name.trim();
        if name.is_empty() {
            return Err(AppError::new("no_entity", "The new character needs a name."));
        }
        let id = self.library.ensure_entity(name, ne.category, ne.parent_id.clone().filter(|p| !p.is_empty()));
        if let (Some(src), Some(lib)) = (ne.portrait_path.as_ref(), self.library_dir()) {
            let ext =
                Path::new(src).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_else(|| "png".into());
            let rel = format!("portraits/{id}.{ext}");
            fs::create_dir_all(lib.join("portraits"))?;
            fs::copy(src, lib.join(&rel))?;
            if let Some(e) = self.library.entity_mut(&id) {
                e.portrait = Some(rel);
            }
        }
        Ok(id)
    }

    /// `Entity/Skin` (sanitised), made unique against Mods, DISABLED_ copies, the stash and the library.
    fn unique_target(&self, entity_id: &str, skin_name: &str, mods: &Path, stash: &Path) -> String {
        let entity = self.library.entity(entity_id).map(|e| e.name.clone()).unwrap_or_else(|| entity_id.to_string());
        let e = paths::sanitize_component(&entity);
        let s = paths::sanitize_component(skin_name);
        // an entity folder that is itself an imported skin (Mods/Odette) can't hold more skins
        let base = if self.library.owner_of(&e).is_some() { format!("{e} - {s}") } else { format!("{e}/{s}") };
        let taken = |rel: &str| {
            state::resolve_ci(mods, rel).is_some()
                || state::find_disabled(mods, rel).is_some()
                || state::resolve_ci(stash, rel).is_some()
                || self.library.owner_of(rel).is_some()
        };
        if !taken(&base) {
            return base;
        }
        (2..).map(|n| format!("{base} ({n})")).find(|c| !taken(c)).unwrap()
    }

    /// Move an extracted folder into its inactive home: the stash (move) or `DISABLED_<name>` in Mods (prefix).
    fn place_inactive(&self, src: &Path, rel: &str, mods: &Path, stash: &Path) -> AppResult<PathBuf> {
        let dest = match self.settings.disable_method {
            DisableMethod::Move => paths::join_rel(stash, rel),
            DisableMethod::Prefix => {
                let (parent, last) = rel.rsplit_once('/').unwrap_or(("", rel));
                let r =
                    if parent.is_empty() { format!("DISABLED_{last}") } else { format!("{parent}/DISABLED_{last}") };
                paths::join_rel(mods, &r)
            }
        }
        .ok_or_else(|| AppError::new("bad_path", format!("Unsafe target path: {rel}")))?;
        if let Some(p) = dest.parent() {
            fs::create_dir_all(p)?;
        }
        apply::move_path(src, &dest)
            .map_err(|e| AppError::new("place_failed", format!("Couldn't place {}: {e}", dest.display())))?;
        Ok(dest)
    }

    /// Extract and add (SPEC §6 A4 "Extract & add", C4 "Add"). `progress(done, total, label)`.
    pub fn add_skin(&mut self, req: AddRequest, progress: &mut dyn FnMut(u64, u64, &str)) -> AppResult<AddResult> {
        let (mods, stash) = self.roots()?;
        self.recover_pending()?;
        let lib = self.library_dir().ok_or_else(|| AppError::new("no_library", "Choose a Library folder first."))?;
        let archive_path = PathBuf::from(&req.archive_path);
        let entries = archive::list(&archive_path)?;
        archive::check_entries(&entries)?;
        let total: u64 = entries.iter().map(|e| e.size).sum::<u64>().max(1);
        let stage = stage_dir(&lib, "add");
        let mut placed: Vec<PathBuf> = vec![];
        let library_before = self.library.clone();
        let result = (|| -> AppResult<(Vec<String>, Vec<String>)> {
            progress(0, total, "Extracting");
            archive::extract(&archive_path, &stage, &[], &mut |b| progress(b.min(total), total, "Extracting"))?;
            archive::strip_unwanted(&stage)?;
            archive::sanitize_tree(&stage)?;
            let root = archive::content_root(&stage)?;
            let mut ctx = ScanContext::new(&self.index, &self.library);
            ctx.archive_root = true;
            let scan = scanner::scan(&root, &ctx);
            for ex in &req.exclude {
                if let Some(p) = paths::join_rel(&root, ex).filter(|p| p != &root && p.exists()) {
                    fs::remove_dir_all(&p).or_else(|_| fs::remove_file(&p))?;
                }
            }
            let file_name = archive_path.file_name().map(|n| n.to_string_lossy().into_owned());
            let mut ids = vec![];
            // deepest first: a nested root must leave its parent before the parent moves
            let mut splits = req.splits.clone();
            splits.sort_by_key(|s| std::cmp::Reverse(s.root_path.matches('/').count()));
            let mut jobs: Vec<(Option<String>, AddTarget)> =
                splits.into_iter().map(|s| (Some(s.root_path), s.target)).collect();
            jobs.push((None, req.main.clone()));
            for (root_path, target) in jobs {
                let src = match &root_path {
                    Some(r) => paths::join_rel(&root, r)
                        .filter(|p| p.exists())
                        .ok_or_else(|| AppError::new("missing_root", format!("{r} isn't in the archive.")))?,
                    None => root.clone(),
                };
                if fs::read_dir(&src).map(|mut d| d.next().is_none()).unwrap_or(true) {
                    continue; // nothing left (everything split out or excluded)
                }
                let entity_id = self.resolve_target(&target)?;
                let name = target.skin_name.trim();
                let name = if name.is_empty() { "Skin" } else { name };
                let rel = self.unique_target(&entity_id, name, &mods, &stash);
                let prefix = root_path.clone().map(|r| format!("{}/", r.to_lowercase()));
                let own = |ini_rel: &str| -> Option<String> {
                    let l = ini_rel.to_lowercase();
                    match &prefix {
                        Some(p) => l.starts_with(p).then(|| ini_rel[p.len()..].to_string()),
                        // the main skin: what isn't inside a split root
                        None => {
                            (!req.splits.iter().any(|s| l.starts_with(&format!("{}/", s.root_path.to_lowercase()))))
                                .then(|| ini_rel.to_string())
                        }
                    }
                };
                let mut hotkeys: Vec<Hotkey> = vec![];
                let mut hashes: Vec<String> = vec![];
                for ini in &scan.inis {
                    if let Some(suffix) = own(&ini.rel) {
                        for mut h in ini.hotkeys.clone() {
                            h.ini_file = format!("{rel}/{suffix}");
                            hotkeys.push(h);
                        }
                        hashes.extend(ini.hashes.iter().cloned());
                    }
                }
                hashes.sort();
                hashes.dedup();
                let skin_id = self.library.unique_skin_id(&entity_id, name);
                // previews come out of the archive before the folder moves
                let mut previews: Vec<Preview> = vec![];
                if req.preview_source == "archive" {
                    let files: Vec<String> = archive::files_below(&src);
                    let picks = archive::preview_candidates(&files, &scan);
                    previews = copy_previews(&lib, &skin_id, &src, &picks, PreviewSource::Archive)?;
                } else if req.preview_source == "user"
                    && let Some(img) = &req.user_image_path
                {
                    let p = PathBuf::from(img);
                    let parent = p.parent().unwrap_or(Path::new("/")).to_path_buf();
                    let fname = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                    previews = copy_previews(&lib, &skin_id, &parent, &[fname], PreviewSource::User)?;
                }
                let dest = if root_path.is_none() && src == stage {
                    // files at the archive root: they become the skin folder's content
                    let tmp = stage.with_extension("root");
                    fs::rename(&stage, &tmp)?;
                    self.place_inactive(&tmp, &rel, &mods, &stash)?
                } else {
                    self.place_inactive(&src, &rel, &mods, &stash)?
                };
                placed.push(dest);
                self.library.add_skin(Skin {
                    id: skin_id.clone(),
                    entity_id,
                    name: name.to_string(),
                    folders: vec![rel],
                    nsfw: req.nsfw && root_path.is_none(),
                    game_banana_url: req.game_banana_url.clone().filter(|u| !u.trim().is_empty()),
                    source_archive: file_name.clone(),
                    previews,
                    hotkeys,
                    hashes,
                    added_at: import::now_iso(),
                    ..Skin::default()
                });
                ids.push(skin_id);
            }
            if ids.is_empty() {
                return Err(AppError::new("empty_archive", "Nothing in this archive was left to add."));
            }
            Ok((ids, vec![]))
        })();
        let _ = fs::remove_dir_all(&stage);
        let _ = fs::remove_dir_all(stage.with_extension("root"));
        let (ids, mut warnings) = match result {
            Ok(v) => v,
            Err(e) => {
                // undo: extracted copies are ours (the archive is untouched), so they can simply go
                for p in placed {
                    let _ = fs::remove_dir_all(&p);
                }
                self.library = library_before;
                return Err(e);
            }
        };
        self.save_library()?;
        let mut snapshot = self.rescan()?;
        if req.make_active {
            let main = ids.last().cloned().unwrap_or_default();
            if let Some(entity) = self.library.skin(&main).map(|s| s.entity_id.clone()) {
                let picks = std::iter::once((entity, Some(main))).collect();
                match self.apply(&picks, Fault::None, &mut |d, t, l| progress(d as u64, t as u64, l)) {
                    Ok(out) => {
                        warnings.extend(out.warnings);
                        snapshot = out.snapshot;
                    }
                    Err(e) => warnings.push(format!("Added, but making it active failed: {}", e.message)),
                }
            }
        }
        Ok(AddResult { snapshot, skin_ids: ids, warnings })
    }
}

/// Copy chosen images into `<Library>/previews/<skinId>/01.png, 02.jpg …` (first = cover).
fn copy_previews(
    lib: &Path,
    skin_id: &str,
    base: &Path,
    files: &[String],
    source: PreviewSource,
) -> AppResult<Vec<Preview>> {
    let dir = lib.join("previews").join(skin_id);
    let mut out = vec![];
    for (i, f) in files.iter().take(12).enumerate() {
        let Some(src) = paths::join_rel(base, f).filter(|p| p.is_file()) else { continue };
        let ext = src.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_else(|| "png".into());
        fs::create_dir_all(&dir)?;
        let name = format!("{:02}.{ext}", i + 1);
        fs::copy(&src, dir.join(&name))?;
        out.push(Preview { file: format!("previews/{skin_id}/{name}"), source });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::app::tests::{configured_core, fixture_world};
    use crate::core::archive::tests::fixture_archive;
    use crate::core::model::SkinLocation;

    fn target(entity: &str, skin: &str) -> AddTarget {
        AddTarget { entity_id: Some(entity.into()), new_entity: None, skin_name: skin.into() }
    }

    fn request(archive: &str, main: AddTarget) -> AddRequest {
        AddRequest {
            archive_path: fixture_archive(archive).to_string_lossy().into(),
            main,
            splits: vec![],
            exclude: vec![],
            nsfw: false,
            game_banana_url: None,
            preview_source: "archive".into(),
            user_image_path: None,
            make_active: false,
        }
    }

    #[test]
    fn analysis_finds_roots_nested_weapon_and_previews() {
        let cfg = tempfile::tempdir().unwrap();
        let (_t, mods, lib) = fixture_world();
        let mut core = configured_core(cfg.path(), &mods, &lib);
        let s = core.analyze_archive(&fixture_archive("bennett_beach.zip")).unwrap();
        assert_eq!(s.wrapper.as_deref(), Some("BennettBeachDay/"));
        let main = s.roots.iter().find(|r| !r.nested).unwrap();
        assert_eq!(main.path, "");
        assert_eq!(main.guess.as_ref().unwrap().name, "Bennett");
        let sword = s.roots.iter().find(|r| r.nested).expect("nested sword root");
        assert_eq!(sword.path, "TravelerHandySword");
        assert_eq!(sword.guess.as_ref().unwrap().name, "Skyward Blade");
        assert_eq!(s.images, vec!["prev (1).png"]);
        assert!(s.skipped.iter().any(|p| p.ends_with("desktop.ini")));
        assert!(s.skipped.iter().any(|p| p.starts_with("BufferValues")));
        assert!(!lib.join("tmp").read_dir().map(|mut d| d.next().is_some()).unwrap_or(false), "staging cleaned");
    }

    #[test]
    fn unsafe_archives_write_nothing() {
        let cfg = tempfile::tempdir().unwrap();
        let (_t, mods, lib) = fixture_world();
        let mut core = configured_core(cfg.path(), &mods, &lib);
        let before = crate::core::apply::tests::tree(&mods);
        for evil in ["evil_traversal.zip", "evil_absolute.zip"] {
            assert_eq!(core.analyze_archive(&fixture_archive(evil)).unwrap_err().code, "unsafe_archive");
            let e = core.add_skin(request(evil, target("furina", "Evil")), &mut |_, _, _| {}).unwrap_err();
            assert_eq!(e.code, "unsafe_archive");
        }
        assert_eq!(crate::core::apply::tests::tree(&mods), before);
        assert!(!Path::new("/tmp/skin-switcher-evil").exists());
        assert!(!lib.join("stash").exists());
    }

    #[test]
    fn add_splits_the_nested_weapon_and_never_places_junk_or_library_copies() {
        let cfg = tempfile::tempdir().unwrap();
        let (_t, mods, lib) = fixture_world();
        let mut core = configured_core(cfg.path(), &mods, &lib);
        let mut req = request(
            "bennett_beach.zip",
            AddTarget {
                entity_id: None,
                new_entity: Some(NewEntity {
                    name: "Bennett".into(),
                    category: Category::Character,
                    parent_id: None,
                    portrait_path: None,
                }),
                skin_name: "Beach Day".into(),
            },
        );
        req.splits = vec![AddSplit {
            root_path: "TravelerHandySword".into(),
            target: AddTarget {
                entity_id: None,
                new_entity: Some(NewEntity {
                    name: "Skyward Blade".into(),
                    category: Category::Weapon,
                    parent_id: None,
                    portrait_path: None,
                }),
                skin_name: "Bennett Beach Day".into(),
            },
        }];
        let out = core.add_skin(req, &mut |_, _, _| {}).unwrap();
        assert_eq!(out.skin_ids.len(), 2);
        let stash = lib.join("stash");
        assert!(stash.join("Bennett/Beach Day/BennettAdventure.ini").is_file());
        assert!(stash.join("Bennett/Beach Day/Face/Face.ini").is_file());
        assert!(!stash.join("Bennett/Beach Day/TravelerHandySword").exists(), "split out");
        assert!(stash.join("Skyward Blade/Bennett Beach Day/SkywardBlade.ini").is_file());
        let all = crate::core::apply::tests::tree(&lib);
        assert!(!all.iter().any(|p| p.0.to_lowercase().contains("desktop.ini")), "{all:?}");
        assert!(!all.iter().any(|p| p.0.contains("ORFix")), "bundled ORFix never placed");
        let snap = out.snapshot;
        let bennett = snap.library.skins.iter().find(|s| s.name == "Beach Day").unwrap();
        assert_eq!(snap.disk.skins[&bennett.id].location, SkinLocation::Stash, "added inactive");
        assert!(bennett.hotkeys.iter().all(|h| h.ini_file.starts_with("Bennett/Beach Day/")));
        assert_eq!(bennett.previews.len(), 1);
        assert!(lib.join(&bennett.previews[0].file).is_file());
        let sword = snap.library.skins.iter().find(|s| s.name == "Bennett Beach Day").unwrap();
        assert_eq!(snap.library.entity(&sword.entity_id).unwrap().category, Category::Weapon);
    }

    #[test]
    fn files_at_the_root_get_a_folder_and_make_active_runs_an_apply() {
        let cfg = tempfile::tempdir().unwrap();
        let (_t, mods, lib) = fixture_world();
        let mut core = configured_core(cfg.path(), &mods, &lib);
        let mut req = request("varesa_root_files.7z", target("varesa", "Cow Girl"));
        req.make_active = true;
        req.nsfw = true;
        let out = core.add_skin(req, &mut |_, _, _| {}).unwrap();
        assert!(mods.join("Varesa/Cow Girl/Varesa.ini").is_file(), "active in Mods");
        assert!(mods.join("Varesa/Cow Girl/help.txt").is_file());
        assert!(!mods.join("Varesa/Face").exists(), "the other Varesa skin was turned off");
        let skin = out.snapshot.library.skins.iter().find(|s| s.name == "Cow Girl").unwrap();
        assert!(skin.nsfw);
        assert_eq!(out.snapshot.disk.active["varesa"], vec![skin.id.clone()]);
    }

    #[test]
    fn name_collisions_get_a_number() {
        let cfg = tempfile::tempdir().unwrap();
        let (_t, mods, lib) = fixture_world();
        let mut core = configured_core(cfg.path(), &mods, &lib);
        core.add_skin(request("mona_starry_skin.zip", target("mona", "Starry Witch")), &mut |_, _, _| {}).unwrap();
        assert!(
            lib.join("stash/Mona/Starry Witch (2)/MonaStarry.ini").is_file(),
            "Mods/Mona/Starry Witch already exists"
        );
    }

    #[test]
    fn folder_hints_skip_sfw_and_nsfw() {
        assert_eq!(folder_hint(Path::new("/a/Charecters and wepon/Veresa/nsfw/x.rar")).as_deref(), Some("Veresa"));
        assert_eq!(folder_hint(Path::new("/a/Benny/bennettbeachday.zip")).as_deref(), Some("Benny"));
    }
}
