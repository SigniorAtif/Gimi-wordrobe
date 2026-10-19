//! Apply engine (SPEC §3): turn pending picks into a batch of folder moves, journal it, run it, and roll everything
//! back on any failure. The same machinery migrates inactive skins when the disable method changes.
//!
//! - move (default): inactive skins live in `<Library>/stash/<same relative path>`.
//! - prefix: inactive skins stay in Mods as `DISABLED_<name>`.
//!
//! Every operation is recorded in `<Library>/apply-journal.json` before it runs and marked when it finishes, so an
//! interrupted Apply (crash, power loss) is rolled back on the next start.

use super::error::{AppError, AppResult};
use super::fsutil;
use super::model::{DisableMethod, Library, Skin};
use super::paths;
use super::state::{self, FolderPlace};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const JOURNAL_FILE: &str = "apply-journal.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Op {
    /// Rename (same drive) or copy + verify + delete (different drives).
    Move {
        from: PathBuf,
        to: PathBuf,
    },
    CreateDir {
        path: PathBuf,
    },
    /// Remove a folder that became empty (SPEC §3 cleanup). Rollback recreates it.
    RemoveDir {
        path: PathBuf,
    },
}

impl Op {
    fn label(&self) -> String {
        let name = |p: &Path| p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        match self {
            Op::Move { from, .. } => format!("Moving {}", name(from)),
            Op::CreateDir { path } => format!("Creating {}", name(path)),
            Op::RemoveDir { path } => format!("Tidying {}", name(path)),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Pending,
    Started,
    /// Cross-drive move: the copy is complete and verified; the source is being deleted.
    Copied,
    Done,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalEntry {
    #[serde(flatten)]
    pub op: Op,
    pub status: Status,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Journal {
    pub version: u32,
    pub started_at: String,
    pub entries: Vec<JournalEntry>,
    /// Set once the batch succeeded; recovery just deletes a committed journal instead of undoing it.
    #[serde(default)]
    pub committed: bool,
}

#[derive(Debug, Clone, Default)]
pub struct Plan {
    pub ops: Vec<Op>,
    /// Folders to check for emptiness after the moves (removed up to the Mods root).
    pub cleanup: Vec<PathBuf>,
    pub activate: Vec<String>,
    pub deactivate: Vec<String>,
}

impl Plan {
    pub fn is_empty(&self) -> bool {
        self.ops.is_empty()
    }
}

/// Test and e2e hooks: fail or "crash" before the n-th operation (0-based).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Fault {
    #[default]
    None,
    FailAt(usize),
    CrashAt(usize),
}

pub struct Roots<'a> {
    pub mods: &'a Path,
    pub stash: &'a Path,
}

fn err(code: &str, msg: impl Into<String>) -> AppError {
    AppError::new(code, msg)
}

/// Ancestors of `target` below `root` that don't exist yet, outermost first.
fn missing_parents(root: &Path, target: &Path, planned: &mut BTreeSet<String>) -> Vec<Op> {
    let mut out = vec![];
    // the stash root itself appears on first use
    if !root.exists() && planned.insert(paths::cmp_key(&root.to_string_lossy())) {
        out.push(Op::CreateDir { path: root.to_path_buf() });
    }
    let mut cur = target.parent();
    let mut chain = vec![];
    while let Some(p) = cur {
        if p == root || !p.starts_with(root) {
            break;
        }
        chain.push(p.to_path_buf());
        cur = p.parent();
    }
    for p in chain.into_iter().rev() {
        let key = paths::cmp_key(&p.to_string_lossy());
        let rel = paths::rel_from(root, &p).unwrap_or_default();
        if state::resolve_ci(root, &rel).is_none() && planned.insert(key) {
            out.push(Op::CreateDir { path: p });
        }
    }
    out
}

/// Real on-disk path for a target that must not exist yet (refuses names that differ only by case, SPEC §3).
fn free_target(root: &Path, rel: &str, planned: &BTreeSet<String>) -> AppResult<PathBuf> {
    let target = paths::join_rel(root, rel).ok_or_else(|| err("bad_path", format!("Unsafe folder path: {rel}")))?;
    if state::resolve_ci(root, rel).is_some() || planned.contains(&paths::cmp_key(&target.to_string_lossy())) {
        return Err(err(
            "target_exists",
            format!(
                "{} already exists (names are compared without case), so it can't be moved there.",
                target.display()
            ),
        ));
    }
    Ok(target)
}

struct Planner<'a> {
    roots: Roots<'a>,
    plan: Plan,
    created: BTreeSet<String>,
    targets: BTreeSet<String>,
}

impl Planner<'_> {
    fn push_move(&mut self, root: &Path, from: PathBuf, rel: &str) -> AppResult<()> {
        let to = free_target(root, rel, &self.targets)?;
        let parents = missing_parents(root, &to, &mut self.created);
        self.plan.ops.extend(parents);
        self.targets.insert(paths::cmp_key(&to.to_string_lossy()));
        self.plan.ops.push(Op::Move { from, to });
        Ok(())
    }

