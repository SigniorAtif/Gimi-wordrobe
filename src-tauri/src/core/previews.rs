//! Preview images (SPEC §10): images from archives and mod folders, dropped or pasted images, GameBanana previews,
//! reordering (first = cover) and removal. Nothing here touches the network: `net.rs` downloads, this module checks
//! what arrived and stores it.

use super::app::AppCore;
use super::archive;
use super::error::{AppError, AppResult};
use super::fsutil;
use super::ini::Ini;
use super::model::{Preview, PreviewSource, Snapshot};
use super::paths;
use super::scanner::{self, ScanResult};
use super::state;
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Largest image accepted from a drop, a paste, an archive or GameBanana.
pub const MAX_IMAGE_BYTES: u64 = 25 * 1024 * 1024;
/// Most previews one skin keeps.
pub const MAX_PREVIEWS: usize = 30;
/// Most images taken from one GameBanana page.
pub const MAX_GB_IMAGES: usize = 12;
/// Most images taken from one archive or mod folder.
pub const MAX_ARCHIVE_IMAGES: usize = 12;

/// The image type by its first bytes (png, jpg, webp), whatever the file is called.
pub fn image_ext(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("jpg")
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("webp")
    } else {
        None
    }
}

/// The mod id in `https://gamebanana.com/mods/<id>` (same rule as the frontend's link check).
pub fn gamebanana_mod_id(url: &str) -> Option<u64> {
    let u = url.trim();
    let lower = u.to_ascii_lowercase();
    let rest = lower.strip_prefix("https://").or_else(|| lower.strip_prefix("http://"))?;
    let rest = rest.strip_prefix("www.").unwrap_or(rest);
    let id = rest.strip_prefix("gamebanana.com/mods/")?;
    let digits: String = id.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() || digits.len() > 12 {
        return None;
    }
    digits.parse().ok().filter(|n| *n > 0)
}

pub fn profile_url(mod_id: u64) -> String {
    format!("https://gamebanana.com/apiv11/Mod/{mod_id}/ProfilePage")
}

/// Only GameBanana's own image host over https; no userinfo, ports or odd characters that could point elsewhere.
pub fn allowed_image_url(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://") else { return false };
    if url.chars().any(|c| c.is_whitespace() || c.is_control() || c == '\\') {
        return false;
    }
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    host.eq_ignore_ascii_case("images.gamebanana.com")
}

/// What a GameBanana mod page offers (SPEC §10), read from `apiv11/Mod/<id>/ProfilePage`.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GameBananaInfo {
    pub mod_id: u64,
    pub name: String,
    pub author: Option<String>,
    pub version: Option<String>,
    /// GameBanana hides the page by default or rates it for nudity / sexual content.
    pub nsfw: bool,
    /// Full-size image URLs in GameBanana's order (their first is the mod's thumbnail).
    pub images: Vec<String>,
}

