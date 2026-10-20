//! Bring old mods up to date for the current game:
//!
//! - **Release fix**: replace hashes the game changed in 4.1, 4.3, 4.4-4.7 and 5.4, and remap the vertex groups of
//!   the Blend.buf files of characters whose skeletons changed. Without it a mod shows up distorted, or not at all.
//! - **ORFix**: add `run = CommandList\global\ORFix\ORFix` (or `NNFix` for parts without a normal map) after the
//!   texture slots of each known part, so the global `ORFix.ini` binds them where the current game reads them.
//!   Without it a mod's textures land in the wrong slots (a flat green or glowing character).
//!
//! The hash tables are not part of this repo: `scripts/extract-modfix-data.py` builds the gitignored
//! `resources/modfix_data.json` from the community fixer scripts on the user's machine (docs/DECISIONS.md). Without
//! that file the fixes are off. The behaviour follows those tools, with the changes noted in docs/DECISIONS.md.
//!
//! `fix_tree` writes no backups: it runs on freshly extracted copies whose archive stays in the Library.

use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

pub const DATA_FILE: &str = "modfix_data.json";

/// The fix tables (`modfix_data.json`).
#[derive(Deserialize)]
pub struct FixData {
    #[serde(rename = "releaseFix")]
    release_fix: ReleaseFix,
    orfix: Vec<Character>,
    #[serde(rename = "oldShaderFixes")]
    old_shader_fixes: Vec<String>,
}

#[derive(Deserialize)]
struct ReleaseFix {
    steps: Vec<Step>,
    remaps: Vec<Remap>,
}

#[derive(Deserialize)]
struct Step {
    pairs: Vec<(String, String)>,
}

#[derive(Deserialize)]
struct Remap {
    trigger: String,
    name: String,
    mapping: Vec<u32>,
}

#[derive(Deserialize)]
struct Character {
    name: String,
    component: String,
    ib: String,
    normal: Vec<(String, u32)>,
    #[serde(rename = "noNormal")]
    no_normal: Vec<(String, u32)>,
}

impl FixData {
    pub fn load(path: &Path) -> std::io::Result<Self> {
        Self::from_json(&fs::read(path)?)
    }

    pub fn from_json(json: &[u8]) -> std::io::Result<Self> {
        let d: FixData = serde_json::from_slice(json)?;
        if d.release_fix.steps.is_empty() {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "no release fix steps"));
        }
        Ok(d)
    }
}

/// What `fix_tree` changed.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FixReport {
    pub inis_changed: usize,
    pub hashes_updated: usize,
    pub orfix_parts: usize,
    pub old_shader_fixes: usize,
    pub blends_remapped: usize,
    /// Characters whose Blend.buf was left alone although its ini named them (bad size, or already updated).
    pub remaps_skipped: Vec<String>,
}

impl FixReport {
    pub fn changed(&self) -> bool {
        self.inis_changed > 0 || self.blends_remapped > 0
    }

    pub fn merge(&mut self, o: FixReport) {
        self.inis_changed += o.inis_changed;
        self.hashes_updated += o.hashes_updated;
        self.orfix_parts += o.orfix_parts;
        self.old_shader_fixes += o.old_shader_fixes;
        self.blends_remapped += o.blends_remapped;
        self.remaps_skipped.extend(o.remaps_skipped);
    }

    /// One line for a toast, or None when nothing changed.
    pub fn summary(&self) -> Option<String> {
        if !self.changed() {
            return None;
        }
        let plural = |n: usize, one: &str, many: &str| format!("{n} {}", if n == 1 { one } else { many });
        let mut parts = vec![];
        if self.orfix_parts > 0 {
            parts.push(format!("ORFix added to {}", plural(self.orfix_parts, "part", "parts")));
        }
        if self.hashes_updated > 0 {
            parts.push(format!("{} updated", plural(self.hashes_updated, "old hash", "old hashes")));
        }
        if self.blends_remapped > 0 {
            parts.push(format!("{} remapped", plural(self.blends_remapped, "blend file", "blend files")));
        }
        if self.old_shader_fixes > 0 {
            parts.push(format!("{} removed", plural(self.old_shader_fixes, "old shader fix", "old shader fixes")));
        }
        Some(format!("Updated for the current game: {}.", parts.join(", ")))
    }
}