    fn activate(&mut self, skin: &Skin) -> AppResult<()> {
        let mut any = false;
        for f in &skin.folders {
            match state::place_of(self.roots.mods, Some(self.roots.stash), f) {
                FolderPlace::Mods => {}
                FolderPlace::Disabled => {
                    let (from, _) = state::find_disabled(self.roots.mods, f).expect("checked by place_of");
                    let mods = self.roots.mods.to_path_buf();
                    self.push_move(&mods, from, f)?;
                    any = true;
                }
                FolderPlace::Stash => {
                    let from = state::resolve_ci(self.roots.stash, f).expect("checked by place_of");
                    let mods = self.roots.mods.to_path_buf();
                    self.push_move(&mods, from, f)?;
                    any = true;
                }
                FolderPlace::Missing => {
                    return Err(err(
                        "missing_folder",
                        format!(
                            "Can't find \"{f}\" ({}) in Mods or in the Library stash. Re-scan, or remove the skin.",
                            skin.name
                        ),
                    ));
                }
            }
        }
        if any {
            self.plan.activate.push(skin.id.clone());
        }
        Ok(())
    }

    fn deactivate(&mut self, skin: &Skin, method: DisableMethod) -> AppResult<()> {
        let mut any = false;
        for f in &skin.folders {
            let Some(src) = state::resolve_ci(self.roots.mods, f) else { continue };
            match method {
                DisableMethod::Move => {
                    let stash = self.roots.stash.to_path_buf();
                    self.push_move(&stash, src.clone(), f)?;
                    if let Some(parent) = src.parent() {
                        self.plan.cleanup.push(parent.to_path_buf());
                    }
                }
                DisableMethod::Prefix => {
                    let name = src.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                    let rel_parent = f.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
                    let rel = if rel_parent.is_empty() {
                        format!("DISABLED_{name}")
                    } else {
                        format!("{rel_parent}/DISABLED_{name}")
                    };
                    let mods = self.roots.mods.to_path_buf();
                    self.push_move(&mods, src, &rel)?;
                }
            }
            any = true;
        }
        if any {
            self.plan.deactivate.push(skin.id.clone());
        }
        Ok(())
    }
}

/// Plan an Apply: for every picked entity, enable the chosen skin (or none for Original) and disable all others,
/// so an entity never ends with two skins enabled.
pub fn plan(
    lib: &Library,
    picks: &BTreeMap<String, Option<String>>,
    roots: Roots,
    method: DisableMethod,
) -> AppResult<Plan> {
    let mut p = Planner { roots, plan: Plan::default(), created: BTreeSet::new(), targets: BTreeSet::new() };
    for (entity_id, target) in picks {
        if lib.entity(entity_id).is_none() {
            return Err(err("unknown_entity", format!("Unknown character or item: {entity_id}")));
        }
        if let Some(t) = target {
            match lib.skin(t) {
                Some(s) if &s.entity_id == entity_id => {}
                _ => return Err(err("unknown_skin", format!("That skin no longer exists ({t})."))),
            }
        }
        let skins: Vec<&Skin> = lib.skins.iter().filter(|s| &s.entity_id == entity_id).collect();
        // disable first so the chosen skin's target paths are free
        for s in &skins {
            if Some(&s.id) != target.as_ref() {
                p.deactivate(s, method)?;
            }
        }
        for s in &skins {
            if Some(&s.id) == target.as_ref() {
                p.activate(s)?;
            }
        }
    }
    Ok(p.plan)
}

