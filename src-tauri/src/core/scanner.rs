//! Mods folder scanner (SPEC §4, §5): loadable inis, libraries, mod roots, grouping into skins and entity guesses.
//!
//! Grouping, bottom-up over the folder tree:
//! - A folder holding a loadable ini is a mod root; everything below it belongs to it (nested foreign roots, like
//!   Bennett's sword, are remembered so the archive importer can split them out).
//! - Otherwise a folder collapses its children into one root when they are compatible: same entity (or unknown) and
//!   mostly different hashes. Collapsing stops at the Mods root and at entity containers (`Mods/Furina/`).
//! - Roots left side by side under one parent are merged into one multi-folder skin when they are parts of the same
//!   entity (face + outfit) rather than alternatives (two bodies overriding the same hashes).

use super::hashindex::{HashIndex, IndexGroup};
use super::hotkeys;
use super::ini::Ini;
use super::model::{Category, Hotkey, Library, LibraryMod, LibraryReason};
use super::names;
use super::paths;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Default)]
pub struct IniFacts {
    /// Path relative to the scan root, `/` separated.
    pub rel: String,
    /// `[TextureOverride*]` hashes, lowercase, deduplicated.
    pub hashes: Vec<String>,
    pub namespace: Option<String>,
    pub hotkeys: Vec<Hotkey>,
    /// Files referenced via `filename =` (relative to the ini's folder, lowercase, `/`).
    pub filenames: Vec<String>,
    /// Assigns vertex/index buffers or draws: a model mod, not a texture-only recolor.
    pub geometry: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GuessReason {
    /// Folder-derived name for an entity nothing else knows (shown as "folder").
    #[serde(rename = "folder")]
    NewName,
    Folder,
    Name,
    Learned,
    Hash,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Guess {
    /// Existing library entity, when the guess resolves to one.
    pub entity_id: Option<String>,
    pub name: String,
    pub category: Category,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_name: Option<String>,
    pub confidence: f32,
    pub reason: GuessReason,
}

impl Guess {
    pub fn key(&self) -> String {
        names::compact(&self.name)
    }
}

#[derive(Debug, Clone, Default)]
pub struct NestedRoot {
    pub folder: String,
    pub inis: Vec<usize>,
    pub hashes: BTreeSet<String>,
    pub guess: Option<Guess>,
}

/// One detected skin: one or more mod-root folders (relative to the scan root).
#[derive(Debug, Clone, Default)]
pub struct Candidate {
    pub folders: Vec<String>,
    pub inis: Vec<usize>,
    pub hashes: BTreeSet<String>,
    pub guess: Option<Guess>,
    pub geometry: bool,
    /// Roots of another entity nested inside this one (they load with it until split out).
    pub nested: Vec<NestedRoot>,
}

#[derive(Debug, Clone, Default)]
pub struct ScanResult {
    pub inis: Vec<IniFacts>,
    pub candidates: Vec<Candidate>,
    pub libraries: Vec<LibraryMod>,
    pub maybe_libraries: Vec<LibraryMod>,
    /// `DISABLED*` folders and files (relative), not descended into.
    pub disabled: Vec<String>,
    /// `.zip/.rar/.7z` directly in the scan root.
    pub stray_archives: Vec<String>,
    /// Every archive anywhere below the root (the archive library lives here).
    pub archives: Vec<String>,
    pub junk: Vec<String>,
}

impl ScanResult {
    pub fn hotkeys_of(&self, c: &Candidate) -> Vec<Hotkey> {
        c.inis.iter().flat_map(|&i| self.inis[i].hotkeys.clone()).collect()
    }
}

pub struct ScanContext<'a> {
    pub index: &'a HashIndex,
    pub library: &'a Library,
    /// More entity names to match against, e.g. the archive library's character folders.
    pub extra_names: Vec<String>,
    /// Scanning an extracted archive: inis at the top mean the whole archive is one mod root (folder "").
    pub archive_root: bool,
}

impl<'a> ScanContext<'a> {
    pub fn new(index: &'a HashIndex, library: &'a Library) -> Self {
        ScanContext { index, library, extra_names: vec![], archive_root: false }
    }
}

const ARCHIVE_EXTS: [&str; 3] = ["zip", "rar", "7z"];

fn ext_of(name: &str) -> String {
    Path::new(name).extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default()
}

fn lower(s: &str) -> String {
    s.to_ascii_lowercase()
}

/// Known library names (SPEC §4 step 1): `ORFix*`, `ORFixAPI*`, `BufferValues/`, `HealthBar*`, `TexFx*`, `RabbitFX*`.
pub fn is_library_file(name: &str) -> bool {
    let l = lower(name);
    l.ends_with(".ini") && ["orfix", "healthbar", "texfx", "rabbitfx"].iter().any(|p| l.starts_with(p))
}

pub fn is_library_dir(name: &str) -> bool {
    let l = lower(name);
    l == "buffervalues" || l.starts_with("texfx") || l.starts_with("rabbitfx")
}

fn library_display(name: &str) -> String {
    let stem = name.strip_suffix(".ini").or_else(|| name.strip_suffix(".INI")).unwrap_or(name);
    let mut s = stem.to_string();
    for suf in ["-main", "-master", "_main", "_master"] {
        if lower(&s).ends_with(suf) {
            s.truncate(s.len() - suf.len());
        }
    }
    s
}

/// A TextureOverride hash as 3DMigoto reads it (hex, optional `0x`, stops at the first non-hex character such as a
/// trailing `;comment`), normalised to 8 lowercase digits.
pub fn parse_hash(v: &str) -> Option<String> {
    let t = v.trim();
    let t = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")).unwrap_or(t);
    let hex: String = t.chars().take_while(|c| c.is_ascii_hexdigit()).collect();
    (1..=8).contains(&hex.len()).then(|| format!("{:0>8}", hex.to_ascii_lowercase()))
}

/// Parse one ini into the facts the scanner needs.
pub fn ini_facts(ini: &Ini, rel: &str) -> IniFacts {
    let mut hashes = BTreeSet::new();
    let mut geometry = false;
    for s in ini.sections_with_prefix("textureoverride") {
        for (k, v) in &s.entries {
            if k == "hash" {
                if let Some(h) = parse_hash(v) {
                    hashes.insert(h);
                }
            } else if k == "ib"
                || k == "drawindexed"
                || k == "draw"
                || (k.starts_with("vb") && k[2..].parse::<u8>().is_ok())
            {
                geometry = true;
            }
        }
    }
    let dir = rel.rsplit_once('/').map(|(d, _)| d).unwrap_or("");
    let mut filenames = vec![];
    for s in &ini.sections {
        if let Some(f) = s.get("filename") {
            let f = f.trim().trim_matches('"').replace('\\', "/");
            let joined = if dir.is_empty() { f } else { format!("{dir}/{f}") };
            filenames.push(lower(&joined));
        }
    }
    IniFacts {
        rel: rel.to_string(),
        hashes: hashes.into_iter().collect(),
        namespace: ini.namespace().map(str::to_string),
        hotkeys: hotkeys::hotkeys_from_ini(ini, rel),
        filenames,
        geometry,
    }
}

#[derive(Default)]
struct DirNode {
    children: Vec<String>,
    inis: Vec<usize>,
}

struct Walker {
    res: ScanResult,
    dirs: HashMap<String, DirNode>,
}

fn join(rel: &str, name: &str) -> String {
    if rel.is_empty() { name.to_string() } else { format!("{rel}/{name}") }
}

impl Walker {
    fn walk(&mut self, abs: &Path, rel: &str) {
        self.dirs.entry(rel.to_string()).or_default();
        let Ok(rd) = fs::read_dir(abs) else { return };
        let mut entries: Vec<_> = rd.filter_map(Result::ok).collect();
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let name = e.file_name().to_string_lossy().into_owned();
            let child_rel = join(rel, &name);
            if paths::is_dot_name(&name) {
                continue;
            }
            if paths::is_junk_name(&name) {
                self.res.junk.push(child_rel);
                continue;
            }
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_symlink() {
                continue;
            }
            if ft.is_dir() {
                if paths::is_disabled_name(&name) {
                    self.res.disabled.push(child_rel);
                    continue;
                }
                if is_library_dir(&name) {
                    if lower(&name) == "buffervalues" {
                        self.collect_library_inis(&e.path(), &child_rel);
                    } else {
                        self.res.libraries.push(LibraryMod {
                            path: child_rel,
                            name: library_display(&name),
                            reason: LibraryReason::Known,
                        });
                    }
                    continue;
                }
                self.dirs.get_mut(rel).unwrap().children.push(child_rel.clone());
                self.walk(&e.path(), &child_rel);
                continue;
            }
            let ext = ext_of(&name);
            if ARCHIVE_EXTS.contains(&ext.as_str()) {
                if rel.is_empty() {
                    self.res.stray_archives.push(child_rel.clone());
                }
                self.res.archives.push(child_rel);
                continue;
            }
            if ext != "ini" {
                continue;
            }
            if paths::is_disabled_name(&name) {
                self.res.disabled.push(child_rel);
                continue;
            }
            if is_library_file(&name) {
                self.res.libraries.push(LibraryMod {
                    path: child_rel,
                    name: library_display(&name),
                    reason: LibraryReason::Known,
                });
                continue;
            }
            let Ok(ini) = Ini::read(&e.path()) else {
                continue;
            };
            let facts = ini_facts(&ini, &child_rel);
            if facts.hashes.is_empty() {
                continue; // helper ini, not a mod root
            }
            let idx = self.res.inis.len();
            self.res.inis.push(facts);
            self.dirs.get_mut(rel).unwrap().inis.push(idx);
        }
    }