fn text(v: &Value, ptr: &str) -> Option<String> {
    v.pointer(ptr).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

/// Content ratings that mean "18+" for this app; others (blood, crude humour) don't hide a skin.
const NSFW_RATINGS: [&str; 5] = ["sa", "pn", "nu", "st", "ft"];

/// Read a ProfilePage answer. The shape was checked live on 2026-10-20 (see DECISIONS M7).
pub fn parse_profile(mod_id: u64, v: &Value) -> AppResult<GameBananaInfo> {
    if let Some(code) = v.get("_sErrorCode").and_then(Value::as_str) {
        let msg = v.get("_sErrorMessage").and_then(Value::as_str).unwrap_or(code);
        return Err(AppError::new("gamebanana", format!("GameBanana says: {msg}")));
    }
    let flag = |k: &str| v.get(k).and_then(Value::as_bool).unwrap_or(false);
    if flag("_bIsPrivate") || flag("_bIsTrashed") || flag("_bIsWithheld") {
        return Err(AppError::new("gamebanana", "That mod is private or was taken down on GameBanana."));
    }
    let name = text(v, "/_sName")
        .ok_or_else(|| AppError::new("gamebanana", "GameBanana sent an answer this app doesn't understand."))?;
    let rated = v
        .get("_aContentRatings")
        .and_then(Value::as_object)
        .is_some_and(|o| o.keys().any(|k| NSFW_RATINGS.contains(&k.as_str())));
    let hidden = matches!(v.get("_sInitialVisibility").and_then(Value::as_str), Some("hide" | "warn"));
    let mut images: Vec<String> = vec![];
    for img in v.pointer("/_aPreviewMedia/_aImages").and_then(Value::as_array).into_iter().flatten() {
        if img.get("_sType").and_then(Value::as_str).is_some_and(|t| t != "screenshot") {
            continue;
        }
        let (Some(base), Some(file)) = (text(img, "/_sBaseUrl"), text(img, "/_sFile")) else { continue };
        if file.contains(['/', '\\']) || file.contains("..") {
            continue;
        }
        let url = format!("{}/{file}", base.trim_end_matches('/'));
        if allowed_image_url(&url) && !images.contains(&url) {
            images.push(url);
        }
        if images.len() == MAX_GB_IMAGES {
            break;
        }
    }
    Ok(GameBananaInfo {
        mod_id,
        name,
        author: text(v, "/_aSubmitter/_sName"),
        version: text(v, "/_sVersion"),
        nsfw: rated || hidden,
        images,
    })
}

/// `order` first (unknown and repeated files ignored), then any previews it left out, in their old order.
/// The first preview is the cover.
pub fn reorder(previews: &[Preview], order: &[String]) -> Vec<Preview> {
    let mut next: Vec<Preview> = vec![];
    for f in order {
        if !next.iter().any(|n| &n.file == f)
            && let Some(p) = previews.iter().find(|p| &p.file == f)
        {
            next.push(p.clone());
        }
    }
    for p in previews {
        if !next.iter().any(|n| n.file == p.file) {
            next.push(p.clone());
        }
    }
    next
}

/// "%E5%A4%A9" -> "天": the skin id of a pasted image travels URI-encoded in a request header.
pub fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = s.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// "previews/<skin>/07.png" -> 7, for numbering new files after the existing ones.
fn number_of(file: &str) -> u32 {
    let name = file.rsplit('/').next().unwrap_or(file);
    name.split('.').next().and_then(|n| n.parse().ok()).unwrap_or(0)
}

/// A skin id is a folder name under previews/: one plain path component.
fn safe_component(id: &str) -> bool {
    !id.is_empty()
        && id != "."
        && id != ".."
        && !id.contains(['/', '\\', ':'])
        && !id.chars().any(char::is_control)
        && !paths::is_reserved_name(id)
}

/// Preview candidates among the files below `dir` (relative to it), minus the textures its inis reference via
/// `filename =`, texture-like names and UI assets, preview-named first (SPEC §10). Symlinked inis are not read.
pub fn folder_previews(dir: &Path) -> Vec<String> {
    let files = archive::files_below(dir);
    let mut scan = ScanResult::default();
    for rel in &files {
        let name = rel.rsplit('/').next().unwrap_or(rel);
        if !name.to_ascii_lowercase().ends_with(".ini") || paths::is_junk_name(name) {
            continue;
        }
        let plain = |p: &PathBuf| fs::symlink_metadata(p).is_ok_and(|m| m.is_file() && !fsutil::is_link(&m));
        if let Some(ini) = paths::join_rel(dir, rel).filter(plain).and_then(|p| Ini::read(&p).ok()) {
            scan.inis.push(scanner::ini_facts(&ini, rel));
        }
    }
    archive::preview_candidates(&files, &scan)
}

/// What happened to one image handed to a [`PreviewWriter`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stored {
    Added,
    /// The skin already has these exact bytes.
    Duplicate,
    /// Not a PNG, JPG or WebP (by content), over the size limit, or not a plain file.
    NotAnImage,
}

/// Writes images into `<Library>/previews/<skinId>/` as `01.png`, `02.jpg` …, numbered after the highest number
/// already in use there. It never replaces a file, skips images the skin already has, names files by their content
/// type (a `.png` that is really a JPG becomes `.jpg`), and can take back exactly what it wrote.
pub struct PreviewWriter {
    skin_id: String,
    dir: PathBuf,
    next: u32,
    /// The skin's existing preview files plus the ones written so far, to skip duplicates.
    known: Vec<PathBuf>,
    source: PreviewSource,
    written: Vec<(Preview, PathBuf)>,
}

impl PreviewWriter {
    pub fn new(lib: &Path, skin_id: &str, existing: &[Preview], source: PreviewSource) -> AppResult<Self> {
        if !safe_component(skin_id) {
            return Err(AppError::new("bad_id", "This skin's id can't be used as a folder name."));
        }
        let dir = lib.join("previews").join(skin_id);
        let known: Vec<PathBuf> = existing.iter().filter_map(|p| paths::join_rel(lib, &p.file)).collect();
        let mut next = existing.iter().map(|p| number_of(&p.file)).max().unwrap_or(0);
        if let Ok(rd) = fs::read_dir(&dir) {
            for e in rd.flatten() {
                next = next.max(number_of(&e.file_name().to_string_lossy()));
            }
        }
        Ok(Self { skin_id: skin_id.to_string(), dir, next, known, source, written: vec![] })
    }

    fn has(&self, bytes: &[u8]) -> bool {
        self.known.iter().any(|p| {
            fs::metadata(p).is_ok_and(|m| m.len() == bytes.len() as u64) && fs::read(p).is_ok_and(|b| b == bytes)
        })
    }