/// Plan the disable-method migration (SPEC §3): every inactive skin moves to the other representation.
pub fn plan_migration(lib: &Library, roots: Roots, to: DisableMethod) -> AppResult<Plan> {
    let mut p = Planner { roots, plan: Plan::default(), created: BTreeSet::new(), targets: BTreeSet::new() };
    for skin in &lib.skins {
        for f in &skin.folders {
            match (to, state::place_of(p.roots.mods, Some(p.roots.stash), f)) {
                (DisableMethod::Prefix, FolderPlace::Stash) => {
                    let from = state::resolve_ci(p.roots.stash, f).expect("checked");
                    let (parent, last) = f.rsplit_once('/').unwrap_or(("", f.as_str()));
                    let rel = if parent.is_empty() {
                        format!("DISABLED_{last}")
                    } else {
                        format!("{parent}/DISABLED_{last}")
                    };
                    let mods = p.roots.mods.to_path_buf();
                    p.push_move(&mods, from, &rel)?;
                }
                (DisableMethod::Move, FolderPlace::Disabled) => {
                    let (from, _) = state::find_disabled(p.roots.mods, f).expect("checked");
                    if let Some(parent) = from.parent() {
                        p.plan.cleanup.push(parent.to_path_buf());
                    }
                    let stash = p.roots.stash.to_path_buf();
                    p.push_move(&stash, from, f)?;
                }
                _ => {}
            }
        }
    }
    Ok(p.plan)
}

fn is_cross_device(e: &io::Error) -> bool {
    e.kind() == io::ErrorKind::CrossesDevices
        || matches!(e.raw_os_error(), Some(18) if cfg!(unix))
        || matches!(e.raw_os_error(), Some(17) if cfg!(windows))
}

fn is_locked(e: &io::Error) -> bool {
    e.kind() == io::ErrorKind::PermissionDenied
        || matches!(e.raw_os_error(), Some(5) | Some(32) | Some(33) if cfg!(windows))
}

fn copy_tree(from: &Path, to: &Path) -> io::Result<(u64, u64)> {
    let meta = fs::symlink_metadata(from)?;
    if meta.is_file() {
        fs::copy(from, to)?;
        return Ok((1, meta.len()));
    }
    fs::create_dir(to)?;
    let (mut files, mut bytes) = (0, 0);
    for e in fs::read_dir(from)? {
        let e = e?;
        let (f, b) = copy_tree(&e.path(), &to.join(e.file_name()))?;
        files += f;
        bytes += b;
    }
    Ok((files, bytes))
}

fn tree_size(p: &Path) -> io::Result<(u64, u64)> {
    let meta = fs::symlink_metadata(p)?;
    if meta.is_file() {
        return Ok((1, meta.len()));
    }
    let (mut files, mut bytes) = (0, 0);
    for e in fs::read_dir(p)? {
        let (f, b) = tree_size(&e?.path())?;
        files += f;
        bytes += b;
    }
    Ok((files, bytes))
}

/// Copy whatever `src` has that `dst` lacks (put a half-deleted source back together from its verified copy).
fn fill_missing(src: &Path, dst: &Path) -> io::Result<()> {
    if fs::symlink_metadata(src)?.is_file() {
        if !dst.exists() {
            fs::copy(src, dst)?;
        }
        return Ok(());
    }
    fs::create_dir_all(dst)?;
    for e in fs::read_dir(src)? {
        let e = e?;
        fill_missing(&e.path(), &dst.join(e.file_name()))?;
    }
    Ok(())
}

fn remove_any(p: &Path) -> io::Result<()> {
    if fs::symlink_metadata(p)?.is_dir() { fs::remove_dir_all(p) } else { fs::remove_file(p) }
}

/// Move a folder: rename, retrying once if locked; across drives copy, verify and delete the source.
pub fn move_path(from: &Path, to: &Path) -> io::Result<()> {
    move_path_journaled(from, to, &mut || Ok(()))
}

/// Like `move_path`, calling `on_copied` after a cross-drive copy is verified and before the source is deleted,
/// so the journal knows the copy is the complete one. If deleting the source fails, the source is restored from
/// the copy and the copy removed: the move either happened or it didn't.
pub fn move_path_journaled(from: &Path, to: &Path, on_copied: &mut dyn FnMut() -> io::Result<()>) -> io::Result<()> {
    let mut tried_again = false;
    loop {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) if is_cross_device(&e) => {
                let copied = copy_tree(from, to);
                let ok = copied.as_ref().ok().zip(tree_size(from).ok()).map(|(c, s)| *c == s).unwrap_or(false);
                if !ok {
                    let _ = fs::remove_dir_all(to);
                    return Err(copied.err().unwrap_or_else(|| io::Error::other("copy verification failed")));
                }
                if let Err(e) = on_copied() {
                    let _ = remove_any(to);
                    return Err(e);
                }
                return match remove_any(from) {
                    Ok(()) => Ok(()),
                    Err(e) => {
                        fill_missing(to, from)?;
                        remove_any(to)?;
                        Err(e)
                    }
                };
            }
            Err(e) if is_locked(&e) && !tried_again => {
                tried_again = true;
                std::thread::sleep(Duration::from_millis(600));
            }
            Err(e) => return Err(e),
        }
    }
}