    fn collect_library_inis(&mut self, abs: &Path, rel: &str) {
        let Ok(rd) = fs::read_dir(abs) else { return };
        for e in rd.filter_map(Result::ok) {
            let name = e.file_name().to_string_lossy().into_owned();
            let child_rel = join(rel, &name);
            if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                self.collect_library_inis(&e.path(), &child_rel);
            } else if ext_of(&name) == "ini" && !paths::is_disabled_name(&name) {
                self.res.libraries.push(LibraryMod {
                    path: child_rel,
                    name: library_display(&name),
                    reason: LibraryReason::Known,
                });
            }
        }
    }
}

#[derive(Debug, Clone)]
struct Group {
    root: String,
    inis: Vec<usize>,
    hashes: BTreeSet<String>,
    guess: Option<Guess>,
    geometry: bool,
    nested: Vec<NestedRoot>,
}

/// Share of the smaller hash set that the two sets have in common.
pub fn hash_overlap(a: &BTreeSet<String>, b: &BTreeSet<String>) -> f32 {
    let small = a.len().min(b.len());
    if small == 0 {
        return 0.0;
    }
    a.intersection(b).count() as f32 / small as f32
}

/// Alternatives override the same main hashes; parts override mostly different ones (SPEC §5).
pub const ALTERNATIVE_OVERLAP: f32 = 0.5;