    pub fn push(&mut self, bytes: &[u8]) -> AppResult<Stored> {
        let Some(ext) = image_ext(bytes).filter(|_| bytes.len() as u64 <= MAX_IMAGE_BYTES) else {
            return Ok(Stored::NotAnImage);
        };
        if self.has(bytes) {
            return Ok(Stored::Duplicate);
        }
        fs::create_dir_all(&self.dir)?;
        loop {
            self.next += 1;
            if self.next > 99_999 {
                return Err(AppError::new("too_many", "This skin's previews folder is full of numbered files."));
            }
            let name = format!("{:02}.{ext}", self.next);
            let path = self.dir.join(&name);
            // create_new: a file that is already there (from anything) is never replaced
            match fs::OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(mut f) => {
                    if let Err(e) = f.write_all(bytes).and_then(|_| f.sync_all()) {
                        drop(f);
                        let _ = fs::remove_file(&path);
                        return Err(e.into());
                    }
                    self.known.push(path.clone());
                    let file = format!("previews/{}/{name}", self.skin_id);
                    self.written.push((Preview { file, source: self.source }, path));
                    return Ok(Stored::Added);
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e.into()),
            }
        }
    }

    /// Copy one image file (an archive's or mod folder's preview, a picked or dropped image). Symlinks are refused.
    pub fn push_file(&mut self, path: &Path) -> AppResult<Stored> {
        let Ok(meta) = fs::symlink_metadata(path) else { return Ok(Stored::NotAnImage) };
        if !meta.is_file() || meta.len() > MAX_IMAGE_BYTES {
            return Ok(Stored::NotAnImage);
        }
        self.push(&fs::read(path)?)
    }

    pub fn len(&self) -> usize {
        self.written.len()
    }

    pub fn is_empty(&self) -> bool {
        self.written.is_empty()
    }

    pub fn previews(&self) -> Vec<Preview> {
        self.written.iter().map(|(p, _)| p.clone()).collect()
    }

    /// Remove the files this writer created (nothing that was there before), and the folder if that leaves it empty.
    pub fn undo(&self) {
        for (_, p) in &self.written {
            let _ = fs::remove_file(p);
        }
        let _ = fs::remove_dir(&self.dir);
    }
}

/// The answer to "fetch previews from GameBanana".
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewFetch {
    pub snapshot: Snapshot,
    /// New previews stored (images the skin already had are not counted).
    pub added: usize,
    /// Images that failed to download.
    pub failed: usize,
    /// GameBanana rates the mod 18+, so the skin was marked NSFW (hidden by mistake beats shown by mistake).
    pub marked_nsfw: bool,
}

fn unknown_skin() -> AppError {
    AppError::new("unknown_skin", "That skin no longer exists.")
}

impl AppCore {
    /// The Library folder, once the skin is known to exist.
    fn preview_lib(&self, skin_id: &str) -> AppResult<PathBuf> {
        let lib = self.library_dir().ok_or_else(|| AppError::new("no_library", "Set the Library folder first."))?;
        if self.library.skin(skin_id).is_none() {
            return Err(unknown_skin());
        }
        Ok(lib)
    }

    /// Run `fill` against a writer for the skin, then list what it stored after the skin's previews (the cover only
    /// changes if the skin had none) and save. Anything written is removed again if a step fails.
    fn store_previews(
        &mut self,
        skin_id: &str,
        source: PreviewSource,
        fill: impl FnOnce(&mut PreviewWriter, usize) -> AppResult<()>,
    ) -> AppResult<usize> {
        let lib = self.preview_lib(skin_id)?;
        let existing = self.library.skin(skin_id).map(|s| s.previews.clone()).unwrap_or_default();
        if existing.len() >= MAX_PREVIEWS {
            return Err(AppError::new(
                "too_many",
                format!("This skin already has {MAX_PREVIEWS} previews. Remove one first."),
            ));
        }
        let mut w = PreviewWriter::new(&lib, skin_id, &existing, source)?;
        if let Err(e) = fill(&mut w, MAX_PREVIEWS - existing.len()) {
            w.undo();
            return Err(e);
        }
        if w.is_empty() {
            return Ok(0);
        }
        let before = self.library.clone();
        if let Some(s) = self.library.skin_mut(skin_id) {
            s.previews.extend(w.previews());
        }
        if let Err(e) = self.save_library() {
            self.library = before;
            w.undo();
            return Err(e);
        }
        Ok(w.len())
    }

    /// Store images as the skin's next previews. Images it already has are skipped. Returns how many were added;
    /// refuses with `not_an_image` when nothing was added because nothing was an image.
    pub fn add_previews(&mut self, skin_id: &str, images: &[Vec<u8>], source: PreviewSource) -> AppResult<usize> {
        let mut refused = 0;
        let added = self.store_previews(skin_id, source, |w, room| {
            for bytes in images {
                if w.len() >= room {
                    break;
                }
                if w.push(bytes)? == Stored::NotAnImage {
                    refused += 1;
                }
            }
            Ok(())
        })?;
        if added == 0 && refused > 0 {
            return Err(AppError::new("not_an_image", "That isn't a PNG, JPG or WebP image (or it's over 25 MB)."));
        }
        Ok(added)
    }

    /// An image dropped on a card or the gallery, or picked with "Choose an image".
    pub fn add_preview_file(&mut self, skin_id: &str, path: &Path) -> AppResult<Snapshot> {
        let meta =
            fs::metadata(path).map_err(|e| AppError::new("io", format!("Can't read {}: {e}", path.display())))?;
        if !meta.is_file() {
            return Err(AppError::new("not_an_image", "Drop an image file (PNG, JPG or WebP)."));
        }
        if meta.len() > MAX_IMAGE_BYTES {
            return Err(AppError::new("not_an_image", "That image is over 25 MB."));
        }
        let bytes = fs::read(path)?;
        self.add_preview_bytes(skin_id, &bytes)
    }

    /// A pasted image (Ctrl+V): the bytes come straight from the clipboard.
    pub fn add_preview_bytes(&mut self, skin_id: &str, bytes: &[u8]) -> AppResult<Snapshot> {
        if self.add_previews(skin_id, &[bytes.to_vec()], PreviewSource::User)? == 0 {
            return Err(AppError::new("duplicate", "That image is already one of this skin's previews."));
        }
        Ok(self.snapshot())
    }