/// Fix every mod ini (and the Blend.buf files next to it) below `root`. A file that can't be read or written is
/// left as it was; the rest carry on.
pub fn fix_tree(root: &Path, d: &FixData) -> FixReport {
    let mut report = FixReport::default();
    let mut inis = vec![];
    collect_inis(root, &mut inis);
    let mut remapped: Vec<PathBuf> = vec![];
    for ini in inis {
        let Ok(bytes) = fs::read(&ini) else { continue };
        let text = IniText::decode(&bytes);
        let mut s = text.body.clone();
        let mut r = FixReport::default();
        s = release_fix(d, &s, &ini, &mut r, &mut remapped);
        s = apply_orfix(d, &s, &mut r);
        if s != text.body {
            if fs::write(&ini, text.encode(&s)).is_err() {
                continue;
            }
            r.inis_changed = 1;
        }
        report.merge(r);
    }
    report
}

/// Mod inis below `dir`, minus what the tools skip: desktop.ini, ORFix itself, BufferValues and backups.
fn collect_inis(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.filter_map(Result::ok) {
        let Ok(ft) = e.file_type() else { continue };
        let name = e.file_name().to_string_lossy().to_lowercase();
        if ft.is_dir() {
            if !name.contains("buffervalues") && !name.contains("backup") {
                collect_inis(&e.path(), out);
            }
        } else if ft.is_file() && name.ends_with(".ini") {
            let stem = &name[..name.len() - 4];
            let skip =
                matches!(stem, "desktop" | "orfix" | "orfixapi") || name.contains("ntuser") || name.contains("backup");
            if !skip {
                out.push(e.path());
            }
        }
    }
}

/// An ini as text with `\n` line ends (as Python reads it), and how to write it back the way it was.
struct IniText {
    body: String,
    crlf: bool,
    utf8: bool,
}

impl IniText {
    fn decode(bytes: &[u8]) -> Self {
        let (raw, utf8) = match std::str::from_utf8(bytes) {
            Ok(s) => (s.to_string(), true),
            // 3DMigoto inis are often cp1252: map bytes 1:1 so writing back restores them exactly
            Err(_) => (bytes.iter().map(|&b| b as char).collect(), false),
        };
        let crlf = raw.contains("\r\n");
        IniText { body: if crlf { raw.replace("\r\n", "\n") } else { raw }, crlf, utf8 }
    }

    fn encode(&self, s: &str) -> Vec<u8> {
        let s = if self.crlf { s.replace('\n', "\r\n") } else { s.to_string() };
        if self.utf8 { s.into_bytes() } else { s.chars().map(|c| c as u32 as u8).collect() }
    }
}

// ------------------------------------------------------------------------------------------------ release fix

fn is_hex(b: u8) -> bool {
    b.is_ascii_hexdigit()
}

/// Byte ranges where `hash` stands as a whole word (no hex digit either side), any case.
fn hash_spans(s: &str, hash: &str) -> Vec<(usize, usize)> {
    let (hay, needle) = (s.as_bytes(), hash.as_bytes());
    let mut out = vec![];
    if needle.is_empty() || hay.len() < needle.len() {
        return out;
    }
    let mut i = 0;
    while i + needle.len() <= hay.len() {
        let end = i + needle.len();
        if hay[i..end].eq_ignore_ascii_case(needle)
            && (i == 0 || !is_hex(hay[i - 1]))
            && (end == hay.len() || !is_hex(hay[end]))
        {
            out.push((i, end));
            i = end;
        } else {
            i += 1;
        }
    }
    out
}

fn has_hash(s: &str, hash: &str) -> bool {
    !hash_spans(s, hash).is_empty()
}