fn describe(op: &Op, e: &io::Error) -> String {
    match op {
        Op::Move { from, .. } if is_locked(e) => {
            format!("Couldn't move {}: it's in use. Close the game or any Explorer window showing it.", from.display())
        }
        Op::Move { from, to } => format!("Couldn't move {} to {}: {e}", from.display(), to.display()),
        Op::CreateDir { path } => format!("Couldn't create {}: {e}", path.display()),
        Op::RemoveDir { path } => format!("Couldn't remove {}: {e}", path.display()),
    }
}

fn run_op(op: &Op) -> io::Result<()> {
    match op {
        Op::Move { from, to } => move_path(from, to),
        Op::CreateDir { path } => fs::create_dir(path),
        Op::RemoveDir { path } => fs::remove_dir(path),
    }
}

fn undo_op(op: &Op, status: Status) -> io::Result<()> {
    match op {
        Op::Move { from, to } => {
            let src_there = from.exists();
            let dst_there = to.exists();
            match (status, src_there, dst_there) {
                // finished (or finished just before a crash): move it back
                (_, false, true) => {
                    if let Some(p) = from.parent() {
                        fs::create_dir_all(p)?;
                    }
                    move_path(to, from)
                }
                // a cross-drive copy was interrupted: drop the partial copy, the source is intact
                (Status::Started, true, true) => remove_any(to),
                // interrupted while deleting the source after a verified copy: rebuild the source, drop the copy
                (Status::Copied, true, true) => {
                    fill_missing(to, from)?;
                    remove_any(to)
                }
                _ => Ok(()),
            }
        }
        Op::CreateDir { path } => match fs::remove_dir(path) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            other => other,
        },
        Op::RemoveDir { path } => fs::create_dir_all(path),
    }
}

pub struct Journaled<'a> {
    pub path: Option<&'a Path>,
    pub journal: Journal,
}

impl Journaled<'_> {
    fn save(&self) -> io::Result<()> {
        match self.path {
            Some(p) => fsutil::write_json_atomic(p, &self.journal, false),
            None => Ok(()),
        }
    }
}

#[derive(Debug)]
pub enum ExecError {
    /// Failed and rolled back; the disk is as it was.
    RolledBack(AppError),
    /// Failed and the rollback itself failed; the journal is kept for the next start.
    RollbackFailed(AppError),
    /// Simulated crash (tests / e2e): stopped mid-batch, journal left behind.
    Crashed,
}

impl From<ExecError> for AppError {
    fn from(e: ExecError) -> Self {
        match e {
            ExecError::RolledBack(e) => AppError::new(e.code, format!("{} Nothing was changed.", e.message)),
            ExecError::RollbackFailed(e) => AppError::new(
                "rollback_failed",
                format!("{} Undoing the batch also failed; Skin Switcher will retry on next start.", e.message),
            ),
            ExecError::Crashed => AppError::new("crashed", "Apply was interrupted."),
        }
    }
}

/// Undo every started or finished entry, newest first. Returns how many were undone.
pub fn rollback(j: &mut Journaled) -> Result<usize, AppError> {
    let mut undone = 0;
    let mut failures = vec![];
    for i in (0..j.journal.entries.len()).rev() {
        let entry = j.journal.entries[i].clone();
        if entry.status == Status::Pending {
            continue;
        }
        match undo_op(&entry.op, entry.status) {
            Ok(()) => {
                undone += 1;
                j.journal.entries[i].status = Status::Pending;
                let _ = j.save();
            }
            Err(e) => failures.push(describe(&entry.op, &e)),
        }
    }
    if failures.is_empty() {
        if let Some(p) = j.path {
            let _ = fs::remove_file(p);
        }
        Ok(undone)
    } else {
        Err(AppError::new("rollback_failed", failures.join(" ")))
    }
}

/// Run a plan. `progress(done, total, label)` is called before each operation.
pub fn execute(
    plan: &Plan,
    mods: &Path,
    journal_path: Option<&Path>,
    fault: Fault,
    progress: &mut dyn FnMut(usize, usize, &str),
) -> Result<usize, ExecError> {
    execute_verified(plan, mods, journal_path, fault, progress, &|| Ok(()))
}