    /// Previews already inside the skin's own folders, wherever they are (Mods, DISABLED_, stash), with the archive
    /// filters (SPEC §10). Installed mods have no archive to take them from. Mods is only read. A folder that is (or
    /// sits inside) a symlink or junction is skipped: it could lead anywhere on disk.
    pub fn find_folder_previews(&mut self, skin_id: &str) -> AppResult<(Snapshot, usize)> {
        let (mods, stash) = self.roots()?;
        let skin = self.library.skin(skin_id).cloned().ok_or_else(unknown_skin)?;
        let mut files: Vec<PathBuf> = vec![];
        for f in &skin.folders {
            if paths::has_parent_ref(f) || f.contains(':') {
                continue;
            }
            let Some(dir) = state::resolve_ci(&mods, f)
                .map(|p| (p, &mods))
                .or_else(|| state::find_disabled(&mods, f).map(|(p, _)| (p, &mods)))
                .or_else(|| state::resolve_ci(&stash, f).map(|p| (p, &stash)))
                .filter(|(p, root)| p.is_dir() && !fsutil::leaves_root(root, p))
                .map(|(p, _)| p)
            else {
                continue;
            };
            files.extend(folder_previews(&dir).iter().filter_map(|rel| paths::join_rel(&dir, rel)));
        }
        let added = self.store_previews(skin_id, PreviewSource::Archive, |w, room| {
            for p in &files {
                if w.len() >= room.min(MAX_ARCHIVE_IMAGES) {
                    break;
                }
                w.push_file(p)?;
            }
            Ok(())
        })?;
        Ok((self.snapshot(), added))
    }

    /// Remove one preview: library.json first, then the file goes to the Recycle Bin (never a hard delete).
    pub fn remove_preview(
        &mut self,
        skin_id: &str,
        file: &str,
        delete: &dyn Fn(&Path) -> std::io::Result<()>,
    ) -> AppResult<Snapshot> {
        let lib = self.preview_lib(skin_id)?;
        let skin = self.library.skin(skin_id).ok_or_else(unknown_skin)?;
        if !skin.previews.iter().any(|p| p.file == file) {
            return Err(AppError::new("unknown_preview", "That image is no longer one of this skin's previews."));
        }
        // only files inside this skin's own previews folder are ever deleted
        let own = format!("previews/{skin_id}/");
        let path = file
            .strip_prefix(&own)
            .filter(|rest| safe_component(rest))
            .filter(|_| safe_component(skin_id))
            .and_then(|_| paths::join_rel(&lib, file));
        let before = self.library.clone();
        if let Some(s) = self.library.skin_mut(skin_id) {
            s.previews.retain(|p| p.file != file);
        }
        if let Err(e) = self.save_library() {
            self.library = before;
            return Err(e);
        }
        if let Some(p) = path.filter(|p| p.is_file())
            && let Err(e) = delete(&p)
        {
            self.library = before;
            let _ = self.save_library();
            return Err(AppError::new("trash_failed", format!("Couldn't move the image to the Recycle Bin: {e}")));
        }
        Ok(self.snapshot())
    }

    /// The skin's GameBanana link, read before fetching outside the lock.
    pub fn gamebanana_url(&self, skin_id: &str) -> AppResult<String> {
        let skin = self.library.skin(skin_id).ok_or_else(unknown_skin)?;
        skin.game_banana_url
            .clone()
            .filter(|u| gamebanana_mod_id(u).is_some())
            .ok_or_else(|| AppError::new("no_link", "Add the skin's GameBanana link first."))
    }

