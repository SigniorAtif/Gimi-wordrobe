//! First-run import and Re-scan review (SPEC §5). `plan_import` reads the Mods folder and the archive library inside
//! it and proposes skins (entity guess, name, NSFW) without changing anything; only the inis of archives are
//! extracted, into `<Library>/tmp`. `apply_import` then adopts installed mods where they are, extracts the confirmed
//! archives inactive, optionally moves archives out of Mods into `<Library>/archives/`, and finally settles which skin
//! stays enabled where several of one entity are on.

use super::add::{AddRequest, AddSplit, AddTarget, ArchiveSummary};
use super::app::AppCore;
use super::apply::{self, Fault};
use super::error::{AppError, AppResult};
use super::import;
use super::model::{Skin, Snapshot};
use super::modfix::FixReport;
use super::names;
use super::paths;
use super::scanner::{self, Candidate, Guess, GuessReason, ScanContext, ScanResult};
use super::state;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ImportSource {
    /// Already in Mods: adopted where it is, nothing moves.
    #[serde(rename_all = "camelCase")]
    Installed { folders: Vec<String> },
    /// A mod root inside an archive of the archive library (path relative to Mods).
    #[serde(rename_all = "camelCase")]
    Archive {
        archive: String,
        root: String,
        folders: Vec<String>,
        /// the archive's main skin; the other roots split out of it or stay part of it
        main: bool,
        nested: bool,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportItem {
    pub key: String,
    pub source: ImportSource,
    pub guess: Guess,
    pub skin_name: String,
    pub author: Option<String>,
    pub nsfw: bool,
    pub hotkeys: usize,
    pub images: usize,
    /// the archive's main item, for its other roots
    pub parent: Option<String>,
    /// default for a non-main root: its own skin (another entity) rather than part of the main one
    pub own: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportArchive {
    /// relative to Mods
    pub path: String,
    pub size: u64,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportPlan {
    pub items: Vec<ImportItem>,
    /// every archive of the archive library (the ones inside Mods sub-folders), with read errors
    pub archives: Vec<ImportArchive>,
    /// archives lying directly in the Mods folder (copies of installed mods): offered a move to the Library
    pub stray: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportChoice {
    pub key: String,
    pub include: bool,
    #[serde(flatten)]
    pub target: AddTarget,
    #[serde(default)]
    pub nsfw: bool,
    #[serde(default)]
    pub own: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRequest {
    pub choices: Vec<ImportChoice>,
    #[serde(default)]
    pub move_archives: bool,
    #[serde(default)]
    pub move_stray: bool,
    /// Item keys (or existing skin ids) that stay enabled where an entity has several on; the others are disabled
    /// through a normal Apply. Entities not listed keep every skin as it is.
    #[serde(default)]
    pub keep_active: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub snapshot: Snapshot,
    pub added: usize,
    pub warnings: Vec<String>,
}

/// What a plan was built from, kept until it is applied.
#[derive(Debug, Clone)]
pub struct PlanState {
    plan: ImportPlan,
    scan: ScanResult,
    installed: HashMap<String, Candidate>,
}

/// "nsfw", "lewd"… in a folder or file name.
fn looks_nsfw(rel: &str) -> bool {
    let l = rel.to_lowercase();
    l.split(['/', '\\']).any(|c| c == "nsfw") || ["nsfw", "lewd", "nude", "hentai", "18+"].iter().any(|w| l.contains(w))
}

/// Same entity, judged from two guesses (library id when known, else the name).
fn same_entity(a: &Guess, b: &Guess) -> bool {
    match (&a.entity_id, &b.entity_id) {
        (Some(x), Some(y)) => x == y,
        _ => a.key() == b.key(),
    }
}

/// The root that is the archive's skin: the one matching the folder the archive sits in ("Neuvilette"), else the
/// first that isn't nested.
fn main_root(summary: &ArchiveSummary, hint: Option<&str>) -> usize {
    let named = hint.and_then(|h| {
        summary
            .roots
            .iter()
            .position(|r| !r.nested && r.guess.as_ref().is_some_and(|g| names::name_score(h, &g.name, &[]) >= 0.8))
    });
    named.or_else(|| summary.roots.iter().position(|r| !r.nested)).unwrap_or(0)
}

fn unknown_guess(folder: &str) -> Guess {
    Guess {
        entity_id: None,
        name: names::display_name(folder.rsplit('/').next().unwrap_or(folder)),
        category: super::model::Category::Character,
        parent_name: None,
        confidence: 0.1,
        reason: GuessReason::NewName,
    }
}

/// Remove `dir` and its parents up to (not including) `stop` while they are empty.
fn prune_empty(dir: &Path, stop: &Path) {
    let mut cur = Some(dir);
    while let Some(d) = cur {
        if d == stop || !d.starts_with(stop) || fs::remove_dir(d).is_err() {
            break;
        }
        cur = d.parent();
    }
}

/// An archive moved into the Library: where it was, its Library-relative path, and each skin's old `source_archive`.
type MovedArchive = (PathBuf, String, Vec<(String, Option<String>)>);

/// Move one archive from Mods to `<Library>/archives/[<entity>/]`, returning where it was and its Library-relative
/// path. The copy is written as `<name>.part` and renamed once complete, so a cross-drive copy cut short by a crash
/// never looks like a whole archive. Folders the move empties are removed, up to Mods.
fn move_archive(
    mods: &Path,
    lib: &Path,
    rel: &str,
    entity: Option<&str>,
    warnings: &mut Vec<String>,
) -> Option<(PathBuf, String)> {
    let src = paths::join_rel(mods, rel).filter(|p| p.is_file())?;
    let file = src.file_name()?.to_string_lossy().into_owned();
    let folder = entity.map(paths::sanitize_component);
    let (stem, ext) = file.rsplit_once('.').unwrap_or((file.as_str(), ""));
    let dest_rel = (1..)
        .map(|i| match (i, &folder) {
            (1, Some(f)) => format!("archives/{f}/{file}"),
            (1, None) => format!("archives/{file}"),
            (i, Some(f)) => format!("archives/{f}/{stem} ({i}).{ext}"),
            (i, None) => format!("archives/{stem} ({i}).{ext}"),
        })
        .find(|r| !lib.join(r).exists() && !lib.join(format!("{r}.part")).exists())?;
    let dest = lib.join(&dest_rel);
    let part = lib.join(format!("{dest_rel}.part"));
    let result = fs::create_dir_all(dest.parent()?).and_then(|()| apply::move_path(&src, &part)).and_then(|()| {
        fs::rename(&part, &dest).inspect_err(|_| {
            // the archive is whole in `part`; take it back rather than leave it under a name nobody looks for
            let _ = apply::move_path(&part, &src);
        })
    });
    match result {
        Ok(()) => {
            if let Some(parent) = src.parent() {
                prune_empty(parent, mods);
            }
            Some((src, dest_rel))
        }
        Err(e) => {
            warnings.push(format!("Couldn't move {rel} to the Library: {e}"));
            None
        }
    }
}

/// Two archive paths (`/` or `\` separated) name the same file, ignoring folders and case.
fn same_file(a: &str, b: &str) -> bool {
    let name = |p: &str| p.rsplit(['/', '\\']).next().unwrap_or(p).to_lowercase();
    name(a) == name(b)
}

impl AppCore {
    /// Build the review list (SPEC §5 steps 2-4). Reads only; archive inis are extracted to `<Library>/tmp`.
    /// `progress(done, total, label)` reports the archives as they are read.
    pub fn plan_import(&mut self, progress: &mut dyn FnMut(usize, usize, &str)) -> AppResult<ImportPlan> {
        let mods = self
            .mods_dir()
            .filter(|m| m.is_dir())
            .ok_or_else(|| AppError::new("no_mods", "The Mods folder isn't set or doesn't exist."))?;
        self.library_dir().ok_or_else(|| AppError::new("no_library", "Choose a Library folder first."))?;
        let scan = {
            let ctx = ScanContext::new(&self.index, &self.library);
            scanner::scan(&mods, &ctx)
        };
        let mut plan = ImportPlan::default();
        let mut installed = HashMap::new();
        for c in &scan.candidates {
            if c.folders.iter().any(|f| self.library.owner_of(f).is_some()) {
                continue;
            }
            let guess = c.guess.clone().unwrap_or_else(|| import::fallback_guess(c));
            let entity_name = guess
                .entity_id
                .as_ref()
                .and_then(|id| self.library.entity(id))
                .map(|e| e.name.clone())
                .unwrap_or_else(|| guess.name.clone());
            let hint = import::child_hint(&scan, c);
            let (skin_name, author) = import::suggest_name(&c.folders, &entity_name, None, hint.as_deref());
            let key = format!("mods:{}", c.folders.join("|"));
            plan.items.push(ImportItem {
                key: key.clone(),
                source: ImportSource::Installed { folders: c.folders.clone() },
                guess,
                skin_name,
                author,
                nsfw: c.folders.iter().any(|f| looks_nsfw(f)),
                hotkeys: scan.hotkeys_of(c).len(),
                images: 0,
                parent: None,
                own: false,
            });
            installed.insert(key, c.clone());
        }
        plan.stray = scan.stray_archives.clone();
        let library: Vec<String> = scan.archives.iter().filter(|a| !plan.stray.contains(a)).cloned().collect();
        for (i, rel) in library.iter().enumerate() {
            progress(i, library.len(), rel);
            let Some(abs) = paths::join_rel(&mods, rel) else { continue };
            let size = fs::metadata(&abs).map(|m| m.len()).unwrap_or(0);
            // left in Mods by an earlier import (moving was off or failed): offering it again would duplicate skins
            if self.library.skins.iter().any(|s| s.source_archive.as_deref().is_some_and(|a| same_file(a, rel))) {
                let error = Some("Its skins are already in the library.".to_string());
                plan.archives.push(ImportArchive { path: rel.clone(), size, error });
                continue;
            }
            let summary = match self.analyze_archive(&abs) {
                Ok(s) if !s.roots.is_empty() => s,
                Ok(_) => {
                    let error = Some("No mod (.ini file) inside.".to_string());
                    plan.archives.push(ImportArchive { path: rel.clone(), size, error });
                    continue;
                }
                Err(e) => {
                    plan.archives.push(ImportArchive { path: rel.clone(), size, error: Some(e.message) });
                    continue;
                }
            };
            plan.archives.push(ImportArchive { path: rel.clone(), size, error: None });
            let hint = super::add::folder_hint(&abs);
            let m = main_root(&summary, hint.as_deref());
            let main_guess = summary.roots[m].guess.clone().unwrap_or_else(|| unknown_guess(rel));
            let main_key = format!("archive:{rel}#{}", summary.roots[m].path);
            let nsfw = summary.nsfw_guess;
            let main_entity = main_guess
                .entity_id
                .as_ref()
                .and_then(|id| self.library.entity(id))
                .map(|e| e.name.clone())
                .unwrap_or_else(|| main_guess.name.clone());
            // the main root first, then the others in archive order
            let order = std::iter::once(m).chain((0..summary.roots.len()).filter(|&j| j != m));
            for j in order {
                let r = &summary.roots[j];
                let main = j == m;
                let guess =
                    if main { main_guess.clone() } else { r.guess.clone().unwrap_or_else(|| unknown_guess(&r.path)) };
                let own = !main && (r.nested || !same_entity(&guess, &main_guess));
                plan.items.push(ImportItem {
                    key: if main { main_key.clone() } else { format!("archive:{rel}#{}", r.path) },
                    source: ImportSource::Archive {
                        archive: rel.clone(),
                        root: r.path.clone(),
                        folders: r.folders.clone(),
                        main,
                        nested: r.nested,
                    },
                    guess,
                    // a split is named after the skin it came from: "Bennett Beach Day" for Bennett's sword
                    skin_name: if main {
                        summary.suggested_name.clone()
                    } else {
                        format!("{main_entity} {}", summary.suggested_name).trim().to_string()
                    },
                    author: None,
                    nsfw,
                    hotkeys: r.hotkeys,
                    images: if main { summary.images.len() } else { 0 },
                    parent: (!main).then(|| main_key.clone()),
                    own,
                });
            }
        }
        progress(library.len(), library.len(), "Done");
        self.pending_import = Some(PlanState { plan: plan.clone(), scan, installed });
        Ok(plan)
    }

    /// Carry out a reviewed plan (SPEC §5 steps 4-5). Installed mods are adopted in place; each confirmed archive is
    /// extracted inactive like "Extract & add"; a failed archive becomes a warning and the rest carry on.
    pub fn apply_import(
        &mut self,
        req: ImportRequest,
        progress: &mut dyn FnMut(usize, usize, &str),
    ) -> AppResult<ImportResult> {
        let state = self
            .pending_import
            .take()
            .ok_or_else(|| AppError::new("no_review", "The review is out of date. Re-scan and review again."))?;
        let (mods, _stash) = self.roots()?;
        let lib = self.library_dir().ok_or_else(|| AppError::new("no_library", "Choose a Library folder first."))?;
        self.recover_pending()?;
        let choice = |key: &str| req.choices.iter().find(|c| c.key == key);
        let mut warnings = vec![];
        let mut added = 0;
        let mut skin_of_key: HashMap<String, String> = HashMap::new();

        // 1. installed mods: library entries only, nothing moves
        let before = self.library.clone();
        let result = (|| -> AppResult<()> {
            for item in &state.plan.items {
                let ImportSource::Installed { folders } = &item.source else { continue };
                let Some(ch) = choice(&item.key).filter(|c| c.include) else { continue };
                let Some(c) = state.installed.get(&item.key) else { continue };
                if folders.iter().any(|f| state::resolve_ci(&mods, f).is_none() || self.library.owner_of(f).is_some()) {
                    warnings.push(format!("{} changed since the review, so it was left out.", item.skin_name));
                    continue;
                }
                let entity_id = self.resolve_target(&ch.target)?;
                let name = ch.target.skin_name.trim();
                let name = if name.is_empty() { item.skin_name.as_str() } else { name };
                let id = self.library.unique_skin_id(&entity_id, name);
                self.library.add_skin(Skin {
                    id: id.clone(),
                    entity_id,
                    name: name.to_string(),
                    author: item.author.clone(),
                    folders: c.folders.clone(),
                    nsfw: ch.nsfw,
                    hotkeys: state.scan.hotkeys_of(c),
                    hashes: c.hashes.iter().cloned().collect(),
                    added_at: import::now_iso(),
                    ..Skin::default()
                });
                skin_of_key.insert(item.key.clone(), id);
                added += 1;
            }
            self.save_library()
        })();
        if let Err(e) = result {
            self.library = before;
            return Err(e);
        }

        // 2. archives, one "Extract & add" each
        let mut by_archive: BTreeMap<&str, Vec<&ImportItem>> = BTreeMap::new();
        for item in &state.plan.items {
            if let ImportSource::Archive { archive, .. } = &item.source {
                by_archive.entry(archive.as_str()).or_default().push(item);
            }
        }
        let total = by_archive.len();
        let mut imported_archives: Vec<(String, Vec<String>)> = vec![];
        let mut fixed = FixReport::default();
        for (n, (rel, items)) in by_archive.iter().enumerate() {
            let Some(main) = items.iter().find(|i| matches!(i.source, ImportSource::Archive { main: true, .. })) else {
                continue;
            };
            let Some(mch) = choice(&main.key).filter(|c| c.include) else { continue };
            let Some(abs) = paths::join_rel(&mods, rel).filter(|p| p.is_file()) else {
                warnings.push(format!("{rel} is gone since the review."));
                continue;
            };
            let mut add = AddRequest {
                archive_path: abs.to_string_lossy().into_owned(),
                main: mch.target.clone(),
                splits: vec![],
                exclude: vec![],
                nsfw: mch.nsfw,
                game_banana_url: None,
                author: None,
                preview_source: if main.images > 0 { "archive".into() } else { "later".into() },
                user_image_path: None,
                make_active: false,
            };
            for item in items.iter().filter(|i| i.key != main.key) {
                let ImportSource::Archive { root, folders, .. } = &item.source else { continue };
                match choice(&item.key) {
                    Some(c) if c.include && c.own => add.splits.push(AddSplit {
                        root_path: root.clone(),
                        folders: if folders.len() > 1 { folders.clone() } else { vec![] },
                        target: c.target.clone(),
                    }),
                    Some(c) if c.include => {} // stays part of the main skin
                    _ => add.exclude.extend(folders.iter().cloned()),
                }
            }
            let label = format!("Adding {} of {total}", n + 1);
            match self.add_skin(add, &mut |d, t, _| progress(d as usize, t as usize, &label)) {
                Ok(r) => {
                    added += r.skin_ids.len();
                    warnings.extend(r.warnings);
                    fixed.merge(r.fixed);
                    if let Some(id) = r.skin_ids.last() {
                        skin_of_key.insert(main.key.clone(), id.clone());
                    }
                    imported_archives.push((rel.to_string(), r.skin_ids));
                }
                Err(e) => warnings.push(format!("{rel}: {}", e.message)),
            }
        }

        // one line for all archives, not one per archive
        warnings.extend(fixed.summary());

        // 3. archives out of Mods, so Mods holds only mods and each skin can be re-extracted from the Library
        let mut moved: Vec<MovedArchive> = vec![];
        if req.move_archives {
            for (rel, ids) in &imported_archives {
                let entity = ids.last().and_then(|id| self.library.skin(id)).map(|s| s.entity_id.clone());
                let entity_name = entity.as_ref().and_then(|e| self.library.entity(e)).map(|e| e.name.clone());
                let Some((src, dest_rel)) = move_archive(&mods, &lib, rel, entity_name.as_deref(), &mut warnings)
                else {
                    continue;
                };
                let mut before = vec![];
                for id in ids {
                    if let Some(s) = self.library.skin_mut(id) {
                        before.push((id.clone(), s.source_archive.replace(dest_rel.clone())));
                    }
                }
                moved.push((src, dest_rel, before));
            }
        }
        if let Err(e) = self.save_library() {
            // each add saved its skins already; put the archives back so library.json still matches the disk
            for (src, dest_rel, before) in moved.into_iter().rev() {
                let back = src
                    .parent()
                    .map_or(Ok(()), fs::create_dir_all)
                    .and_then(|()| apply::move_path(&lib.join(&dest_rel), &src));
                if let Err(err) = back {
                    warnings.push(format!("Couldn't put {dest_rel} back in the Mods folder: {err}"));
                }
                for (id, prev) in before {
                    if let Some(s) = self.library.skin_mut(&id) {
                        s.source_archive = prev;
                    }
                }
            }
            warnings
                .push(format!("Couldn't save the library, so the archives stayed in the Mods folder: {}", e.message));
        } else if req.move_stray {
            for rel in &state.plan.stray {
                move_archive(&mods, &lib, rel, None, &mut warnings);
            }
        }

        // 4. which skin stays on where an entity has several enabled
        let mut picks: BTreeMap<String, Option<String>> = BTreeMap::new();
        for k in &req.keep_active {
            let id = skin_of_key.get(k).cloned().or_else(|| self.library.skin(k).map(|s| s.id.clone()));
            if let Some(skin) = id.as_ref().and_then(|id| self.library.skin(id)) {
                picks.insert(skin.entity_id.clone(), Some(skin.id.clone()));
            }
        }
        // everything is saved now, so a failed re-read must not read as a failed import (a retry would duplicate
        // skins). It also takes our own adds and moves as the state Apply checks the disk against.
        let mut snapshot = match self.rescan() {
            Ok(s) => s,
            Err(e) => {
                warnings.push(format!("Imported, but re-reading the Mods folder failed: {}", e.message));
                self.snapshot()
            }
        };
        if !picks.is_empty() {
            match self.apply(&picks, Fault::None, &mut |d, t, l| progress(d, t, l)) {
                Ok(out) if out.changed_outside => {
                    warnings.push(
                        "The Mods folder changed meanwhile, so no skin was switched off. Pick them and Apply.".into(),
                    );
                    snapshot = out.snapshot;
                }
                Ok(out) => {
                    warnings.extend(out.warnings);
                    snapshot = out.snapshot;
                }
                Err(e) => warnings.push(format!("Imported, but switching the extra skins off failed: {}", e.message)),
            }
        }
        Ok(ImportResult { snapshot, added, warnings })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::app::tests::{configured_core, fixture_world};
    use crate::core::model::Category;

    fn plan_for(core: &mut AppCore) -> ImportPlan {
        core.plan_import(&mut |_, _, _| {}).unwrap()
    }

    fn item<'a>(plan: &'a ImportPlan, key_part: &str) -> &'a ImportItem {
        // a part ending in "#" means the archive's whole-content root, so it has to end the key
        let hit = |k: &str| if key_part.ends_with('#') { k.ends_with(key_part) } else { k.contains(key_part) };
        plan.items.iter().find(|i| hit(&i.key)).unwrap_or_else(|| {
            let keys: Vec<&str> = plan.items.iter().map(|i| i.key.as_str()).collect();
            panic!("no item {key_part} in {keys:#?}")
        })
    }

    /// Accept every proposal as it is.
    fn accept_all(plan: &ImportPlan) -> Vec<ImportChoice> {
        plan.items
            .iter()
            .map(|i| ImportChoice {
                key: i.key.clone(),
                include: true,
                target: AddTarget {
                    entity_id: i.guess.entity_id.clone(),
                    new_entity: i.guess.entity_id.is_none().then(|| super::super::add::NewEntity {
                        name: i.guess.name.clone(),
                        category: i.guess.category,
                        parent_id: None,
                        parent_name: i.guess.parent_name.clone(),
                        portrait_path: None,
                    }),
                    skin_name: i.skin_name.clone(),
                },
                nsfw: i.nsfw,
                own: i.own,
            })
            .collect()
    }

    #[test]
    fn the_plan_groups_installed_mods_and_the_archive_library_without_writing_to_mods() {
        let cfg = tempfile::tempdir().unwrap();
        let (_t, mods, lib) = fixture_world();
        let mut core = configured_core(cfg.path(), &mods, &lib);
        core.library = Default::default();
        let before = crate::core::apply::tests::tree(&mods);
        let plan = plan_for(&mut core);
        assert_eq!(crate::core::apply::tests::tree(&mods), before, "planning never writes to Mods");
        // installed: Sandrone by hash, with her weapon as a separate weapon skin, and Paimon
        let sandrone = item(&plan, "mods:sandrone_marionette_by_neyori/Face");
        assert_eq!((sandrone.guess.name.as_str(), sandrone.guess.reason), ("Sandrone", GuessReason::Hash));
        let teaspoon = item(&plan, "A Teaspoon of Transcendence");
        assert_eq!(teaspoon.guess.category, Category::Weapon);
        assert_eq!(item(&plan, "mods:paimon_cc116").guess.name, "Paimon");
        // archives: Bennett from "Benny", his sword split out; Oz under Fischl; the Tome recolor as a weapon
        let bennett = item(&plan, "bennett_beach.zip#");
        assert_eq!(bennett.guess.name, "Bennett");
        assert!(matches!(bennett.source, ImportSource::Archive { main: true, .. }));
        let sword = item(&plan, "bennett_beach.zip#TravelerHandySword");
        assert_eq!(
            (sword.guess.name.as_str(), sword.guess.category, sword.own),
            ("Skyward Blade", Category::Weapon, true)
        );
        assert_eq!(sword.skin_name, "Bennett Beach Day");
        let oz = item(&plan, "fischl_hexenzirkel.zip#OzMod");
        assert_eq!(
            (oz.guess.name.as_str(), oz.guess.category, oz.guess.parent_name.as_deref()),
            ("Oz", Category::Extra, Some("Fischl"))
        );
        let neuv = item(&plan, "neuvillette_wedding.zip#NeuvilletteWedding");
        assert!(matches!(neuv.source, ImportSource::Archive { main: true, .. }), "the folder hint picks Neuvillette");
        assert_eq!(neuv.guess.name, "Neuvillette");
        let tome = item(&plan, "TomeOfTheEternalFlowGoldRecolor");
        assert_eq!((tome.guess.category, tome.own), (Category::Weapon, true));
        // NSFW from the archive library's nsfw folder; stray zips offered separately
        assert!(item(&plan, "varesa_root_files.7z").nsfw);
        assert!(!bennett.nsfw);
        assert_eq!(plan.stray.len(), 2);
        assert!(plan.archives.iter().all(|a| a.error.is_none()), "{:?}", plan.archives);
    }

    #[test]
    fn keeping_one_skin_active_works_when_only_installed_mods_are_imported() {
        let cfg = tempfile::tempdir().unwrap();
        let (_t, mods, lib) = fixture_world();
        let mut core = configured_core(cfg.path(), &mods, &lib);
        core.library = Default::default();
        core.rescan().unwrap(); // what boot shows the review: an empty library
        let plan = plan_for(&mut core);
        let mut choices = accept_all(&plan);
        choices.iter_mut().filter(|c| !c.key.starts_with("mods:")).for_each(|c| c.include = false);
        let keep = item(&plan, "mods:Furina/Remembrance").key.clone();
        let req = ImportRequest { choices, move_archives: true, move_stray: false, keep_active: vec![keep] };
        let out = core.apply_import(req, &mut |_, _, _| {}).unwrap();
        assert!(!out.warnings.iter().any(|w| w.contains("changed meanwhile")), "{:?}", out.warnings);
        assert!(mods.join("Furina/Remembrance").is_dir());
        assert!(!mods.join("Furina/Casual").exists(), "{:?}", out.warnings);
        assert!(lib.join("stash/Furina/Casual").is_dir());
    }

    #[test]
    fn archives_already_imported_are_not_offered_again() {
        let cfg = tempfile::tempdir().unwrap();
        let (_t, mods, lib) = fixture_world();
        let mut core = configured_core(cfg.path(), &mods, &lib);
        core.library = Default::default();
        let plan = plan_for(&mut core);
        let req =
            ImportRequest { choices: accept_all(&plan), move_archives: false, move_stray: false, keep_active: vec![] };
        core.apply_import(req, &mut |_, _, _| {}).unwrap();
        assert!(mods.join("Charecters and wepon/Benny/bennett_beach.zip").is_file(), "left in Mods");
        let again = plan_for(&mut core);
        assert!(!again.items.iter().any(|i| i.key.contains("bennett_beach.zip")), "no duplicate skins");
        let listed = again.archives.iter().find(|a| a.path.ends_with("bennett_beach.zip")).unwrap();
        assert!(listed.error.as_deref().is_some_and(|e| e.contains("already")), "{listed:?}");
    }

    #[test]
    fn applying_adopts_in_place_extracts_archives_inactive_and_moves_them_out_of_mods() {
        let cfg = tempfile::tempdir().unwrap();
        let (_t, mods, lib) = fixture_world();
        let mut core = configured_core(cfg.path(), &mods, &lib);
        core.library = Default::default();
        let plan = plan_for(&mut core);
        let mut choices = accept_all(&plan);
        // leave Mona's archive out entirely
        choices.iter_mut().filter(|c| c.key.contains("mona_starry_skin.zip")).for_each(|c| c.include = false);
        let req = ImportRequest { choices, move_archives: true, move_stray: true, keep_active: vec![] };
        let out = core.apply_import(req, &mut |_, _, _| {}).unwrap();
        let snap = &out.snapshot;
        // installed mods stay where they are and are active
        let sandrone = snap.library.skins.iter().find(|s| s.folders.iter().any(|f| f.starts_with("sandrone"))).unwrap();
        assert!(snap.disk.skins[&sandrone.id].active);
        assert!(mods.join("sandrone_marionette_by_neyori/outfit").is_dir());
        // archive skins land inactive in the stash, with the nested weapon and Oz split out
        assert!(lib.join("stash/Bennett/Beach Day/BennettAdventure.ini").is_file(), "{:?}", out.warnings);
        assert!(lib.join("stash/Skyward Blade/Bennett Beach Day/SkywardBlade.ini").is_file());
        let oz = snap.library.skins.iter().find(|s| snap.library.entity(&s.entity_id).unwrap().name == "Oz").unwrap();
        let oz_entity = snap.library.entity(&oz.entity_id).unwrap();
        assert_eq!(oz_entity.category, Category::Extra);
        assert_eq!(snap.library.entity(oz_entity.parent_id.as_ref().unwrap()).unwrap().name, "Fischl");
        // imported archives moved to the Library; the left-out one stays; stray zips moved too
        let bennett = snap.library.skins.iter().find(|s| s.name == "Beach Day").unwrap();
        assert_eq!(bennett.source_archive.as_deref(), Some("archives/Bennett/bennett_beach.zip"));
        assert!(lib.join("archives/Bennett/bennett_beach.zip").is_file());
        assert!(!lib.join("archives/Bennett/bennett_beach.zip.part").exists(), "the staged copy was renamed");
        assert!(!mods.join("Charecters and wepon/Benny").exists(), "emptied folder removed");
        assert!(mods.join("Charecters and wepon/Mona/mona_starry_skin.zip").is_file());
        assert!(mods.join("Charecters and wepon/desktop.ini").is_file(), "other files are left alone");
        assert!(lib.join("archives/paimon_cc116.zip").is_file() && !mods.join("paimon_cc116.zip").exists());
        assert!(!snap.library.skins.iter().any(|s| s.source_archive.as_deref() == Some("mona_starry_skin.zip")));
        assert!(snap.disk.unknown_roots.is_empty(), "{:?}", snap.disk.unknown_roots);
    }

    #[test]
    fn keep_active_switches_the_other_skins_of_that_entity_off() {
        let cfg = tempfile::tempdir().unwrap();
        let (_t, mods, lib) = fixture_world();
        let mut core = configured_core(cfg.path(), &mods, &lib);
        core.library = Default::default();
        let plan = plan_for(&mut core);
        let mut choices = accept_all(&plan);
        choices.iter_mut().filter(|c| c.key.starts_with("archive:")).for_each(|c| c.include = false);
        // both Furina skins are enabled in the fixtures; keep Casual
        let casual = item(&plan, "mods:Furina/Casual").key.clone();
        let req = ImportRequest { choices, move_archives: false, move_stray: false, keep_active: vec![casual] };
        let out = core.apply_import(req, &mut |_, _, _| {}).unwrap();
        let furina = out.snapshot.library.entities.iter().find(|e| e.name == "Furina").unwrap();
        let on = &out.snapshot.disk.active[&furina.id];
        assert_eq!(on.len(), 1);
        assert_eq!(out.snapshot.library.skin(&on[0]).unwrap().name, "Casual");
        assert!(lib.join("stash/Furina/Remembrance/Furina.ini").is_file());
    }

    #[test]
    fn applying_without_a_fresh_plan_is_refused() {
        let cfg = tempfile::tempdir().unwrap();
        let (_t, mods, lib) = fixture_world();
        let mut core = configured_core(cfg.path(), &mods, &lib);
        let req = ImportRequest { choices: vec![], move_archives: false, move_stray: false, keep_active: vec![] };
        assert_eq!(core.apply_import(req, &mut |_, _, _| {}).unwrap_err().code, "no_review");
    }
}