/// Run a plan, then `verify` the result before dropping the journal; a failed check rolls everything back.
pub fn execute_verified(
    plan: &Plan,
    mods: &Path,
    journal_path: Option<&Path>,
    fault: Fault,
    progress: &mut dyn FnMut(usize, usize, &str),
    verify: &dyn Fn() -> Result<(), AppError>,
) -> Result<usize, ExecError> {
    // never overwrite the undo record of an earlier batch
    if journal_path.is_some_and(Path::exists) {
        return Err(ExecError::RolledBack(AppError::new(
            "journal_exists",
            "An earlier Apply wasn't finished. Restart Skin Switcher so it can undo it first.",
        )));
    }
    let mut j = Journaled {
        path: journal_path,
        journal: Journal {
            version: 1,
            started_at: super::import::now_iso(),
            entries: plan.ops.iter().map(|op| JournalEntry { op: op.clone(), status: Status::Pending }).collect(),
            committed: false,
        },
    };
    let fail = |j: &mut Journaled, e: AppError| -> ExecError {
        match rollback(j) {
            Ok(_) => ExecError::RolledBack(e),
            Err(r) => ExecError::RollbackFailed(AppError::new(e.code, format!("{} {}", e.message, r.message))),
        }
    };
    if let Err(e) = j.save() {
        return Err(ExecError::RolledBack(AppError::new("journal", format!("Couldn't write the Apply journal: {e}"))));
    }
    let total = plan.ops.len();
    for i in 0..total {
        match fault {
            Fault::FailAt(n) if n == i => return Err(fail(&mut j, err("simulated", "Simulated failure."))),
            Fault::CrashAt(n) if n == i => return Err(ExecError::Crashed),
            _ => {}
        }
        let op = plan.ops[i].clone();
        progress(i, total, &op.label());
        j.journal.entries[i].status = Status::Started;
        if let Err(e) = j.save() {
            return Err(fail(&mut j, err("journal", format!("Couldn't update the Apply journal: {e}"))));
        }
        let result = match &op {
            Op::Move { from, to } => {
                let journal = &mut j;
                move_path_journaled(from, to, &mut || {
                    journal.journal.entries[i].status = Status::Copied;
                    journal.save()
                })
            }
            other => run_op(other),
        };
        if let Err(e) = result {
            j.journal.entries[i].status = Status::Pending;
            return Err(fail(&mut j, err("move_failed", describe(&op, &e))));
        }
        j.journal.entries[i].status = Status::Done;
        if let Err(e) = j.save() {
            return Err(fail(&mut j, err("journal", format!("Couldn't update the Apply journal: {e}"))));
        }
    }
    // remove folders under Mods that the moves left completely empty, recording each for rollback
    let mut seen = BTreeSet::new();
    for start in &plan.cleanup {
        let mut cur = Some(start.as_path());
        while let Some(dir) = cur {
            if dir == mods || !dir.starts_with(mods) || !seen.insert(dir.to_path_buf()) {
                break;
            }
            let empty = fs::read_dir(dir).map(|mut r| r.next().is_none()).unwrap_or(false);
            if !empty {
                break;
            }
            let op = Op::RemoveDir { path: dir.to_path_buf() };
            j.journal.entries.push(JournalEntry { op: op.clone(), status: Status::Started });
            let _ = j.save();
            if let Err(e) = run_op(&op) {
                return Err(fail(&mut j, err("cleanup_failed", describe(&op, &e))));
            }
            if let Some(last) = j.journal.entries.last_mut() {
                last.status = Status::Done;
            }
            let _ = j.save();
            cur = dir.parent();
        }
    }
    if let Err(e) = verify() {
        return Err(fail(&mut j, e));
    }
    progress(total, total, "Done");
    // mark it committed first: if deleting the file fails, the next start won't undo a successful Apply
    j.journal.committed = true;
    let _ = j.save();
    if let Some(p) = journal_path {
        let _ = fs::remove_file(p);
    }
    Ok(total)
}