/// An entity name the detector can match folder and ini names against.
struct NameEntry {
    display: String,
    category: Category,
    /// Library entity id, when the name comes from the library.
    entity_id: Option<String>,
    parent: Option<String>,
    aliases: Vec<String>,
}

struct Detector<'a> {
    ctx: &'a ScanContext<'a>,
    /// (compact name, display name, category, library entity id, parent name, aliases)
    names: Vec<NameEntry>,
    learned: HashMap<String, String>,
}

impl<'a> Detector<'a> {
    fn new(ctx: &'a ScanContext<'a>) -> Self {
        let mut names = vec![];
        let mut seen = BTreeSet::new();
        for e in &ctx.library.entities {
            let parent = e.parent_id.as_ref().and_then(|p| ctx.library.entity(p)).map(|p| p.name.clone());
            if seen.insert(names::compact(&e.name)) {
                names.push(NameEntry {
                    display: e.name.clone(),
                    category: e.category,
                    entity_id: Some(e.id.clone()),
                    parent,
                    aliases: e.aliases.clone(),
                });
            }
        }
        for (i, n) in ctx.index.entity_names() {
            if seen.insert(names::compact(n)) {
                let parent = ctx.index.parent_name(i).map(str::to_string);
                names.push(NameEntry {
                    display: n.to_string(),
                    category: ctx.index.category(i),
                    entity_id: None,
                    parent,
                    aliases: vec![],
                });
            }
        }
        for n in &ctx.extra_names {
            if seen.insert(names::compact(n)) {
                names.push(NameEntry {
                    display: n.clone(),
                    category: Category::Character,
                    entity_id: None,
                    parent: None,
                    aliases: vec![],
                });
            }
        }
        let mut learned = HashMap::new();
        for s in &ctx.library.skins {
            for h in &s.hashes {
                learned.insert(h.to_ascii_lowercase(), s.entity_id.clone());
            }
        }
        Detector { ctx, names, learned }
    }

    fn library_id_for(&self, name: &str) -> Option<String> {
        self.ctx.library.find_entity_by_name(name).map(|e| e.id.clone())
    }

    /// Best name match for a text, (score, index into self.names).
    fn best_name(&self, text: &str) -> Option<(f32, usize)> {
        let mut best: Option<(f32, usize)> = None;
        for (i, n) in self.names.iter().enumerate() {
            let s = names::name_score(text, &n.display, &n.aliases);
            if s > 0.0 && best.map(|(b, _)| s > b).unwrap_or(true) {
                best = Some((s, i));
            }
        }
        best
    }

    /// Exact or alias match only: "Furina" is a container, "paimon_cc116" (Paimon + more) is a mod folder.
    fn is_container_name(&self, name: &str) -> bool {
        self.best_name(name).map(|(s, _)| s >= 0.85).unwrap_or(false)
    }

    fn guess_from_name(&self, i: usize, confidence: f32, reason: GuessReason) -> Guess {
        let n = &self.names[i];
        Guess {
            entity_id: n.entity_id.clone().or_else(|| self.library_id_for(&n.display)),
            name: n.display.clone(),
            category: n.category,
            parent_name: n.parent.clone(),
            confidence,
            reason,
        }
    }

    /// Best name match among the root's own folder name and its ini file names.
    fn own_name(&self, inis: &[IniFacts], idxs: &[usize], root: &str) -> Option<(f32, usize)> {
        let mut best: Option<(f32, usize)> = None;
        for t in &own_texts(inis, idxs, root) {
            if let Some((s, i)) = self.best_name(t)
                && best.map(|(b, _)| s > b).unwrap_or(true)
            {
                best = Some((s, i));
            }
        }
        best
    }