fn replace_hash(s: &str, old: &str, new: &str) -> (String, usize) {
    let spans = hash_spans(s, old);
    if spans.is_empty() {
        return (s.to_string(), 0);
    }
    let mut out = String::with_capacity(s.len());
    let mut last = 0;
    for &(a, b) in &spans {
        out.push_str(&s[last..a]);
        out.push_str(new);
        last = b;
    }
    out.push_str(&s[last..]);
    (out, spans.len())
}

/// One version step, in the script's order. A pair whose old and new hash are equal marks the file as already
/// updated for that step, which ends the step there (as in the script).
fn update_step(mut s: String, step: &Step, r: &mut FixReport) -> String {
    for (old, new) in &step.pairs {
        if old == new {
            if has_hash(&s, old) {
                break;
            }
            continue;
        }
        let (next, n) = replace_hash(&s, old, new);
        if n > 0 {
            s = next;
            r.hashes_updated += n;
        }
    }
    s
}

/// What `hash` becomes after `steps` (itself when nothing replaces it).
fn final_hash(hash: &str, steps: &[Step]) -> String {
    let mut h = hash.to_string();
    for step in steps {
        if let Some((_, new)) = step.pairs.iter().find(|(o, n)| o == &h && o != n) {
            h = new.clone();
        }
    }
    h
}

fn release_fix(d: &FixData, s: &str, ini: &Path, r: &mut FixReport, remapped: &mut Vec<PathBuf>) -> String {
    let steps = &d.release_fix.steps;
    let original = s.to_string();
    // 4.1 first, then the remaps (their triggers are 4.1-era hashes), then the later versions
    let mut s = update_step(s.to_string(), &steps[0], r);
    for remap in &d.release_fix.remaps {
        if !has_hash(&s, &remap.trigger) {
            continue;
        }
        let target = final_hash(&remap.trigger, &steps[1..]);
        if target != remap.trigger && has_hash(&original, &target) {
            // the mod already carries the new hash too: its blend is (also) for the new skeleton
            r.remaps_skipped.push(remap.name.clone());
            continue;
        }
        let Some(dir) = ini.parent() else { continue };
        for blend in blend_files(dir) {
            if remapped.contains(&blend) {
                continue;
            }
            match remap_file(&blend, &remap.mapping) {
                Ok(()) => {
                    r.blends_remapped += 1;
                    remapped.push(blend);
                }
                Err(_) => r.remaps_skipped.push(remap.name.clone()),
            }
        }
    }
    for step in &steps[1..] {
        s = update_step(s, step, r);
    }
    s
}

/// `*blend*.buf` files directly in `dir` (the script's rule: same folder as the ini).
fn blend_files(dir: &Path) -> Vec<PathBuf> {
    let Ok(rd) = fs::read_dir(dir) else { return vec![] };
    let mut out: Vec<PathBuf> = rd
        .filter_map(Result::ok)
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .filter(|e| {
            let n = e.file_name().to_string_lossy().to_lowercase();
            n.contains("blend") && n.contains(".buf") && !n.ends_with(".bak")
        })
        .map(|e| e.path())
        .collect();
    out.sort();
    out
}

/// Remap the vertex-group indices of a Blend.buf (stride 32: four f32 weights, then four u32 indices).
pub fn remap_blend(data: &[u8], mapping: &[u32]) -> Option<Vec<u8>> {
    const STRIDE: usize = 32;
    if !data.len().is_multiple_of(STRIDE) {
        return None;
    }
    let mut out = data.to_vec();
    for v in (0..data.len()).step_by(STRIDE) {
        for x in 0..4 {
            let w = f32::from_le_bytes(data[v + x * 4..v + x * 4 + 4].try_into().ok()?);
            let at = v + 16 + x * 4;
            let idx = u32::from_le_bytes(data[at..at + 4].try_into().ok()?);
            if w != 0.0
                && let Some(&n) = mapping.get(idx as usize)
            {
                out[at..at + 4].copy_from_slice(&n.to_le_bytes());
            }
        }
    }
    Some(out)
}

fn remap_file(path: &Path, mapping: &[u32]) -> std::io::Result<()> {
    let data = fs::read(path)?;
    let out = remap_blend(&data, mapping)
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidData, "not a Blend.buf"))?;
    fs::write(path, out)
}