/// Roll back an interrupted Apply found at startup. Returns Some(undone) when a journal existed.
pub fn recover(journal_path: &Path) -> AppResult<Option<usize>> {
    let Some(journal) = fsutil::read_json_or_bak::<Journal>(journal_path)? else { return Ok(None) };
    if journal.committed {
        let _ = fs::remove_file(journal_path);
        return Ok(None);
    }
    let mut j = Journaled { path: Some(journal_path), journal };
    rollback(&mut j).map(Some)
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::core::app::tests::{configured_core, fixture_world};
    use crate::core::model::SkinLocation;

    /// Every file under a folder with its size, for before/after comparisons.
    pub fn tree(root: &Path) -> Vec<(String, u64)> {
        fn walk(base: &Path, p: &Path, out: &mut Vec<(String, u64)>) {
            let Ok(rd) = fs::read_dir(p) else { return };
            for e in rd.flatten() {
                let path = e.path();
                let rel = paths::rel_from(base, &path).unwrap_or_default();
                if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    out.push((format!("{rel}/"), 0));
                    walk(base, &path, out);
                } else {
                    out.push((rel, e.metadata().map(|m| m.len()).unwrap_or(0)));
                }
            }
        }
        let mut out = vec![];
        walk(root, root, &mut out);
        out.sort();
        out
    }

    fn picks(v: &[(&str, Option<&str>)]) -> BTreeMap<String, Option<String>> {
        v.iter().map(|(e, s)| (e.to_string(), s.map(str::to_string))).collect()
    }

    fn noop(_: usize, _: usize, _: &str) {}

    #[test]
    fn move_mode_keeps_exactly_one_skin_and_identical_relative_paths() {
        let cfg = tempfile::tempdir().unwrap();
        let (_t, mods, lib) = fixture_world();
        let core = configured_core(cfg.path(), &mods, &lib);
        let library = core.library().clone();
        let stash = lib.join("stash");
        let roots = || Roots { mods: &mods, stash: &stash };

        // Furina starts with two skins enabled; pick Casual
        let p = plan(&library, &picks(&[("furina", Some("furina--casual"))]), roots(), DisableMethod::Move).unwrap();
        execute(&p, &mods, Some(&lib.join(JOURNAL_FILE)), Fault::None, &mut noop).unwrap();
        assert!(mods.join("Furina/Casual").is_dir());
        assert!(!mods.join("Furina/Remembrance").exists());
        assert!(stash.join("Furina/Remembrance/Furina.ini").is_file(), "same relative path in the stash");
        assert!(!lib.join(JOURNAL_FILE).exists());

        // back to Remembrance: same relative path in Mods as before
        let p =
            plan(&library, &picks(&[("furina", Some("furina--remembrance"))]), roots(), DisableMethod::Move).unwrap();
        execute(&p, &mods, None, Fault::None, &mut noop).unwrap();
        assert!(mods.join("Furina/Remembrance/Furina.ini").is_file());
        assert!(stash.join("Furina/Casual").is_dir());

        // Original: no Furina skin left, and the empty Mods/Furina is removed... except DISABLED_Old lives there
        let p = plan(&library, &picks(&[("furina", None)]), roots(), DisableMethod::Move).unwrap();
        execute(&p, &mods, None, Fault::None, &mut noop).unwrap();
        assert!(!mods.join("Furina/Remembrance").exists());
        assert!(mods.join("Furina/DISABLED_Old").is_dir());

        // a container that becomes completely empty is removed, and recreated on activation
        let p = plan(&library, &picks(&[("odette", None)]), roots(), DisableMethod::Move).unwrap();
        execute(&p, &mods, None, Fault::None, &mut noop).unwrap();
        assert!(!mods.join("Odette").exists());
        let odette = library.skins.iter().find(|s| s.entity_id == "odette").unwrap().id.clone();
        let p = plan(&library, &picks(&[("odette", Some(&odette))]), roots(), DisableMethod::Move).unwrap();
        execute(&p, &mods, None, Fault::None, &mut noop).unwrap();
        assert!(mods.join("Odette/Black Swan/Odette.ini").is_file());
    }

    #[test]
    fn multi_folder_skin_moves_every_folder() {
        let cfg = tempfile::tempdir().unwrap();
        let (_t, mods, lib) = fixture_world();
        let core = configured_core(cfg.path(), &mods, &lib);
        let library = core.library().clone();
        let stash = lib.join("stash");
        let p =
            plan(&library, &picks(&[("sandrone", None)]), Roots { mods: &mods, stash: &stash }, DisableMethod::Move)
                .unwrap();
        execute(&p, &mods, None, Fault::None, &mut noop).unwrap();
        assert!(stash.join("sandrone_marionette_by_neyori/Face/Face Texture/Sandrone.ini").is_file());
        assert!(stash.join("sandrone_marionette_by_neyori/outfit/Sandrone.ini").is_file());
        // the weapon sibling stays, so the parent folder is not removed
        assert!(mods.join("sandrone_marionette_by_neyori/A Teaspoon of Transcendence").is_dir());
    }

    #[test]
    fn forced_failure_mid_batch_rolls_everything_back() {
        let cfg = tempfile::tempdir().unwrap();
        let (_t, mods, lib) = fixture_world();
        let core = configured_core(cfg.path(), &mods, &lib);
        let library = core.library().clone();
        let stash = lib.join("stash");
        let before_mods = tree(&mods);
        let before_stash = tree(&stash);
        let p = plan(
            &library,
            &picks(&[("furina", Some("furina--casual")), ("sandrone", None), ("odette", None)]),
            Roots { mods: &mods, stash: &stash },
            DisableMethod::Move,
        )
        .unwrap();
        assert!(p.ops.len() >= 4, "{:?}", p.ops);
        for at in 1..p.ops.len() {
            let r = execute(&p, &mods, Some(&lib.join(JOURNAL_FILE)), Fault::FailAt(at), &mut noop);
            assert!(matches!(r, Err(ExecError::RolledBack(_))), "fail at {at}");
            assert_eq!(tree(&mods), before_mods, "Mods restored after failing at op {at}");
            assert_eq!(tree(&stash), before_stash, "stash restored after failing at op {at}");
            assert!(!lib.join(JOURNAL_FILE).exists());
        }
    }

    #[test]
    fn interrupted_apply_is_rolled_back_from_the_journal() {
        let cfg = tempfile::tempdir().unwrap();
        let (_t, mods, lib) = fixture_world();
        let core = configured_core(cfg.path(), &mods, &lib);
        let library = core.library().clone();
        let stash = lib.join("stash");
        let before = tree(&mods);
        let journal = lib.join(JOURNAL_FILE);
        let p = plan(
            &library,
            &picks(&[("sandrone", None), ("paimon", None)]),
            Roots { mods: &mods, stash: &stash },
            DisableMethod::Move,
        )
        .unwrap();
        let r = execute(&p, &mods, Some(&journal), Fault::CrashAt(p.ops.len() - 1), &mut noop);
        assert!(matches!(r, Err(ExecError::Crashed)));
        assert!(journal.exists(), "journal survives the crash");
        assert_ne!(tree(&mods), before);
        let undone = recover(&journal).unwrap().unwrap();
        assert!(undone > 0);
        assert_eq!(tree(&mods), before);
        assert!(!journal.exists());
        assert_eq!(recover(&journal).unwrap(), None);
    }

    #[test]
    fn a_committed_journal_is_not_undone_and_a_stale_one_is_never_overwritten() {
        let t = tempfile::tempdir().unwrap();
        let journal = t.path().join(JOURNAL_FILE);
        let a = t.path().join("a");
        fs::create_dir_all(&a).unwrap();
        let plan = Plan { ops: vec![Op::Move { from: a.clone(), to: t.path().join("b") }], ..Plan::default() };
        // a stale journal blocks a new batch
        fs::write(&journal, br#"{"version":1,"startedAt":"x","entries":[]}"#).unwrap();
        assert!(matches!(
            execute(&plan, t.path(), Some(&journal), Fault::None, &mut noop),
            Err(ExecError::RolledBack(_))
        ));
        assert!(a.exists());
        fs::remove_file(&journal).unwrap();
        // committed journals are just deleted on recovery
        fs::write(&journal, br#"{"version":1,"startedAt":"x","committed":true,"entries":[{"op":"move","from":"/nope","to":"/nope2","status":"done"}]}"#).unwrap();
        assert_eq!(recover(&journal).unwrap(), None);
        assert!(!journal.exists());
    }

    #[test]
    fn interrupted_source_delete_after_a_verified_copy_restores_the_source() {
        let t = tempfile::tempdir().unwrap();
        let from = t.path().join("Mods/Skin");
        let to = t.path().join("stash/Skin");
        fs::create_dir_all(from.join("sub")).unwrap();
        fs::create_dir_all(&to).unwrap();
        fs::write(from.join("a.ini"), "a").unwrap();
        // the copy finished (to is complete) and deletion removed some of the source before a crash
        copy_dir_all(&from, &to);
        fs::remove_file(from.join("a.ini")).unwrap();
        undo_op(&Op::Move { from: from.clone(), to: to.clone() }, Status::Copied).unwrap();
        assert!(from.join("a.ini").is_file(), "source rebuilt from the verified copy");
        assert!(!to.exists());
    }

    fn copy_dir_all(from: &Path, to: &Path) {
        fs::create_dir_all(to).unwrap();
        for e in fs::read_dir(from).unwrap().flatten() {
            if e.file_type().unwrap().is_dir() {
                copy_dir_all(&e.path(), &to.join(e.file_name()));
            } else {
                fs::copy(e.path(), to.join(e.file_name())).unwrap();
            }
        }
    }

    #[test]
    fn prefix_mode_renames_in_place() {
        let cfg = tempfile::tempdir().unwrap();
        let (_t, mods, lib) = fixture_world();
        let core = configured_core(cfg.path(), &mods, &lib);
        let library = core.library().clone();
        let stash = lib.join("stash");
        let roots = || Roots { mods: &mods, stash: &stash };
        let p =
            plan(&library, &picks(&[("furina", Some("furina--remembrance"))]), roots(), DisableMethod::Prefix).unwrap();
        execute(&p, &mods, None, Fault::None, &mut noop).unwrap();
        assert!(mods.join("Furina/DISABLED_Casual").is_dir());
        let p = plan(&library, &picks(&[("furina", Some("furina--casual"))]), roots(), DisableMethod::Prefix).unwrap();
        execute(&p, &mods, None, Fault::None, &mut noop).unwrap();
        assert!(mods.join("Furina/Casual").is_dir());
        assert!(mods.join("Furina/DISABLED_Remembrance").is_dir());
        let s = library.skin("furina--remembrance").unwrap();
        assert_eq!(state::locate(s, &mods, Some(&stash)).location, SkinLocation::Disabled);
    }

    #[test]
    fn method_migration_round_trips_and_rolls_back() {
        let cfg = tempfile::tempdir().unwrap();
        let (_t, mods, lib) = fixture_world();
        let core = configured_core(cfg.path(), &mods, &lib);
        let library = core.library().clone();
        let stash = lib.join("stash");
        let roots = || Roots { mods: &mods, stash: &stash };
        let p = plan(
            &library,
            &picks(&[("furina", Some("furina--remembrance")), ("sandrone", None)]),
            roots(),
            DisableMethod::Move,
        )
        .unwrap();
        execute(&p, &mods, None, Fault::None, &mut noop).unwrap();
        let moved = tree(&mods);

        // move -> prefix: stashed skins come back as DISABLED_ in Mods
        let m = plan_migration(&library, roots(), DisableMethod::Prefix).unwrap();
        let before = (tree(&mods), tree(&stash));
        let r = execute(&m, &mods, None, Fault::FailAt(m.ops.len() - 1), &mut noop);
        assert!(matches!(r, Err(ExecError::RolledBack(_))));
        assert_eq!((tree(&mods), tree(&stash)), before);
        execute(&m, &mods, None, Fault::None, &mut noop).unwrap();
        assert!(mods.join("Furina/DISABLED_Casual").is_dir());
        assert!(mods.join("sandrone_marionette_by_neyori/DISABLED_outfit").is_dir());
        assert!(mods.join("sandrone_marionette_by_neyori/DISABLED_Face").is_dir());

        // prefix -> move: back to the stash, Mods as it was after the first Apply
        let back = plan_migration(&library, roots(), DisableMethod::Move).unwrap();
        execute(&back, &mods, None, Fault::None, &mut noop).unwrap();
        assert_eq!(tree(&mods), moved);
    }

    #[test]
    fn refuses_targets_that_differ_only_by_case() {
        let cfg = tempfile::tempdir().unwrap();
        let (_t, mods, lib) = fixture_world();
        let core = configured_core(cfg.path(), &mods, &lib);
        let library = core.library().clone();
        let stash = lib.join("stash");
        fs::create_dir_all(stash.join("FURINA/REMEMBRANCE")).unwrap();
        let e = plan(
            &library,
            &picks(&[("furina", Some("furina--casual"))]),
            Roots { mods: &mods, stash: &stash },
            DisableMethod::Move,
        )
        .unwrap_err();
        assert_eq!(e.code, "target_exists");
    }

    #[test]
    fn missing_folders_and_unknown_skins_are_refused_before_anything_moves() {
        let cfg = tempfile::tempdir().unwrap();
        let (_t, mods, lib) = fixture_world();
        let core = configured_core(cfg.path(), &mods, &lib);
        let library = core.library().clone();
        let stash = lib.join("stash");
        let e = plan(
            &library,
            &picks(&[("furina", Some("nope"))]),
            Roots { mods: &mods, stash: &stash },
            DisableMethod::Move,
        )
        .unwrap_err();
        assert_eq!(e.code, "unknown_skin");
        fs::remove_dir_all(mods.join("Odette")).unwrap();
        let odette = library.skins.iter().find(|s| s.entity_id == "odette").unwrap().id.clone();
        let e = plan(
            &library,
            &picks(&[("odette", Some(&odette))]),
            Roots { mods: &mods, stash: &stash },
            DisableMethod::Move,
        )
        .unwrap_err();
        assert_eq!(e.code, "missing_folder");
    }
}