    /// Entity guess for a group of inis rooted at `root` (SPEC §5 step 4: hash index, learned hashes, names).
    fn detect(&self, inis: &[IniFacts], idxs: &[usize], root: &str, containers: &BTreeSet<String>) -> Option<Guess> {
        let hashes: BTreeSet<&str> = idxs.iter().flat_map(|&i| inis[i].hashes.iter().map(String::as_str)).collect();
        let geometry = idxs.iter().any(|&i| inis[i].geometry);

        // (a) hash index: (weight, any geometry hit, how many of the mod's hashes hit)
        let mut votes: HashMap<usize, (f32, bool, usize)> = HashMap::new();
        for h in &hashes {
            let hits = self.ctx.index.lookup(h);
            let distinct: BTreeSet<usize> = hits.iter().map(|x| x.entity).collect();
            if distinct.is_empty() {
                continue;
            }
            for hit in hits {
                let w = if hit.is_geometry() { 3.0 } else { 1.0 } / distinct.len() as f32;
                let v = votes.entry(hit.entity).or_insert((0.0, false, 0));
                v.0 += w;
                v.1 |= hit.is_geometry();
            }
            for e in &distinct {
                if let Some(v) = votes.get_mut(e) {
                    v.2 += 1;
                }
            }
        }
        // ties go to playable characters and weapons over NPC/enemy copies that share hashes
        // ("Furina(NPC) pre 4-2" shares Furina's ib), then to the lower index for stability
        let rank = |i: usize| match self.ctx.index.entity(i).group {
            IndexGroup::Character | IndexGroup::Weapon => 2,
            IndexGroup::Npc => 1,
            _ => 0,
        };
        if let Some((&ent, &(_, geo, hit_count))) =
            votes.iter().max_by(|a, b| a.1.0.total_cmp(&b.1.0).then(rank(*a.0).cmp(&rank(*b.0))).then(b.0.cmp(a.0)))
        {
            let ie = self.ctx.index.entity(ent);
            let by_hash = Guess {
                entity_id: self.library_id_for(&ie.name),
                name: ie.name.clone(),
                category: self.ctx.index.category(ent),
                parent_name: self.ctx.index.parent_name(ent).map(str::to_string),
                confidence: if geo { 0.95 } else { 0.8 },
                reason: GuessReason::Hash,
            };
            // one shared hash is weak evidence: mods reuse generic meshes (an eye override for one character can
            // match another's), so the mod's own folder or ini naming a different entity in full wins over it
            if hit_count == 1
                && let Some((s, i)) = self.own_name(inis, idxs, root).filter(|(s, _)| *s >= 0.75)
            {
                let by_name = self.guess_from_name(i, 0.5 + 0.3 * s, GuessReason::Name);
                if by_name.key() != by_hash.key() {
                    return Some(by_name);
                }
            }
            return Some(by_hash);
        }

        // (b) hashes of skins the user already confirmed
        let mut lv: BTreeMap<&str, usize> = BTreeMap::new();
        for h in &hashes {
            if let Some(e) = self.learned.get(*h) {
                *lv.entry(e.as_str()).or_default() += 1;
            }
        }
        // BTreeMap + max_by_key keeps the last maximum in id order: deterministic between runs
        if let Some((eid, _)) = lv.into_iter().max_by_key(|(_, n)| *n)
            && let Some(e) = self.ctx.library.entity(eid)
        {
            let parent = e.parent_id.as_ref().and_then(|p| self.ctx.library.entity(p)).map(|p| p.name.clone());
            return Some(Guess {
                entity_id: Some(e.id.clone()),
                name: e.name.clone(),
                category: e.category,
                parent_name: parent,
                confidence: 0.85,
                reason: GuessReason::Learned,
            });
        }

        // (c) names: own folder and ini names first, then container ancestors, then other ancestors
        let comps: Vec<&str> = root.split('/').filter(|c| !c.is_empty()).collect();
        if let Some((s, i)) = self.own_name(inis, idxs, root).filter(|(s, _)| *s >= 0.55) {
            return Some(self.guess_from_name(i, 0.5 + 0.3 * s, GuessReason::Name));
        }
        // ancestors, nearest first
        let distinctive_own = own_texts(inis, idxs, root).first().map(|t| !t.contains('.')).unwrap_or(false);
        for depth in (0..comps.len().saturating_sub(1)).rev() {
            let anc = comps[depth];
            let anc_rel = comps[..=depth].join("/");
            let is_container = containers.contains(&lower(&anc_rel));
            if names::is_generic_part(anc) {
                continue;
            }
            if let Some((s, i)) = self.best_name(anc)
                && s >= 0.55
                && (is_container || !distinctive_own)
            {
                let w = if is_container { 0.95 } else { 0.7 };
                return Some(self.guess_from_name(i, 0.5 + 0.3 * s * w, GuessReason::Name));
            }
        }

        // (d) a name nothing knows yet: the nearest distinctive folder (the user confirms in review)
        let source = comps.iter().rev().find(|c| !c.contains('.') && !names::is_generic_part(c))?;
        Some(Guess {
            entity_id: None,
            name: names::display_name(source),
            category: if geometry { Category::Character } else { Category::Weapon },
            parent_name: None,
            confidence: 0.3,
            reason: GuessReason::NewName,
        })
    }
}

/// The root's own folder name (when distinctive) followed by its ini file names.
fn own_texts(inis: &[IniFacts], idxs: &[usize], root: &str) -> Vec<String> {
    let own = root.rsplit('/').find(|c| !c.is_empty()).unwrap_or("");
    let mut out = vec![];
    if !own.is_empty() && !own.contains('.') && !names::is_generic_part(own) {
        out.push(own.to_string());
    }
    for &i in idxs {
        out.push(inis[i].rel.rsplit('/').next().unwrap_or("").to_string());
    }
    out
}