    /// Store downloaded GameBanana previews and fill in the author and version when the skin has none. A mod that
    /// GameBanana rates 18+ marks the skin NSFW. Refused if the skin's link changed while downloading.
    pub fn add_gamebanana_previews(
        &mut self,
        skin_id: &str,
        info: &GameBananaInfo,
        images: &[Vec<u8>],
        failed: usize,
    ) -> AppResult<PreviewFetch> {
        let skin = self.library.skin(skin_id).ok_or_else(unknown_skin)?;
        if skin.game_banana_url.as_deref().and_then(gamebanana_mod_id) != Some(info.mod_id) {
            return Err(AppError::new(
                "link_changed",
                "The skin's GameBanana link changed while its previews were downloading. Retry.",
            ));
        }
        let before = self.library.clone();
        let mut changed = false;
        let mut marked_nsfw = false;
        if let Some(s) = self.library.skin_mut(skin_id) {
            if s.author.is_none() && info.author.is_some() {
                s.author = info.author.clone();
                changed = true;
            }
            if s.version.is_none() && info.version.is_some() {
                s.version = info.version.clone();
                changed = true;
            }
            if info.nsfw && !s.nsfw {
                s.nsfw = true;
                marked_nsfw = true;
                changed = true;
            }
        }
        // the previews' save carries the edits above; save on our own only when no preview was new
        let added = match self.add_previews(skin_id, images, PreviewSource::Gamebanana) {
            Ok(n) => n,
            Err(e) => {
                self.library = before;
                return Err(e);
            }
        };
        if added == 0
            && changed
            && let Err(e) = self.save_library()
        {
            self.library = before;
            return Err(e);
        }
        Ok(PreviewFetch { snapshot: self.snapshot(), added, failed, marked_nsfw })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::app::tests::{configured_core, fixture_world};
    use serde_json::json;
    use std::cell::RefCell;

    struct World {
        _cfg: tempfile::TempDir,
        root: tempfile::TempDir,
        mods: PathBuf,
        lib: PathBuf,
    }

    /// A configured core over the fixtures, plus the id of one of its skins.
    fn world() -> (World, AppCore, String) {
        let cfg = tempfile::tempdir().unwrap();
        let (root, mods, lib) = fixture_world();
        let core = configured_core(cfg.path(), &mods, &lib);
        let id = core.library.skins.first().expect("fixture skins are in the library").id.clone();
        (World { _cfg: cfg, root, mods, lib }, core, id)
    }

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR tiny";
    const JPG: &[u8] = &[0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3];
    const WEBP: &[u8] = b"RIFF\x10\0\0\0WEBPVP8 ";

    fn files_of(core: &AppCore, id: &str) -> Vec<String> {
        core.library.skin(id).unwrap().previews.iter().map(|p| p.file.clone()).collect()
    }

    fn gb_info(mod_id: u64) -> GameBananaInfo {
        GameBananaInfo {
            mod_id,
            name: "Vibrant Venti".into(),
            author: Some("kyomono".into()),
            version: Some("1.2".into()),
            nsfw: false,
            images: vec![],
        }
    }

    #[test]
    fn sniffs_image_types_and_reads_mod_ids() {
        assert_eq!(image_ext(PNG), Some("png"));
        assert_eq!(image_ext(JPG), Some("jpg"));
        assert_eq!(image_ext(WEBP), Some("webp"));
        assert_eq!(image_ext(b"GIF89a"), None);
        assert_eq!(image_ext(b"<svg"), None);
        assert_eq!(gamebanana_mod_id("https://gamebanana.com/mods/729570"), Some(729570));
        assert_eq!(gamebanana_mod_id(" https://www.GameBanana.com/mods/12?x=1 "), Some(12));
        assert_eq!(gamebanana_mod_id("https://gamebanana.com/mods/0"), None);
        assert_eq!(gamebanana_mod_id("https://gamebanana.com.evil.io/mods/12"), None);
        assert_eq!(gamebanana_mod_id("https://example.com/gamebanana.com/mods/12"), None);
        assert!(allowed_image_url("https://images.gamebanana.com/img/ss/mods/6ad5aace103f3.jpg"));
        assert!(!allowed_image_url("http://images.gamebanana.com/img/ss/mods/a.jpg"));
        assert!(!allowed_image_url("https://images.gamebanana.com@evil.io/a.jpg"));
        assert!(!allowed_image_url("https://images.gamebanana.com.evil.io/a.jpg"));
        assert!(!allowed_image_url("https://images.gamebanana.com:8443/a.jpg"));
        assert!(!allowed_image_url("https://images.gamebanana.com\\@evil.io/a.jpg"));
    }

    #[test]
    fn decodes_the_pasted_skin_id_header() {
        assert_eq!(percent_decode("mona--starry").as_deref(), Some("mona--starry"));
        assert_eq!(percent_decode("%E5%A4%A9-x").as_deref(), Some("天-x"));
        assert_eq!(percent_decode("bad%2"), None);
        assert_eq!(percent_decode("bad%zz"), None);
        assert_eq!(percent_decode("%FF"), None, "not UTF-8");
    }

    #[test]
    fn parses_the_live_profile_shape() {
        // trimmed from a real apiv11 ProfilePage answer (2026-10-20)
        let v = json!({
            "_idRow": 729570,
            "_sName": "Vibrant Venti",
            "_sVersion": "",
            "_bIsPrivate": false, "_bIsTrashed": false, "_bIsWithheld": false,
            "_sInitialVisibility": "show",
            "_aSubmitter": { "_idRow": 3333578, "_sName": "kyomono" },
            "_aPreviewMedia": { "_aImages": [
                { "_sType": "screenshot", "_sBaseUrl": "https://images.gamebanana.com/img/ss/mods", "_sCaption": "Thumbnail", "_sFile": "6ad5aace103f3.jpg", "_sFile220": "220-90_6ad5aace103f3.jpg" },
                { "_sType": "screenshot", "_sBaseUrl": "https://images.gamebanana.com/img/ss/mods", "_sFile": "6ad5aad31c3b3.jpg" },
                { "_sType": "screenshot", "_sBaseUrl": "https://images.gamebanana.com/img/ss/mods", "_sFile": "6ad5aad31c3b3.jpg" },
                { "_sType": "screenshot", "_sBaseUrl": "https://evil.io/img", "_sFile": "x.jpg" },
                { "_sType": "screenshot", "_sBaseUrl": "https://images.gamebanana.com/img/ss/mods", "_sFile": "../x.jpg" },
                { "_sType": "video", "_sBaseUrl": "https://images.gamebanana.com/img/ss/mods", "_sFile": "v.jpg" }
            ]}
        });
        let info = parse_profile(729570, &v).unwrap();
        assert_eq!(info.name, "Vibrant Venti");
        assert_eq!(info.author.as_deref(), Some("kyomono"));
        assert_eq!(info.version, None);
        assert!(!info.nsfw);
        assert_eq!(
            info.images,
            vec![
                "https://images.gamebanana.com/img/ss/mods/6ad5aace103f3.jpg",
                "https://images.gamebanana.com/img/ss/mods/6ad5aad31c3b3.jpg"
            ]
        );
        let nsfw =
            json!({ "_sName": "x", "_sInitialVisibility": "hide", "_aContentRatings": { "pn": "Partial Nudity" } });
        assert!(parse_profile(1, &nsfw).unwrap().nsfw);
        let gore =
            json!({ "_sName": "x", "_sInitialVisibility": "show", "_aContentRatings": { "bg": "Blood and Gore" } });
        assert!(!parse_profile(1, &gore).unwrap().nsfw);
        let missing = json!({ "_sErrorCode": "NO_SUCH_RECORD", "_sErrorMessage": "This Mod doesn't exist" });
        assert_eq!(parse_profile(9, &missing).unwrap_err().message, "GameBanana says: This Mod doesn't exist");
        assert!(parse_profile(9, &json!({ "_sName": "x", "_bIsTrashed": true })).is_err());
        assert!(parse_profile(9, &json!({ "unexpected": true })).is_err());
    }

    #[test]
    fn reorder_puts_the_chosen_cover_first_and_keeps_the_rest() {
        let p = |f: &str| Preview { file: f.into(), source: PreviewSource::User };
        let list = vec![p("a"), p("b"), p("c"), p("d")];
        let files = |v: Vec<Preview>| v.into_iter().map(|p| p.file).collect::<Vec<_>>();
        // cover only: the rest keep their order
        assert_eq!(files(reorder(&list, &["c".into()])), ["c", "a", "b", "d"]);
        // full order, with an unknown and a repeated file ignored
        let order: Vec<String> = ["d", "x", "b", "d", "a", "c"].iter().map(|s| s.to_string()).collect();
        assert_eq!(files(reorder(&list, &order)), ["d", "b", "a", "c"]);
        assert_eq!(files(reorder(&list, &[])), ["a", "b", "c", "d"]);
        assert!(reorder(&[], &["a".into()]).is_empty());
    }

    #[test]
    fn reordering_through_update_skin_is_saved() {
        let (w, mut core, id) = world();
        core.add_previews(&id, &[PNG.to_vec(), JPG.to_vec(), WEBP.to_vec()], PreviewSource::User).unwrap();
        let files = files_of(&core, &id);
        let patch = crate::core::app::SkinPatch { preview_order: Some(vec![files[2].clone()]), ..Default::default() };
        core.update_skin(&id, patch).unwrap();
        let want = vec![files[2].clone(), files[0].clone(), files[1].clone()];
        assert_eq!(files_of(&core, &id), want);
        let saved = crate::core::library::load(&w.lib).unwrap();
        assert_eq!(saved.skin(&id).unwrap().previews.iter().map(|p| p.file.clone()).collect::<Vec<_>>(), want);
    }

    #[test]
    fn stores_dropped_and_pasted_images_without_overwriting() {
        let (w, mut core, id) = world();
        let lib = w.lib.clone();
        // something already sits where 01 would go: it is kept and numbering moves on
        let dir = lib.join("previews").join(&id);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("01.png"), b"someone else's file").unwrap();
        let img = w.root.path().join("shot.png");
        fs::write(&img, PNG).unwrap();
        let snap = core.add_preview_file(&id, &img).unwrap();
        let skin = snap.library.skins.iter().find(|s| s.id == id).unwrap();
        assert_eq!(skin.previews.last().unwrap().file, format!("previews/{id}/02.png"));
        assert_eq!(skin.previews.last().unwrap().source, PreviewSource::User);
        assert_eq!(fs::read(dir.join("01.png")).unwrap(), b"someone else's file");
        assert_eq!(fs::read(dir.join("02.png")).unwrap(), PNG);
        // the same image again is not added twice
        assert_eq!(core.add_preview_file(&id, &img).unwrap_err().code, "duplicate");
        // a paste; a JPG called .png is stored as .jpg
        core.add_preview_bytes(&id, JPG).unwrap();
        assert!(dir.join("03.jpg").is_file());
        // not an image (an .ini renamed .png, an svg)
        let fake = w.root.path().join("fake.png");
        fs::write(&fake, "[TextureOverride]").unwrap();
        assert_eq!(core.add_preview_file(&id, &fake).unwrap_err().code, "not_an_image");
        assert_eq!(core.add_preview_bytes(&id, b"<svg/>").unwrap_err().code, "not_an_image");
        // it's all in library.json
        let saved = crate::core::library::load(&lib).unwrap();
        assert_eq!(saved.skin(&id).unwrap().previews.len(), 2);
        assert_eq!(core.add_preview_bytes("nope", PNG).unwrap_err().code, "unknown_skin");
    }