// ------------------------------------------------------------------------------------------------------ ORFix

const ORFIX_RUN: &str = "run = CommandList\\global\\ORFix\\ORFix\n";
const NNFIX_RUN: &str = "run = CommandList\\global\\ORFix\\NNFix\n";

fn re(p: &str) -> Regex {
    RegexBuilder::new(p).case_insensitive(true).multi_line(true).build().expect("valid regex")
}

static ORFIX_RE: LazyLock<Regex> =
    LazyLock::new(|| re(r"[ \t\x0C]*run\s*=\s*CommandList\\global\\ORFix\\ORFix[ \t\x0C]*\n"));
static NNFIX_RE: LazyLock<Regex> =
    LazyLock::new(|| re(r"[ \t\x0C]*run\s*=\s*CommandList\\global\\ORFix\\NNFix[ \t\x0C]*\n"));
// runs of ps-t lines (blank lines between them included), then the blank lines after the run
static TEXTURE_BLOCK_RE: LazyLock<Regex> =
    LazyLock::new(|| re(r"((?:^[ \t\x0C]*ps-t.*\n(?:[ \t\x0C]*\n)*)*^[ \t\x0C]*ps-t.*\n)((?:[ \t\x0C]*\n)*)"));
static INDENT_RE: LazyLock<Regex> = LazyLock::new(|| re(r"^([ \t\x0C]*)ps-t"));
static GENERIC_RUN_RE: LazyLock<Regex> = LazyLock::new(|| re(r"run\s*=\s*CommandList(\w+)"));

#[derive(Clone, Copy, PartialEq)]
enum Fix {
    Or,
    Nn,
}

impl Fix {
    fn run(self) -> &'static str {
        if self == Fix::Or { ORFIX_RUN } else { NNFIX_RUN }
    }
    fn pattern(self) -> &'static Regex {
        if self == Fix::Or { &ORFIX_RE } else { &NNFIX_RE }
    }
    fn other(self) -> Fix {
        if self == Fix::Or { Fix::Nn } else { Fix::Or }
    }
}