fn compatible(a: &Group, b: &Group) -> bool {
    let same = match (&a.guess, &b.guess) {
        (Some(x), Some(y)) => x.key() == y.key(),
        _ => true,
    };
    same && hash_overlap(&a.hashes, &b.hashes) < ALTERNATIVE_OVERLAP
}

enum Up {
    Groups(Vec<Group>),
    Blocked,
}

struct Grouper<'a> {
    det: Detector<'a>,
    archive_root: bool,
    inis: &'a [IniFacts],
    dirs: &'a HashMap<String, DirNode>,
    containers: BTreeSet<String>,
    /// Folders the library already knows as skin folders (lowercase): always roots, so re-scans group them the
    /// same way the import did.
    known_roots: BTreeSet<String>,
    out: Vec<Vec<Group>>,
}

impl Grouper<'_> {
    fn make(&self, root: &str, inis: Vec<usize>, nested: Vec<NestedRoot>) -> Group {
        let hashes = inis.iter().flat_map(|&i| self.inis[i].hashes.iter().cloned()).collect();
        let geometry = inis.iter().any(|&i| self.inis[i].geometry);
        let guess = self.det.detect(self.inis, &inis, root, &self.containers);
        Group { root: root.to_string(), inis, hashes, guess, geometry, nested }
    }

    fn visit(&mut self, rel: &str) -> Up {
        let node = &self.dirs[rel];
        let children = node.children.clone();
        let own = node.inis.clone();
        let results: Vec<Up> = children.iter().map(|c| self.visit(c)).collect();

        if rel.is_empty() && !(self.archive_root && !own.is_empty()) {
            // Mods root: loose inis are their own roots; children are final
            let mut batch = vec![];
            for i in own {
                batch.push(self.make(&self.inis[i].rel.clone(), vec![i], vec![]));
            }
            for r in results {
                if let Up::Groups(gs) = r {
                    batch.extend(gs);
                }
            }
            self.out.push(batch);
            return Up::Blocked;
        }

        // a known skin folder is a root even without inis of its own (e.g. Mods/Odette holding Black Swan/)
        if !own.is_empty() || self.known_roots.contains(&lower(rel)) {
            // a mod root: everything below loads with it. Its own inis identify it; a known root without inis
            // of its own is identified by everything below.
            let base = if own.is_empty() { None } else { self.make(rel, own.clone(), vec![]).guess };
            let mut inis = own;
            let mut nested = vec![];
            let mut below: Vec<Group> = vec![];
            for r in results {
                if let Up::Groups(gs) = r {
                    below.extend(gs);
                }
            }
            self.collect_nested_below(rel, &mut below);
            for g in below {
                let foreign = matches!((&g.guess, &base), (Some(x), Some(y)) if x.key() != y.key()
                    && x.reason >= GuessReason::Name);
                if foreign {
                    nested.push(NestedRoot {
                        folder: g.root.clone(),
                        inis: g.inis.clone(),
                        hashes: g.hashes.clone(),
                        guess: g.guess.clone(),
                    });
                }
                nested.extend(g.nested.iter().cloned());
                inis.extend(g.inis);
            }
            let mut g = self.make(rel, inis, nested);
            // identify the root by its own inis, not by nested foreign ones
            if base.is_some() {
                g.guess = base;
            }
            return Up::Groups(vec![g]);
        }

        let mut cands = vec![];
        let mut blocked = false;
        for r in results {
            match r {
                Up::Blocked => blocked = true,
                Up::Groups(gs) => cands.extend(gs),
            }
        }
        if cands.is_empty() {
            return if blocked { Up::Blocked } else { Up::Groups(vec![]) };
        }
        let container = self.containers.contains(&lower(rel));
        let all_ok = !blocked
            && !container
            && cands.iter().enumerate().all(|(i, a)| cands.iter().skip(i + 1).all(|b| compatible(a, b)));
        if all_ok {
            let inis: Vec<usize> = cands.iter().flat_map(|g| g.inis.clone()).collect();
            let nested: Vec<NestedRoot> = cands.iter().flat_map(|g| g.nested.clone()).collect();
            return Up::Groups(vec![self.make(rel, inis, nested)]);
        }
        self.out.push(cands);
        Up::Blocked
    }

    /// Groups below an ini-holding root were returned as candidates; Blocked subtrees already emitted their
    /// groups into `out`, so pull those back in as nested parts of this root.
    fn collect_nested_below(&mut self, rel: &str, below: &mut Vec<Group>) {
        // the archive root owns everything below it
        let prefix = if rel.is_empty() { String::new() } else { format!("{}/", lower(rel)) };
        let mut keep = vec![];
        for batch in self.out.drain(..) {
            let (inside, outside): (Vec<Group>, Vec<Group>) =
                batch.into_iter().partition(|g| lower(&g.root).starts_with(&prefix));
            below.extend(inside);
            if !outside.is_empty() {
                keep.push(outside);
            }
        }
        self.out = keep;
    }
}