    #[test]
    fn a_full_skin_refuses_more_and_a_failed_save_leaves_no_files() {
        let (_w, mut core, id) = world();
        let many: Vec<Vec<u8>> = (0..MAX_PREVIEWS + 3).map(|i| [PNG, &i.to_le_bytes()[..]].concat()).collect();
        assert_eq!(core.add_previews(&id, &many, PreviewSource::User).unwrap(), MAX_PREVIEWS);
        assert_eq!(core.add_preview_bytes(&id, JPG).unwrap_err().code, "too_many");
        // library.json can't be saved (its temp file is blocked by a folder): the files written for it are taken back
        let (w2, mut other, id2) = world();
        fs::create_dir_all(w2.lib.join("library.json.tmp")).unwrap();
        assert!(other.add_previews(&id2, &[PNG.to_vec()], PreviewSource::User).is_err());
        assert!(other.library.skin(&id2).unwrap().previews.is_empty());
        assert!(!w2.lib.join("previews").join(&id2).exists());
    }

    #[test]
    fn writer_numbers_after_existing_files_and_undoes_only_its_own() {
        let t = tempfile::tempdir().unwrap();
        let dir = t.path().join("previews").join("s");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("07.png"), PNG).unwrap();
        fs::write(dir.join("notes.txt"), "keep").unwrap();
        let existing = vec![Preview { file: "previews/s/07.png".into(), source: PreviewSource::Archive }];
        let mut w = PreviewWriter::new(t.path(), "s", &existing, PreviewSource::User).unwrap();
        assert_eq!(w.push(PNG).unwrap(), Stored::Duplicate, "the skin already has it");
        assert_eq!(w.push(JPG).unwrap(), Stored::Added);
        assert_eq!(w.push(JPG).unwrap(), Stored::Duplicate, "nor twice from one batch");
        assert_eq!(w.push(b"GIF89a").unwrap(), Stored::NotAnImage);
        assert_eq!(w.push_file(&dir.join("notes.txt")).unwrap(), Stored::NotAnImage);
        assert_eq!(w.push_file(&t.path().join("missing.png")).unwrap(), Stored::NotAnImage);
        assert_eq!(w.previews(), vec![Preview { file: "previews/s/08.jpg".into(), source: PreviewSource::User }]);
        w.undo();
        assert!(!dir.join("08.jpg").exists());
        assert!(dir.join("07.png").is_file() && dir.join("notes.txt").is_file());
        for bad in ["", "..", "a/b", "a\\b", "c:x", "CON"] {
            assert!(PreviewWriter::new(t.path(), bad, &[], PreviewSource::User).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn removes_a_preview_to_the_bin_and_keeps_others() {
        let (w, mut core, id) = world();
        core.add_previews(&id, &[PNG.to_vec(), JPG.to_vec(), WEBP.to_vec()], PreviewSource::User).unwrap();
        let files = files_of(&core, &id);
        let binned = RefCell::new(vec![]);
        let bin = |p: &Path| {
            binned.borrow_mut().push(p.to_path_buf());
            Ok(())
        };
        let snap = core.remove_preview(&id, &files[1], &bin).unwrap();
        let left: Vec<&str> =
            snap.library.skins.iter().find(|s| s.id == id).unwrap().previews.iter().map(|p| p.file.as_str()).collect();
        assert_eq!(left, vec![files[0].as_str(), files[2].as_str()]);
        assert_eq!(binned.borrow().as_slice(), &[w.lib.join(&files[1])]);
        // a failing Recycle Bin keeps the preview listed
        let broken = |_: &Path| Err(std::io::Error::other("bin unavailable"));
        assert_eq!(core.remove_preview(&id, &files[0], &broken).unwrap_err().code, "trash_failed");
        assert!(core.library.skin(&id).unwrap().previews.iter().any(|p| p.file == files[0]));
        assert_eq!(crate::core::library::load(&w.lib).unwrap().skin(&id).unwrap().previews.len(), 2);
        // never a file outside the skin's own folder, even if library.json lists one
        let outside = "previews/../library.json".to_string();
        core.library
            .skin_mut(&id)
            .unwrap()
            .previews
            .push(Preview { file: outside.clone(), source: PreviewSource::User });
        let calls = RefCell::new(0);
        let count = |_: &Path| {
            *calls.borrow_mut() += 1;
            Ok(())
        };
        core.remove_preview(&id, &outside, &count).unwrap();
        assert_eq!(*calls.borrow(), 0);
        assert!(w.lib.join("library.json").is_file());
    }

    #[test]
    fn gamebanana_previews_fill_author_mark_nsfw_and_skip_known_images() {
        let (_w, mut core, id) = world();
        {
            let s = core.library.skin_mut(&id).unwrap();
            s.author = None;
            s.version = None;
            s.nsfw = false;
            s.game_banana_url = Some("https://gamebanana.com/mods/1".into());
        }
        assert_eq!(core.gamebanana_url(&id).unwrap(), "https://gamebanana.com/mods/1");
        let out = core.add_gamebanana_previews(&id, &gb_info(1), &[PNG.to_vec(), JPG.to_vec()], 1).unwrap();
        assert_eq!((out.added, out.failed, out.marked_nsfw), (2, 1, false));
        let skin = out.snapshot.library.skins.iter().find(|s| s.id == id).unwrap();
        assert_eq!(skin.author.as_deref(), Some("kyomono"));
        assert_eq!(skin.version.as_deref(), Some("1.2"));
        assert!(skin.previews.iter().all(|p| p.source == PreviewSource::Gamebanana));
        // fetching again adds nothing new; an 18+ rating marks the skin NSFW and that is saved too
        let mut rated = gb_info(1);
        rated.nsfw = true;
        let again = core.add_gamebanana_previews(&id, &rated, &[PNG.to_vec(), JPG.to_vec()], 0).unwrap();
        assert_eq!((again.added, again.marked_nsfw), (0, true));
        assert!(crate::core::library::load(&_w.lib).unwrap().skin(&id).unwrap().nsfw);
        // the link changed to another mod meanwhile: nothing is stored
        let stale = core.add_gamebanana_previews(&id, &gb_info(2), &[WEBP.to_vec()], 0).unwrap_err();
        assert_eq!(stale.code, "link_changed");
        assert_eq!(files_of(&core, &id).len(), 2);
        core.library.skin_mut(&id).unwrap().game_banana_url = None;
        assert_eq!(core.gamebanana_url(&id).unwrap_err().code, "no_link");
    }

    #[test]
    fn finds_previews_in_the_skins_own_folder_but_never_its_textures() {
        let (w, mut core, id) = world();
        let skin = core.library.skin(&id).unwrap().clone();
        let dir = state::resolve_ci(&w.mods, &skin.folders[0])
            .or_else(|| state::find_disabled(&w.mods, &skin.folders[0]).map(|(p, _)| p))
            .or_else(|| state::resolve_ci(&w.lib.join("stash"), &skin.folders[0]))
            .expect("fixture skin folder");
        let before = crate::core::apply::tests::tree(&w.mods);
        fs::write(dir.join("textures.ini"), "[ResourceBody]\nfilename = Tex\\Body.png\n").unwrap();
        fs::create_dir_all(dir.join("Tex")).unwrap();
        fs::write(dir.join("Tex/Body.png"), [PNG, &b"body"[..]].concat()).unwrap();
        fs::write(dir.join("HairDiffuse.png"), [PNG, &b"hair"[..]].concat()).unwrap();
        fs::write(dir.join("menu_btn.png"), [PNG, &b"menu"[..]].concat()).unwrap();
        fs::write(dir.join("shot.jpg"), JPG).unwrap();
        fs::write(dir.join("preview.png"), PNG).unwrap();
        fs::write(dir.join("fake preview.png"), "not an image").unwrap();
        let mut found = folder_previews(&dir);
        found.sort();
        assert_eq!(found, vec!["fake preview.png", "preview.png", "shot.jpg"]);
        let (snap, added) = core.find_folder_previews(&id).unwrap();
        assert_eq!(added, 2);
        let skin = snap.library.skins.iter().find(|s| s.id == id).unwrap();
        // preview-named first, so it becomes the cover
        assert_eq!(fs::read(w.lib.join(&skin.previews[0].file)).unwrap(), PNG);
        assert!(skin.previews.iter().all(|p| p.source == PreviewSource::Archive));
        // a second look finds nothing new; Mods only gained the files this test wrote
        assert_eq!(core.find_folder_previews(&id).unwrap().1, 0);
        let after = crate::core::apply::tests::tree(&w.mods);
        assert!(before.iter().all(|f| after.contains(f)), "nothing in Mods was moved or changed");
    }

    #[cfg(unix)]
    #[test]
    fn never_follows_a_symlinked_skin_folder_or_ini() {
        use std::os::unix::fs::symlink;
        let (w, mut core, id) = world();
        let skin = core.library.skin(&id).unwrap().clone();
        let dir = state::resolve_ci(&w.mods, &skin.folders[0])
            .or_else(|| state::find_disabled(&w.mods, &skin.folders[0]).map(|(p, _)| p))
            .or_else(|| state::resolve_ci(&w.lib.join("stash"), &skin.folders[0]))
            .expect("fixture skin folder");
        // somewhere else on disk: an image, and an ini that names `preview.png` as a texture
        let elsewhere = w.root.path().join("elsewhere");
        let inis = w.root.path().join("inis");
        fs::create_dir_all(&elsewhere).unwrap();
        fs::create_dir_all(&inis).unwrap();
        fs::write(elsewhere.join("preview.png"), PNG).unwrap();
        fs::write(inis.join("tex.ini"), "[ResourceX]\nfilename = preview.png\n").unwrap();
        // a symlinked ini inside a real folder is not read, so it can't hide the folder's own preview
        let real = w.root.path().join("real");
        fs::create_dir_all(&real).unwrap();
        fs::write(real.join("preview.png"), PNG).unwrap();
        symlink(inis.join("tex.ini"), real.join("tex.ini")).unwrap();
        assert_eq!(folder_previews(&real), vec!["preview.png"]);
        assert_eq!(folder_previews(&elsewhere), vec!["preview.png"], "what a followed link would find");
        // the skin's folder itself is now a symlink to `elsewhere`: nothing is copied from there
        fs::rename(&dir, w.root.path().join("moved-away")).unwrap();
        symlink(&elsewhere, &dir).unwrap();
        let (snap, added) = core.find_folder_previews(&id).unwrap();
        assert_eq!(added, 0);
        assert!(snap.library.skins.iter().find(|s| s.id == id).unwrap().previews.is_empty());
        assert!(!w.lib.join("previews").join(&id).exists());
    }
}