/// Sections with their lines; the part before the first `[` is a section of its own.
fn split_sections(s: &str) -> Vec<String> {
    let mut out = vec![];
    let mut cur = String::new();
    for line in s.split_inclusive('\n') {
        if line.trim().starts_with('[') && !cur.is_empty() {
            out.push(std::mem::take(&mut cur));
        }
        cur.push_str(line);
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// The known part a `[TextureOverride*]` section draws: (character, part, fix).
fn search_part<'a>(d: &'a FixData, section: &str) -> Option<(&'a str, String, Fix)> {
    let index_of = |n: u32| re(&format!(r"match_first_index\s*=\s*{n}(?:[^0-9]|$)"));
    for c in &d.orfix {
        let ib = re(&format!(r"hash\s*=\s*{}(?:[^0-9a-f]|$)", regex::escape(&c.ib)));
        if !ib.is_match(section) {
            continue;
        }
        for (parts, fix) in [(&c.normal, Fix::Or), (&c.no_normal, Fix::Nn)] {
            for (part, first) in parts {
                if index_of(*first).is_match(section) {
                    return Some((c.name.as_str(), format!("{}{part}", c.component), fix));
                }
            }
        }
    }
    None
}

/// Split at every `if` / `else` line (kept with the block above it) and every `endif`.
fn split_ifelse_blocks(section: &str) -> Vec<String> {
    let mut blocks = vec![];
    let mut block = String::new();
    for line in section.split_inclusive('\n') {
        block.push_str(line);
        let l = line.trim().to_lowercase();
        if l.starts_with("if") || l.starts_with("else") || l.starts_with("endif") {
            blocks.push(std::mem::take(&mut block));
        }
    }
    if !block.is_empty() {
        blocks.push(block);
    }
    blocks
}

/// Put the fix after every run of texture slots (before any blank lines that follow it), in each if/else branch,
/// at the slots' indentation.
fn fix_ifelse_blocks(text: &str, fix: Fix) -> String {
    split_ifelse_blocks(text)
        .into_iter()
        .map(|block| {
            let indent = INDENT_RE.captures(&block).map(|c| c[1].to_string()).unwrap_or_default();
            TEXTURE_BLOCK_RE
                .replace_all(&block, |c: &regex::Captures| format!("{}{indent}{}{}", &c[1], fix.run(), &c[2]))
                .into_owned()
        })
        .collect()
}

fn find_section(sections: &[String], prefix: &str) -> Option<usize> {
    let p = format!("[{prefix}").to_lowercase();
    sections.iter().position(|s| s.to_lowercase().starts_with(&p))
}

fn apply_orfix(d: &FixData, s: &str, r: &mut FixReport) -> String {
    let mut s = s.to_string();
    for old in &d.old_shader_fixes {
        if s.contains(old.as_str()) {
            s = s.replace(old.as_str(), "");
            r.old_shader_fixes += 1;
        }
    }
    let mut sections = split_sections(&s);
    for i in 0..sections.len() {
        if !sections[i].to_lowercase().starts_with("[textureoverride") {
            continue;
        }
        let Some((chara, part, fix)) = search_part(d, &sections[i]) else { continue };
        // the other fix in the section is wrong for this part: drop it
        let section = fix.other().pattern().replace_all(&sections[i], "").into_owned();
        if fix.pattern().is_match(&section) {
            continue; // already applied
        }
        let merged = re(&format!(r"run\s*=\s*commandlist{}", regex::escape(&format!("{chara}{part}"))));
        let list = if merged.is_match(&section) {
            find_section(&sections, &format!("CommandList{chara}{part}"))
        } else if let Some(c) = GENERIC_RUN_RE.captures(&section) {
            find_section(&sections, &format!("CommandList{}", &c[1]))
        } else {
            let fixed = fix_ifelse_blocks(&section, fix);
            if fixed != section {
                sections[i] = fixed;
                r.orfix_parts += 1;
            }
            continue;
        };
        // a merged mod: the textures are bound in the command list the section runs
        let Some(j) = list else { continue };
        if fix.pattern().is_match(&sections[j]) {
            continue;
        }
        let fixed = fix_ifelse_blocks(&sections[j], fix);
        if fixed != sections[j] {
            sections[j] = fixed;
            r.orfix_parts += 1;
        }
    }
    sections.concat()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data() -> &'static FixData {
        static D: LazyLock<FixData> = LazyLock::new(|| {
            FixData::load(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/modfix_data.test.json")).unwrap()
        });
        &D
    }

    fn orfix(s: &str) -> (String, FixReport) {
        let mut r = FixReport::default();
        (apply_orfix(data(), s, &mut r), r)
    }

    const ZHONGLI_MERGED: &str = "[TextureOverrideZhongliHead]\nhash = 4c8480f5\nmatch_first_index = 0\nrun = CommandListZhongliHead\n\n[TextureOverrideZhongliBody]\nhash = 4c8480f5\nmatch_first_index = 8976\nrun = CommandListZhongliBody\n\n[CommandListZhongliHead]\nif $swapvar == 0\n\tib = ResourceA\n\tps-t0 = ResourceHeadDiffuse.0\n\tps-t1 = ResourceHeadLightMap.0\nelse if $swapvar == 1\n\tib = ResourceB\n\tps-t0 = ResourceHeadDiffuse.1\n\tps-t1 = ResourceHeadLightMap.1\nendif\n\n[CommandListZhongliBody]\nif $swapvar == 0\n\tps-t0 = ResourceBodyDiffuse.0\nendif\n";

    #[test]
    fn data_loads() {
        assert_eq!(data().release_fix.steps.len(), 4);
        assert!(data().orfix.iter().any(|c| c.name == "Zhongli" && c.ib == "4c8480f5"));
        assert!(!data().old_shader_fixes.is_empty());
    }

    #[test]
    fn merged_mod_gets_nnfix_in_every_branch_of_its_command_lists() {
        let (out, r) = orfix(ZHONGLI_MERGED);
        assert_eq!(r.orfix_parts, 2);
        assert!(out.contains(
            "\tps-t1 = ResourceHeadLightMap.0\n\trun = CommandList\\global\\ORFix\\NNFix\nelse if $swapvar == 1\n"
        ));
        assert!(out.contains("\tps-t1 = ResourceHeadLightMap.1\n\trun = CommandList\\global\\ORFix\\NNFix\nendif"));
        assert!(out.contains("\tps-t0 = ResourceBodyDiffuse.0\n\trun = CommandList\\global\\ORFix\\NNFix\nendif"));
        // the override sections themselves are untouched
        assert!(out.contains("run = CommandListZhongliHead\n\n[TextureOverrideZhongliBody]"));
        // running again changes nothing
        let (again, r2) = orfix(&out);
        assert_eq!(again, out);
        assert_eq!(r2.orfix_parts, 0);
    }

    #[test]
    fn plain_section_gets_the_fix_after_its_slots_and_a_wrong_fix_is_swapped() {
        // Alhaitham's head has a normal map (ORFix); the mod carries NNFix by mistake
        let ini = "[TextureOverrideAlhaithamHead]\nhash = 639d1fb8\nmatch_first_index = 0\nib = ResourceIB\nps-t0 = ResourceNormal\nps-t1 = ResourceDiffuse\nps-t2 = ResourceLightMap\nrun = CommandList\\global\\ORFix\\NNFix\n\n[TextureOverrideAlhaithamBody]\nhash = 639d1fb8\nmatch_first_index = 28278\nps-t0 = ResourceNormal\n";
        let (out, r) = orfix(ini);
        assert_eq!(r.orfix_parts, 2);
        assert!(!out.contains("NNFix"));
        assert!(out.contains(
            "ps-t2 = ResourceLightMap\nrun = CommandList\\global\\ORFix\\ORFix\n\n[TextureOverrideAlhaithamBody]"
        ));
        assert!(out.ends_with("ps-t0 = ResourceNormal\nrun = CommandList\\global\\ORFix\\ORFix\n"));
    }

    #[test]
    fn unknown_parts_and_already_fixed_mods_are_left_alone() {
        let unknown = "[TextureOverrideThing]\nhash = 12345678\nmatch_first_index = 0\nps-t0 = R\n";
        assert_eq!(orfix(unknown).0, unknown);
        // Kazuha's body starts at 7923: a longer index that begins with those digits is another part
        let other_index = "[TextureOverrideKazuhaX]\nhash = 356cdbde\nmatch_first_index = 79230\nps-t0 = R\n";
        assert_eq!(orfix(other_index).0, other_index);
        let fixed = "[TextureOverrideKazuhaHead]\nhash = 356cdbde\nmatch_first_index = 0\nps-t0 = R\nrun = CommandList\\global\\ORFix\\NNFix\n";
        assert_eq!(orfix(fixed).0, fixed);
    }

    #[test]
    fn hashes_update_as_whole_words_in_version_order() {
        let mut r = FixReport::default();
        // Bennett's 4.4 position hash; the same digits inside a longer hex run stay put
        let s = "[TextureOverrideBennettPosition]\nhash = 993D1661\n; abc993d1661\n";
        let out = update_step(s.to_string(), &data().release_fix.steps[2], &mut r);
        assert_eq!(out, "[TextureOverrideBennettPosition]\nhash = 6cff51b4\n; abc993d1661\n");
        assert_eq!(r.hashes_updated, 1);
    }

    #[test]
    fn an_unchanged_hash_marks_the_step_done_and_old_shader_fixes_go() {
        let step = &data().release_fix.steps[1];
        let mut r = FixReport::default();
        // 1111 comes before the unchanged 3333 and is replaced; 4444 after it is not (the step ends there)
        let out = update_step("a = 11110000\nb = 33330000\nc = 44440000\n".into(), step, &mut r);
        assert_eq!(out, "a = 22220000\nb = 33330000\nc = 44440000\n");
        let (out, r) = orfix("[Constants]\n; legacy shader fix (test)\n[ResourceRefTest]\nx = 1\n");
        assert_eq!(out, "[Constants]\nx = 1\n");
        assert_eq!(r.old_shader_fixes, 1);
    }

    #[test]
    fn blend_remap_moves_weighted_indices_only() {
        let mut v = vec![];
        for w in [0.5f32, 0.5, 0.0, 0.0] {
            v.extend(w.to_le_bytes());
        }
        for i in [0u32, 2, 1, 99] {
            v.extend(i.to_le_bytes());
        }
        let out = remap_blend(&v, &[7, 6, 9]).unwrap();
        let idx = |k: usize| u32::from_le_bytes(out[16 + k * 4..20 + k * 4].try_into().unwrap());
        assert_eq!((idx(0), idx(1), idx(2), idx(3)), (7, 9, 1, 99));
        assert!(remap_blend(&v[..31], &[0]).is_none());
    }

    #[test]
    fn fix_tree_fixes_files_in_place_keeping_line_ends_and_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let mod_dir = dir.path().join("Zhongli");
        fs::create_dir_all(&mod_dir).unwrap();
        // CRLF and a cp1252 byte (0xE9) that isn't valid UTF-8
        let mut bytes = ZHONGLI_MERGED.replace('\n', "\r\n").into_bytes();
        bytes.extend(b"; caf\xE9\r\n");
        fs::write(mod_dir.join("merged.ini"), &bytes).unwrap();
        fs::write(mod_dir.join("desktop.ini"), b"[x]\r\n").unwrap();
        let r = fix_tree(dir.path(), data());
        assert_eq!(r.inis_changed, 1);
        assert_eq!(r.orfix_parts, 2);
        let out = fs::read(mod_dir.join("merged.ini")).unwrap();
        assert!(out.ends_with(b"; caf\xE9\r\n"));
        let text: String = out.iter().map(|&b| b as char).collect();
        assert!(text.contains("\trun = CommandList\\global\\ORFix\\NNFix\r\n"));
        assert!(!text.replace("\r\n", "").contains('\n'));
        assert_eq!(fix_tree(dir.path(), data()), FixReport::default());
        assert!(r.summary().unwrap().contains("ORFix added to 2 parts"));
    }

    #[test]
    fn a_remap_trigger_remaps_the_blend_once_unless_the_new_hash_is_there_too() {
        let venti = &data().release_fix.remaps.iter().find(|m| m.name == "Venti").unwrap();
        let new = final_hash(&venti.trigger, &data().release_fix.steps[1..]);
        assert_ne!(new, venti.trigger);
        let mut blend = vec![];
        for w in [1.0f32, 0.0, 0.0, 0.0] {
            blend.extend(w.to_le_bytes());
        }
        for i in [0u32, 0, 0, 0] {
            blend.extend(i.to_le_bytes());
        }
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("Venti.ini"), format!("[TextureOverrideVentiBlend]\nhash = {}\n", venti.trigger))
            .unwrap();
        fs::write(dir.path().join("Extra.ini"), format!("[TextureOverrideVentiX]\nhash = {}\n", venti.trigger))
            .unwrap();
        fs::write(dir.path().join("VentiBlend.buf"), &blend).unwrap();
        let r = fix_tree(dir.path(), data());
        assert_eq!(r.blends_remapped, 1);
        let out = fs::read(dir.path().join("VentiBlend.buf")).unwrap();
        assert_eq!(u32::from_le_bytes(out[16..20].try_into().unwrap()), venti.mapping[0]);
        assert!(fs::read_to_string(dir.path().join("Venti.ini")).unwrap().contains(&new));

        // a mod listing both the old and the new hash is for both versions: its blend stays
        let both = tempfile::tempdir().unwrap();
        fs::write(both.path().join("Venti.ini"), format!("hash = {}\nhash = {new}\n", venti.trigger)).unwrap();
        fs::write(both.path().join("VentiBlend.buf"), &blend).unwrap();
        let r = fix_tree(both.path(), data());
        assert_eq!(r.blends_remapped, 0);
        assert_eq!(r.remaps_skipped, vec!["Venti".to_string()]);
        assert_eq!(fs::read(both.path().join("VentiBlend.buf")).unwrap(), blend);
    }
}