/// Merge side-by-side roots that are parts of one skin (same entity, mostly different hashes).
fn merge_parts(batch: Vec<Group>) -> Vec<Candidate> {
    let n = batch.len();
    let mut parent: Vec<usize> = (0..n).collect();
    fn find(p: &mut [usize], x: usize) -> usize {
        let mut r = x;
        while p[r] != r {
            r = p[r];
        }
        p[x] = r;
        r
    }
    for i in 0..n {
        for j in i + 1..n {
            let (a, b) = (&batch[i], &batch[j]);
            let same = matches!((&a.guess, &b.guess), (Some(x), Some(y)) if x.key() == y.key() && x.reason >= GuessReason::Name && y.reason >= GuessReason::Name);
            if same && hash_overlap(&a.hashes, &b.hashes) < ALTERNATIVE_OVERLAP {
                // all members of both sets must stay mutually compatible
                let ri = find(&mut parent, i);
                let rj = find(&mut parent, j);
                if ri != rj {
                    let members: Vec<usize> = (0..n)
                        .filter(|&k| find(&mut parent.clone(), k) == ri || find(&mut parent.clone(), k) == rj)
                        .collect();
                    let ok = members.iter().enumerate().all(|(x, &p)| {
                        members
                            .iter()
                            .skip(x + 1)
                            .all(|&q| hash_overlap(&batch[p].hashes, &batch[q].hashes) < ALTERNATIVE_OVERLAP)
                    });
                    if ok {
                        parent[rj] = ri;
                    }
                }
            }
        }
    }
    let mut sets: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
    for i in 0..n {
        let r = find(&mut parent, i);
        sets.entry(r).or_default().push(i);
    }
    sets.into_values()
        .map(|members| {
            let mut c = Candidate::default();
            let mut best: Option<Guess> = None;
            for &m in &members {
                let g = &batch[m];
                c.folders.push(g.root.clone());
                c.inis.extend(g.inis.iter().copied());
                c.hashes.extend(g.hashes.iter().cloned());
                c.geometry |= g.geometry;
                c.nested.extend(g.nested.iter().cloned());
                if let Some(x) = &g.guess
                    && best.as_ref().map(|b| (x.reason, x.confidence) > (b.reason, b.confidence)).unwrap_or(true)
                {
                    best = Some(x.clone());
                }
            }
            c.guess = best;
            c
        })
        .collect()
}

/// Scan a Mods folder (or an extracted archive) and group its mod roots into skin candidates.
pub fn scan(root: &Path, ctx: &ScanContext) -> ScanResult {
    let mut w = Walker { res: ScanResult::default(), dirs: HashMap::new() };
    w.walk(root, "");
    let Walker { mut res, dirs } = w;

    let det = Detector::new(ctx);

    // Heuristic libraries (SPEC §4 step 2): a namespace, no hash known to the index, and no name match.
    let mut lib_inis = BTreeSet::new();
    for (i, f) in res.inis.iter().enumerate() {
        let Some(ns) = &f.namespace else { continue };
        if f.hashes.iter().any(|h| !ctx.index.lookup(h).is_empty()) {
            continue;
        }
        let named = f.rel.split('/').any(|c| det.best_name(c).map(|(s, _)| s >= 0.6).unwrap_or(false));
        if !named {
            lib_inis.insert(i);
            res.maybe_libraries.push(LibraryMod {
                path: f.rel.clone(),
                name: format!("{} ({ns})", f.rel.rsplit('/').next().unwrap_or(&f.rel)),
                reason: LibraryReason::Heuristic,
            });
        }
    }
    let mut dirs = dirs;
    for node in dirs.values_mut() {
        node.inis.retain(|i| !lib_inis.contains(i));
    }

    // Entity containers: top-level folders named after an entity, with no inis of their own (`Mods/Furina/`).
    let mut containers = BTreeSet::new();
    if let Some(top) = dirs.get("") {
        for c in &top.children {
            let node = &dirs[c];
            let known = ctx.library.skins.iter().any(|s| s.folders.iter().any(|f| paths::same_path(f, c)));
            if node.inis.is_empty() && !node.children.is_empty() && !known && det.is_container_name(c) {
                containers.insert(lower(c));
            }
        }
    }
    for s in &ctx.library.skins {
        for f in &s.folders {
            if let Some((parent, _)) = f.split_once('/')
                && !parent.contains('/')
                && !f[parent.len() + 1..].contains('/')
            {
                containers.insert(lower(parent));
            }
        }
    }

    let known_roots: BTreeSet<String> =
        ctx.library.skins.iter().flat_map(|s| s.folders.iter().map(|f| lower(&f.replace('\\', "/")))).collect();
    let mut g = Grouper {
        det,
        archive_root: ctx.archive_root,
        inis: &res.inis,
        dirs: &dirs,
        containers,
        known_roots,
        out: vec![],
    };
    if let Up::Groups(gs) = g.visit("") {
        // archive root holding inis: one root for the whole archive
        g.out.push(gs);
    }
    let batches = std::mem::take(&mut g.out);
    let mut candidates: Vec<Candidate> = batches.into_iter().flat_map(merge_parts).collect();
    for c in &mut candidates {
        c.folders.sort_by_key(|f| lower(f));
        c.inis.sort_unstable();
        c.inis.dedup();
    }
    candidates.sort_by_key(|c| lower(&c.folders[0]));
    res.candidates = candidates;
    res
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::hashindex::tests::test_index;
    use std::path::PathBuf;

    pub fn fixtures_mods() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/Mods")
    }

    fn by_folder<'a>(r: &'a ScanResult, f: &str) -> &'a Candidate {
        r.candidates.iter().find(|c| c.folders.iter().any(|x| x.eq_ignore_ascii_case(f))).unwrap_or_else(|| {
            panic!("no candidate with folder {f}: {:#?}", r.candidates.iter().map(|c| &c.folders).collect::<Vec<_>>())
        })
    }

    fn scan_fixtures() -> ScanResult {
        let idx = test_index();
        let lib = Library::default();
        scan(&fixtures_mods(), &ScanContext::new(&idx, &lib))
    }

    #[test]
    fn nested_face_inis_collapse_and_join_the_outfit() {
        let r = scan_fixtures();
        let s = by_folder(&r, "sandrone_marionette_by_neyori/Face");
        assert_eq!(s.folders, vec!["sandrone_marionette_by_neyori/Face", "sandrone_marionette_by_neyori/outfit"]);
        let g = s.guess.as_ref().unwrap();
        assert_eq!(g.name, "Sandrone");
        assert_eq!(g.reason, GuessReason::Hash);
    }

    #[test]
    fn sibling_weapon_is_its_own_weapon_skin() {
        let r = scan_fixtures();
        let w = by_folder(&r, "sandrone_marionette_by_neyori/A Teaspoon of Transcendence");
        assert_eq!(w.folders.len(), 1);
        let g = w.guess.as_ref().unwrap();
        assert_eq!(g.name, "A Teaspoon of Transcendence");
        assert_eq!(g.category, Category::Weapon);
    }

    #[test]
    fn paimon_collapses_to_its_top_folder_by_hash() {
        let r = scan_fixtures();
        let p = by_folder(&r, "paimon_cc116");
        assert_eq!(p.guess.as_ref().unwrap().name, "Paimon");
        assert_eq!(p.guess.as_ref().unwrap().reason, GuessReason::Hash);
    }

    #[test]
    fn multi_root_skin_under_an_entity_container() {
        let r = scan_fixtures();
        let v = by_folder(&r, "Varesa/Outfit");
        assert_eq!(v.folders, vec!["Varesa/Face", "Varesa/Outfit"]);
        assert_eq!(v.guess.as_ref().unwrap().name, "Varesa");
    }

    #[test]
    fn alternatives_under_a_container_stay_separate() {
        let r = scan_fixtures();
        let a = by_folder(&r, "Furina/Remembrance");
        assert_eq!(a.folders, vec!["Furina/Remembrance"]);
        assert_eq!(a.guess.as_ref().unwrap().name, "Furina");
        let b = by_folder(&r, "Furina/Casual");
        assert_eq!(b.folders, vec!["Furina/Casual"]);
    }

    #[test]
    fn merged_pack_is_one_skin_and_inner_disabled_variants_are_ignored() {
        let r = scan_fixtures();
        let k = by_folder(&r, "Kazuha/Multi");
        assert_eq!(k.folders, vec!["Kazuha/Multi"]);
        assert!(r.inis.iter().all(|i| !paths::has_disabled_component(&i.rel)));
        for d in [
            "Kazuha/Multi/DISABLED_01 Normal",
            "Kazuha/Multi/DISABLED 02 Ponytail",
            "Kazuha/Multi/Toukabou/DISABLEDtoukabou.ini",
        ] {
            assert!(r.disabled.iter().any(|x| x == d), "{d} in {:?}", r.disabled);
        }
    }

    #[test]
    fn libraries_by_name_and_heuristic() {
        let r = scan_fixtures();
        let names: Vec<&str> = r.libraries.iter().map(|l| l.path.as_str()).collect();
        for want in ["ORFix.ini", "ORFixAPI.ini", "BufferValues/HealthBar.ini", "TexFx-main"] {
            assert!(names.contains(&want), "{want} in {names:?}");
        }
        assert!(r.maybe_libraries.iter().any(|l| l.path == "SharedHelpers/Helpers.ini"));
        assert!(r.candidates.iter().all(|c| !c.folders.iter().any(|f| f.starts_with("SharedHelpers"))));
    }

    #[test]
    fn skips_disabled_dot_folders_junk_and_reports_stray_archives() {
        let r = scan_fixtures();
        assert!(r.disabled.iter().any(|d| d == "disabled_x"));
        assert!(r.disabled.iter().any(|d| d == "Varesa/Outfit/DISABLEDVaresa.ini"));
        assert!(r.disabled.iter().any(|d| d == "Furina/DISABLED_Old"));
        assert!(r.junk.iter().any(|j| j.ends_with("desktop.ini")));
        assert!(r.inis.iter().all(|i| !i.rel.starts_with(".impeccable")));
        assert!(r.stray_archives.contains(&"paimon_cc116.zip".to_string()));
    }

    #[test]
    fn hotkeys_are_parsed_per_candidate() {
        let r = scan_fixtures();
        let s = by_folder(&r, "sandrone_marionette_by_neyori/outfit");
        let hk = r.hotkeys_of(s);
        assert!(hk.iter().any(|h| h.keys == "no_modifiers 8" && h.label == "Hat" && h.gated));
        assert!(hk.iter().any(|h| h.keys == "alt 7" && h.label == "Swap"));
    }

    #[test]
    fn unknown_entity_gets_a_folder_name_guess() {
        // Odette isn't in the hash index; without a known container the folder collapses to Mods/Odette.
        let r = scan_fixtures();
        let b = by_folder(&r, "Odette");
        let g = b.guess.as_ref().unwrap();
        assert_eq!(g.name, "Odette");
        assert_eq!(g.reason, GuessReason::NewName);
        assert_eq!(g.category, Category::Character);
    }

    #[test]
    fn extra_names_make_containers() {
        let idx = test_index();
        let lib = Library::default();
        let mut ctx = ScanContext::new(&idx, &lib);
        ctx.extra_names = vec!["Odette".into()];
        let r = scan(&fixtures_mods(), &ctx);
        let b = by_folder(&r, "Odette/Black Swan");
        assert_eq!(b.guess.as_ref().unwrap().name, "Odette");
        assert_eq!(b.guess.as_ref().unwrap().reason, GuessReason::Name);
    }

    #[test]
    fn hash_ties_prefer_the_playable_character_over_an_npc_copy() {
        let idx = HashIndex::from_json(
            r#"{"entities":[{"key":"FurinaNPC","name":"Furina(NPC) pre 4-2","group":"npc"},{"key":"Furina","name":"Furina","group":"character"}],
                "hashes":{"aaaa0001":[[0,"ib",""],[1,"ib",""]],"aaaa0002":[[0,"position_vb",""],[1,"position_vb",""]]}}"#,
        )
        .unwrap();
        let t = tempfile::tempdir().unwrap();
        fs::create_dir_all(t.path().join("SomeMod")).unwrap();
        fs::write(
            t.path().join("SomeMod/x.ini"),
            "[TextureOverrideA]\nhash = aaaa0001\nib = R\n[TextureOverrideB]\nhash = aaaa0002\n",
        )
        .unwrap();
        let lib = Library::default();
        let r = scan(t.path(), &ScanContext::new(&idx, &lib));
        assert_eq!(r.candidates[0].guess.as_ref().unwrap().name, "Furina");
    }

    #[test]
    fn a_lone_shared_hash_loses_to_the_mods_own_name() {
        // Bennett's beach skin: its eye override shares one hash with another character in the index
        let idx = test_index();
        let lib = Library::default();
        let t = tempfile::tempdir().unwrap();
        let write = |rel: &str, body: &str| {
            let p = t.path().join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, body).unwrap();
        };
        // bf6aef4d is a Fischl position hash; ffff0001.. are unknown (a newer model)
        write("BeachDay/BennettAdventure.ini", "[TextureOverrideEye]\nhash = bf6aef4d\n[TextureOverrideBody]\nhash = ffff0001\nib = R\n");
        // the same lone hit with no name to go on stays a hash guess
        write("Plain/merged.ini", "[TextureOverrideEye]\nhash = bf6aef4d\n[TextureOverrideBody]\nhash = ffff0002\nib = R\n");
        // two hits beat a name
        write("Two/BennettAlt.ini", "[TextureOverrideA]\nhash = bf6aef4d\n[TextureOverrideB]\nhash = 6428104d\nib = R\n");
        let r = scan(t.path(), &ScanContext::new(&idx, &lib));
        let g = |f: &str| by_folder(&r, f).guess.clone().unwrap();
        assert_eq!((g("BeachDay").name.as_str(), g("BeachDay").reason), ("Bennett", GuessReason::Name));
        assert_eq!((g("Plain").name.as_str(), g("Plain").reason), ("Fischl", GuessReason::Hash));
        assert_eq!((g("Two").name.as_str(), g("Two").reason), ("Fischl", GuessReason::Hash));
    }

    #[test]
    fn hashes_parse_like_3dmigoto() {
        assert_eq!(parse_hash("65A4831F").as_deref(), Some("65a4831f"));
        assert_eq!(parse_hash("0x65a4831f").as_deref(), Some("65a4831f"));
        assert_eq!(parse_hash("65a4831f;note").as_deref(), Some("65a4831f"));
        assert_eq!(parse_hash("1f").as_deref(), Some("0000001f"));
        assert_eq!(parse_hash("6d514558fc6b35bb"), None);
        assert_eq!(parse_hash("zz"), None);
    }

    #[test]
    fn overlap_ratio() {
        let a: BTreeSet<String> = ["1", "2", "3", "4"].iter().map(|s| s.to_string()).collect();
        let b: BTreeSet<String> = ["4", "5"].iter().map(|s| s.to_string()).collect();
        assert_eq!(hash_overlap(&a, &b), 0.5);
        assert_eq!(hash_overlap(&a, &BTreeSet::new()), 0.0);
    }
}
