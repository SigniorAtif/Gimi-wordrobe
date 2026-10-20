//! Archive handling (SPEC §9): list, refuse unsafe entries, extract with the system bsdtar (Windows `tar.exe`,
//! Linux `bsdtar`), drop junk and bundled library copies, sanitise names for NTFS, strip a single wrapper folder,
//! and pick preview images (SPEC §10). Archives are untrusted input.

use super::error::{AppError, AppResult};
use super::fsutil;
use super::paths;
use super::scanner::{self, ScanResult};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// `/`-separated path inside the archive (as listed).
    pub path: String,
    pub size: u64,
    pub is_dir: bool,
    /// Symlink or hard link: always refused.
    #[serde(skip)]
    pub link: bool,
}

/// The extractor: Windows' built-in tar.exe (bsdtar/libarchive), `bsdtar` from PATH elsewhere (SPEC §9, §0).
pub fn tar_program() -> PathBuf {
    #[cfg(windows)]
    {
        let sys = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
        sys.join("System32").join("tar.exe")
    }
    #[cfg(not(windows))]
    {
        PathBuf::from("bsdtar")
    }
}

fn command(program: &Path) -> Command {
    let mut c = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c.stdin(Stdio::null());
    c
}

/// Archives bigger than this (uncompressed) or with more entries are refused before anything is extracted, so a
/// zip bomb can't fill the Library drive. The largest real mod archive here is about 115 MB.
pub const MAX_TOTAL_BYTES: u64 = 8 << 30;
pub const MAX_ENTRIES: usize = 50_000;
/// An extractor still running after this long is stopped.
const EXTRACT_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// Parse one `tar -tv` line: `-rw-r--r--  0 0      0       2015 Jun 12  2023 DilucInWhite/Diluc.ini`.
/// None for a line that isn't an entry (the caller treats that as unsafe).
pub fn parse_tv_line(line: &str) -> Option<Entry> {
    let line = line.trim_end_matches(['\r', '\n']);
    if line.is_empty() {
        return None;
    }
    // walk 8 whitespace-separated fields, keep the rest (names may contain spaces)
    let mut rest = line;
    let mut fields: Vec<&str> = vec![];
    for _ in 0..8 {
        rest = rest.trim_start();
        let end = rest.find(char::is_whitespace)?;
        fields.push(&rest[..end]);
        rest = &rest[end..];
    }
    let name = rest.strip_prefix(' ').unwrap_or(rest);
    let perm = fields[0];
    let kind = perm.chars().next()?;
    let size = fields[4].parse::<u64>().ok()?;
    // only links carry a target suffix; a plain file may well have " -> " in its name
    let link = kind == 'l' || kind == 'h';
    let name = match kind {
        'l' => name.split(" -> ").next().unwrap_or(name),
        'h' => name.split(" link to ").next().unwrap_or(name),
        _ => name,
    }
    .to_string();
    let is_dir = kind == 'd' || name.ends_with('/');
    Some(Entry { path: name.replace('\\', "/"), size, is_dir, link })
}

/// Parse 7-Zip's technical listing (`7z l -slt`): blocks of `Key = value` after the `----------` line.
pub fn parse_7z_slt(out: &str) -> Option<Vec<Entry>> {
    let out = out.replace("\r\n", "\n");
    let body = out.split_once("\n----------")?.1;
    let mut entries = vec![];
    for block in body.split("\n\n") {
        let mut path = None;
        let mut size = 0;
        let mut dir = false;
        let mut link = false;
        for line in block.lines() {
            let Some((k, v)) = line.split_once(" = ").or_else(|| line.strip_suffix(" =").map(|k| (k, ""))) else {
                continue;
            };
            match k.trim() {
                "Path" => path = Some(v.trim_end_matches('\r').replace('\\', "/")),
                "Size" => size = v.trim().parse().unwrap_or(0),
                "Folder" => dir |= v.trim() == "+",
                "Attributes" => dir |= v.trim().starts_with('D'),
                "Symbolic Link" | "Hard Link" | "Link" => link |= !v.trim().is_empty(),
                _ => {}
            }
        }
        if let Some(path) = path.filter(|p| !p.is_empty()) {
            entries.push(Entry { path, size, is_dir: dir, link });
        }
    }
    Some(entries)
}

/// Parse UnRAR's technical listing (`UnRAR lt`): `Name:`, `Type:`, `Size:` lines per entry.
pub fn parse_unrar_lt(out: &str) -> Vec<Entry> {
    let mut entries: Vec<Entry> = vec![];
    for line in out.lines() {
        let line = line.trim();
        if let Some(name) = line.strip_prefix("Name: ") {
            entries.push(Entry { path: name.replace('\\', "/"), size: 0, is_dir: false, link: false });
        } else if let (Some(e), Some(t)) = (entries.last_mut(), line.strip_prefix("Type: ")) {
            let t = t.to_lowercase();
            e.is_dir = t.contains("directory");
            e.link = t.contains("link");
        } else if let (Some(e), Some(s)) = (entries.last_mut(), line.strip_prefix("Size: ")) {
            e.size = s.trim().parse().unwrap_or(0);
        }
    }
    entries
}

/// List an archive's entries (SPEC §9 "list contents before extracting"). On Windows, an archive tar.exe can't read
/// is listed with 7-Zip or UnRAR instead, so the same safety checks run before their fallback extraction.
pub fn list(archive: &Path) -> AppResult<Vec<Entry>> {
    let out = command(&tar_program()).arg("-tvf").arg(archive).output().map_err(|e| {
        AppError::new("extractor_missing", format!("Couldn't run the archive tool ({}): {e}", tar_program().display()))
    })?;
    if !out.status.success() {
        #[cfg(windows)]
        if let Some(entries) = list_fallback(archive) {
            return Ok(entries);
        }
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(AppError::new("unreadable_archive", format!("This archive can't be read: {err}")));
    }
    let mut entries = vec![];
    for line in String::from_utf8_lossy(&out.stdout).lines().filter(|l| !l.trim().is_empty()) {
        // a line we can't read could hide an entry from the checks below
        let e = parse_tv_line(line).ok_or_else(|| {
            AppError::new("unsafe_archive", "Its file list couldn't be read safely. Nothing was extracted.")
        })?;
        entries.push(e);
    }
    Ok(entries)
}

#[cfg(windows)]
fn seven_zip() -> Option<PathBuf> {
    [r"C:\Program Files\7-Zip\7z.exe", r"C:\Program Files (x86)\7-Zip\7z.exe"]
        .iter()
        .map(PathBuf::from)
        .find(|p| p.exists())
}

#[cfg(windows)]
fn unrar() -> Option<PathBuf> {
    Some(PathBuf::from(r"C:\Program Files\WinRAR\UnRAR.exe")).filter(|p| p.exists())
}

#[cfg(windows)]
fn is_rar(archive: &Path) -> bool {
    archive.extension().map(|e| e.eq_ignore_ascii_case("rar")).unwrap_or(false)
}

#[cfg(windows)]
fn list_fallback(archive: &Path) -> Option<Vec<Entry>> {
    if let Some(z) = seven_zip()
        && let Ok(out) = command(&z).arg("l").arg("-slt").arg(archive).output()
        && out.status.success()
        && let Some(entries) = parse_7z_slt(&String::from_utf8_lossy(&out.stdout))
    {
        return Some(entries);
    }
    if is_rar(archive)
        && let Some(u) = unrar()
        && let Ok(out) = command(&u).arg("lt").arg(archive).output()
        && out.status.success()
    {
        return Some(parse_unrar_lt(&String::from_utf8_lossy(&out.stdout)));
    }
    None
}

/// Refuse the whole archive on any absolute path, drive letter, `..` component (also `.. ` and `...`, which Windows
/// trims to `..`), Windows device name, control character or link (SPEC §9), and on archives too big to extract.
pub fn check_entries(entries: &[Entry]) -> AppResult<()> {
    let unsafe_entry = |path: &str| {
        AppError::new("unsafe_archive", format!("It contains an unsafe entry ({path}). Nothing was extracted."))
    };
    for e in entries {
        let p = e.path.replace('\\', "/");
        let bad_component = p.split('/').filter(|c| !c.is_empty() && *c != ".").any(|c| {
            // Win32 drops trailing dots and spaces, so "..." or ".. " would land as ".."
            c.trim_end_matches(['.', ' ']).is_empty() || paths::is_reserved_name(c)
        });
        let bad = e.link || p.starts_with('/') || p.contains(':') || bad_component || p.bytes().any(|b| b < 0x20);
        if bad {
            return Err(unsafe_entry(&e.path));
        }
    }
    let total: u64 = entries.iter().map(|e| e.size).sum();
    if entries.len() > MAX_ENTRIES || total > MAX_TOTAL_BYTES {
        return Err(AppError::new(
            "archive_too_big",
            format!(
                "It would unpack to {} files and {:.1} GB, more than a mod should. Nothing was extracted.",
                entries.len(),
                total as f64 / (1u64 << 30) as f64
            ),
        ));
    }
    Ok(())
}

/// Folder size in bytes (for extraction progress).
pub fn dir_size(p: &Path) -> u64 {
    let Ok(rd) = fs::read_dir(p) else { return 0 };
    rd.filter_map(Result::ok)
        .map(|e| match e.file_type() {
            Ok(t) if t.is_dir() => dir_size(&e.path()),
            Ok(_) => e.metadata().map(|m| m.len()).unwrap_or(0),
            Err(_) => 0,
        })
        .sum()
}

/// Extract into `dest` (created, must be empty). `include` limits extraction to matching paths (e.g. `*.ini`).
/// `progress(bytes_done)` is called while the extractor runs.
pub fn extract(archive: &Path, dest: &Path, include: &[&str], progress: &mut dyn FnMut(u64)) -> AppResult<()> {
    fs::create_dir_all(dest)?;
    let mut c = command(&tar_program());
    c.arg("-xf").arg(archive).arg("-C").arg(dest);
    for pat in include {
        c.arg("--include").arg(pat);
    }
    c.stdout(Stdio::null()).stderr(Stdio::piped());
    let mut child =
        c.spawn().map_err(|e| AppError::new("extractor_missing", format!("Couldn't run the archive tool: {e}")))?;
    // drain stderr while it runs: a full pipe would block the extractor forever
    let stderr = child.stderr.take().map(|mut s| {
        std::thread::spawn(move || {
            let mut buf = String::new();
            use std::io::Read;
            let _ = s.read_to_string(&mut buf);
            buf
        })
    });
    let started = std::time::Instant::now();
    let mut ticks = 0u32;
    let status = loop {
        if let Some(st) = child.try_wait()? {
            break st;
        }
        if started.elapsed() > EXTRACT_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            return Err(AppError::new("extract_failed", "Extraction took too long and was stopped."));
        }
        // walking the staging tree costs, so measure about once a second
        if ticks.is_multiple_of(5) {
            progress(dir_size(dest));
        }
        ticks += 1;
        std::thread::sleep(Duration::from_millis(200));
    };
    if !status.success() {
        let err = stderr.and_then(|h| h.join().ok()).unwrap_or_default();
        #[cfg(windows)]
        if extract_fallback(archive, dest).is_ok() {
            return verify_inside(dest);
        }
        return Err(AppError::new("extract_failed", format!("Extraction failed: {}", err.trim())));
    }
    progress(dir_size(dest));
    verify_inside(dest)
}

/// Windows fallbacks when tar.exe can't read an archive (SPEC §9): 7-Zip, then WinRAR's UnRAR for .rar.
#[cfg(windows)]
fn extract_fallback(archive: &Path, dest: &Path) -> io::Result<()> {
    if let Some(z) = seven_zip() {
        let st = command(&z)
            .arg("x")
            .arg("-y")
            .arg(format!("-o{}", dest.display()))
            .arg(archive)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()?;
        if st.success() {
            return Ok(());
        }
    }
    if is_rar(archive)
        && let Some(u) = unrar()
    {
        let st = command(&u)
            .arg("x")
            .arg("-o+")
            .arg(archive)
            .arg(format!("{}\\", dest.display()))
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()?;
        if st.success() {
            return Ok(());
        }
    }
    Err(io::Error::other("no fallback extractor worked"))
}

/// After extracting, every entry must be a real file or folder inside `dest` (no links that point out).
pub fn verify_inside(dest: &Path) -> AppResult<()> {
    let root = dest.canonicalize()?;
    fn walk(p: &Path, root: &Path) -> AppResult<()> {
        for e in fs::read_dir(p)? {
            let e = e?;
            let ft = e.file_type()?;
            if ft.is_symlink() {
                return Err(AppError::new("unsafe_archive", "It contains a link. Nothing was kept."));
            }
            let real = e.path().canonicalize()?;
            if !real.starts_with(root) {
                return Err(AppError::new("unsafe_archive", "It tried to write outside its folder. Nothing was kept."));
            }
            if ft.is_dir() {
                walk(&e.path(), root)?;
            }
        }
        Ok(())
    }
    walk(dest, &root)
}

/// Rename every entry to an NTFS-safe name (SPEC §9), children first. Returns how many were renamed.
pub fn sanitize_tree(dir: &Path) -> io::Result<usize> {
    let mut n = 0;
    for e in fs::read_dir(dir)?.filter_map(Result::ok).collect::<Vec<_>>() {
        let p = e.path();
        if e.file_type()?.is_dir() {
            n += sanitize_tree(&p)?;
        }
        let name = e.file_name().to_string_lossy().into_owned();
        let clean = paths::sanitize_component(&name);
        if clean != name {
            let mut target = dir.join(&clean);
            let mut i = 2;
            while target.exists() {
                target = dir.join(format!("{clean} ({i})"));
                i += 1;
            }
            fs::rename(&p, target)?;
            n += 1;
        }
    }
    Ok(n)
}

/// Delete junk (desktop.ini, Thumbs.db, .DS_Store, __MACOSX/, ._*) and bundled library copies (BufferValues/,
/// ORFix*.ini, TexFx*, ...) from an extracted archive (SPEC §5, §9). Returns the removed paths (relative).
pub fn strip_unwanted(dir: &Path) -> io::Result<Vec<String>> {
    let mut removed = vec![];
    fn walk(base: &Path, p: &Path, out: &mut Vec<String>) -> io::Result<()> {
        for e in fs::read_dir(p)?.filter_map(Result::ok).collect::<Vec<_>>() {
            let path = e.path();
            let name = e.file_name().to_string_lossy().into_owned();
            let is_dir = e.file_type()?.is_dir();
            let library = if is_dir { scanner::is_library_dir(&name) } else { scanner::is_library_file(&name) };
            if paths::is_junk_name(&name) || library {
                out.push(paths::rel_from(base, &path).unwrap_or(name));
                if is_dir {
                    fsutil::remove_tree_force(&path)?
                } else {
                    fsutil::remove_file_force(&path)?
                }
                continue;
            }
            if is_dir {
                walk(base, &path, out)?;
                // a folder emptied by the removals goes too
                if fs::read_dir(&path)?.next().is_none() {
                    fs::remove_dir(&path)?;
                }
            }
        }
        Ok(())
    }
    walk(dir, dir, &mut removed)?;
    Ok(removed)
}

/// The archive's content root: its single top-level folder when that is the only item, else the folder itself.
pub fn content_root(dir: &Path) -> io::Result<PathBuf> {
    let items: Vec<_> = fs::read_dir(dir)?.filter_map(Result::ok).collect();
    if items.len() == 1 && items[0].file_type()?.is_dir() {
        return Ok(items[0].path());
    }
    Ok(dir.to_path_buf())
}

/// Same rule on a listing: the wrapper prefix (`Wrapper/`) when everything sits in one folder, junk and bundled
/// libraries ignored.
pub fn wrapper_of(entries: &[Entry]) -> Option<String> {
    let mut tops: Vec<&str> = entries
        .iter()
        .filter(|e| {
            !e.path
                .split('/')
                .any(|c| paths::is_junk_name(c) || scanner::is_library_dir(c) || scanner::is_library_file(c))
        })
        .map(|e| e.path.trim_end_matches('/').split('/').next().unwrap_or(""))
        .filter(|t| !t.is_empty())
        .collect();
    tops.sort_unstable();
    tops.dedup();
    let only = tops.first().filter(|_| tops.len() == 1)?;
    entries
        .iter()
        .any(|e| e.path.trim_end_matches('/').contains('/') && e.path.starts_with(&format!("{only}/")))
        .then(|| format!("{only}/"))
}

const IMAGE_EXTS: [&str; 4] = ["png", "jpg", "jpeg", "webp"];
const TEXTURE_WORDS: [&str; 6] = ["diffuse", "lightmap", "normalmap", "shadowramp", "metalmap", "mask"];
const UI_WORDS: [&str; 4] = ["menu", "cursor", "btn", "res/swp"];
const PREVIEW_WORDS: [&str; 5] = ["prev", "preview", "showcase", "cover", "screenshot"];
const PROMO_WORDS: [&str; 4] = ["patreon", "ko-fi", "kofi", "discord"];

/// Preview images among `files` (paths relative to the content root): no textures an ini references, no texture-like
/// names, no UI assets; preview-named first, promo images last so they are never the default cover (SPEC §5, §10).
pub fn preview_candidates(files: &[String], scan: &ScanResult) -> Vec<String> {
    // `filename = ..\Shared\Body.png` and `./Face.jpg` point at the same files the listing names plainly
    let referenced: std::collections::HashSet<String> =
        scan.inis.iter().flat_map(|i| i.filenames.iter().map(|f| normalize_rel(f))).collect();
    let mut out: Vec<(u8, String)> = files
        .iter()
        .filter(|f| {
            let l = f.to_lowercase();
            let ext = l.rsplit('.').next().unwrap_or("");
            IMAGE_EXTS.contains(&ext)
                && !referenced.contains(&l)
                && !TEXTURE_WORDS.iter().any(|w| l.rsplit('/').next().unwrap_or("").contains(w))
                && !UI_WORDS.iter().any(|w| l.contains(w))
        })
        .map(|f| {
            let l = f.to_lowercase();
            let name = l.rsplit('/').next().unwrap_or("");
            let rank = if PROMO_WORDS.iter().any(|w| name.contains(w)) {
                2
            } else if PREVIEW_WORDS.iter().any(|w| name.contains(w)) {
                0
            } else {
                1
            };
            (rank, f.clone())
        })
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| natural_cmp(&a.1, &b.1)));
    out.into_iter().map(|(_, f)| f).collect()
}

/// Resolve `.` and `..` in a `/`-separated relative path ("a/../b/./c.png" -> "b/c.png").
fn normalize_rel(p: &str) -> String {
    let mut out: Vec<&str> = vec![];
    for part in p.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            _ => out.push(part),
        }
    }
    out.join("/")
}

/// "prev (2).png" before "prev (10).png".
fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let key = |s: &str| -> Vec<(String, u64)> {
        let mut parts = vec![];
        let mut text = String::new();
        let mut num = String::new();
        for c in s.to_lowercase().chars() {
            if c.is_ascii_digit() {
                num.push(c);
            } else {
                if !num.is_empty() {
                    parts.push((std::mem::take(&mut text), num.parse().unwrap_or(0)));
                    num.clear();
                }
                text.push(c);
            }
        }
        parts.push((text, num.parse().unwrap_or(0)));
        parts
    };
    key(a).cmp(&key(b))
}

/// Every file below `dir`, relative, `/`-separated.
pub fn files_below(dir: &Path) -> Vec<String> {
    let mut out = vec![];
    fn walk(base: &Path, p: &Path, out: &mut Vec<String>) {
        let Ok(rd) = fs::read_dir(p) else { return };
        for e in rd.filter_map(Result::ok) {
            let path = e.path();
            if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                walk(base, &path, out);
            } else if let Some(r) = paths::rel_from(base, &path) {
                out.push(r);
            }
        }
    }
    walk(dir, dir, &mut out);
    out.sort();
    out
}

/// NSFW default (SPEC §5): the archive sits in an `nsfw` folder or its name says so.
pub fn nsfw_guess(archive: &Path) -> bool {
    let in_nsfw_folder = archive
        .parent()
        .map(|p| p.components().any(|c| c.as_os_str().to_string_lossy().eq_ignore_ascii_case("nsfw")))
        .unwrap_or(false);
    let name = archive.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    in_nsfw_folder || ["nsfw", "lewd", "nude", "hentai", "18+"].iter().any(|w| name.contains(w))
}

#[cfg(test)]
pub mod tests {
    use super::*;

    pub fn fixture_archive(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/archives").join(name)
    }

    #[test]
    fn parses_tar_listing_lines() {
        let e = parse_tv_line("-rw-rw-r--  0 0      0       13488 Jul  9 10:16 BennettBeachDay/BennettAdventure.ini")
            .unwrap();
        assert_eq!(e.path, "BennettBeachDay/BennettAdventure.ini");
        assert_eq!(e.size, 13488);
        assert!(!e.is_dir);
        let d =
            parse_tv_line("drwxrwxrwx  0 0      0           0 Sep 10  2025 Varesa lewd - Culottée à mort/").unwrap();
        assert!(d.is_dir);
        assert_eq!(d.path, "Varesa lewd - Culottée à mort/");
        let s = parse_tv_line("lrwxrwxrwx  0 0      0           0 Sep 10  2025 link -> /etc/passwd").unwrap();
        assert!(s.link);
        let spaced =
            parse_tv_line("-rw-r--r--  0 0      0        2015 Jun 12  2023 DilucInWhiteBetterHair/prev (1).png")
                .unwrap();
        assert_eq!(spaced.path, "DilucInWhiteBetterHair/prev (1).png");
    }

    #[test]
    fn refuses_traversal_absolute_drive_and_links() {
        let ok = |p: &str| Entry { path: p.into(), size: 0, is_dir: false, link: false };
        assert!(check_entries(&[ok("A/b.ini"), ok("A/c d/e.png")]).is_ok());
        for bad in ["../evil.ini", "a/../../b", "/tmp/x", "C:/x", "C:x", "a\\..\\b"] {
            assert_eq!(check_entries(&[ok(bad)]).unwrap_err().code, "unsafe_archive", "{bad}");
        }
        assert!(check_entries(&[Entry { link: true, ..ok("a") }]).is_err());
    }

    #[test]
    fn only_links_carry_a_target_and_odd_lines_are_not_entries() {
        let f = parse_tv_line("-rw-r--r--  0 0      0          10 Jun 12  2023 a -> b.ini").unwrap();
        assert!(!f.link, "a plain file may have an arrow in its name");
        assert_eq!(f.path, "a -> b.ini");
        let h = parse_tv_line("hrw-r--r--  0 0      0           0 Jun 12  2023 copy.ini link to real.ini").unwrap();
        assert!(h.link);
        assert_eq!(h.path, "copy.ini");
        assert!(parse_tv_line("tar: something odd").is_none());
    }

    #[test]
    fn refuses_windows_name_tricks_and_oversized_archives() {
        let ok = |p: &str| Entry { path: p.into(), size: 0, is_dir: false, link: false };
        for bad in [".. /x.ini", "a/.../b.ini", "a/. ./b", "CON", "dir/nul.txt", "COM1.ini", "aux/x.ini"] {
            assert_eq!(check_entries(&[ok(bad)]).unwrap_err().code, "unsafe_archive", "{bad}");
        }
        assert!(check_entries(&[ok("./a.ini"), ok("a/./b.ini"), ok("Console.ini"), ok("dir/")]).is_ok());
        let huge = Entry { size: MAX_TOTAL_BYTES + 1, ..ok("bomb.bin") };
        assert_eq!(check_entries(&[huge]).unwrap_err().code, "archive_too_big");
    }

    #[test]
    fn parses_7zip_and_unrar_technical_listings() {
        let z = "7-Zip 23.01\r\n\r\n--\r\nPath = C:\\dl\\a.rar\r\nType = Rar5\r\n\r\n----------\r\nPath = Mod\\Mod.ini\r\nFolder = -\r\nSize = 558\r\nAttributes = A\r\n\r\nPath = Mod\r\nFolder = +\r\nSize = 0\r\nAttributes = D\r\n\r\nPath = Mod\\l\r\nSize = 0\r\nSymbolic Link = ..\\..\\x\r\n";
        let e = parse_7z_slt(z).unwrap();
        assert_eq!(e.len(), 3);
        assert_eq!((e[0].path.as_str(), e[0].size, e[0].is_dir), ("Mod/Mod.ini", 558, false));
        assert!(e[1].is_dir);
        assert!(e[2].link);
        assert!(parse_7z_slt("no separator").is_none());
        let r = "UNRAR 7.00\n\n        Name: Mod/Varesa.ini\n        Type: File\n        Size: 1200\n\n        Name: Mod\n        Type: Directory\n\n        Name: Mod/evil\n        Type: Symbolic link\n";
        let e = parse_unrar_lt(r);
        assert_eq!(e.len(), 3);
        assert_eq!((e[0].path.as_str(), e[0].size), ("Mod/Varesa.ini", 1200));
        assert!(e[1].is_dir && e[2].link);
    }

    #[test]
    fn malicious_fixture_archives_are_rejected_before_extraction() {
        for name in ["evil_traversal.zip", "evil_absolute.zip"] {
            let entries = list(&fixture_archive(name)).unwrap();
            assert_eq!(check_entries(&entries).unwrap_err().code, "unsafe_archive", "{name}");
        }
    }

    #[test]
    fn extracts_strips_junk_and_library_copies_and_unwraps() {
        let t = tempfile::tempdir().unwrap();
        let dest = t.path().join("x");
        let entries = list(&fixture_archive("bennett_beach.zip")).unwrap();
        check_entries(&entries).unwrap();
        assert_eq!(
            wrapper_of(&entries).as_deref(),
            Some("BennettBeachDay/"),
            "BufferValues is ignored for the wrapper"
        );
        extract(&fixture_archive("bennett_beach.zip"), &dest, &[], &mut |_| {}).unwrap();
        let removed = strip_unwanted(&dest).unwrap();
        assert!(removed.iter().any(|r| r.ends_with("desktop.ini")));
        assert!(removed.iter().any(|r| r == "BufferValues"));
        let root = content_root(&dest).unwrap();
        assert_eq!(root.file_name().unwrap(), "BennettBeachDay");
        assert!(root.join("TravelerHandySword/SkywardBlade.ini").is_file());
        assert!(!root.join("TravelerHandySword/desktop.ini").exists());
    }

    #[test]
    fn files_at_the_root_have_no_wrapper() {
        let t = tempfile::tempdir().unwrap();
        let entries = list(&fixture_archive("varesa_root_files.7z")).unwrap();
        assert_eq!(wrapper_of(&entries), None);
        extract(&fixture_archive("varesa_root_files.7z"), t.path(), &[], &mut |_| {}).unwrap();
        assert_eq!(content_root(t.path()).unwrap(), t.path());
    }

    #[test]
    fn ini_only_extraction() {
        let t = tempfile::tempdir().unwrap();
        extract(&fixture_archive("mona_starry_skin.zip"), t.path(), &["*.[iI][nN][iI]"], &mut |_| {}).unwrap();
        let files = files_below(t.path());
        assert!(files.iter().all(|f| f.ends_with(".ini")), "{files:?}");
    }

    #[test]
    fn sanitises_names_and_picks_previews() {
        let t = tempfile::tempdir().unwrap();
        fs::create_dir_all(t.path().join("Culott\u{FFFD}e \u{FFFD} mort")).unwrap();
        fs::write(t.path().join("bad name. "), "x").unwrap();
        // Win32 strips a trailing dot and space on create, so that file is already clean there
        let expected = if cfg!(windows) { 1 } else { 2 };
        assert_eq!(sanitize_tree(t.path()).unwrap(), expected);
        assert!(t.path().join("bad name").is_file());
        assert!(t.path().join("Culotte mort").is_dir());
        let scan = ScanResult::default();
        let files: Vec<String> = [
            "Kazuha/resource/menu/a.png",
            "Kazuha/resource/black_red/KazuhaPonyHeadDiffuse.png",
            "NeuvilletteWedding/www.patreon.com annplan.png",
            "Diluc/prev (10).png",
            "Diluc/prev (2).png",
            "Diluc/extra.jpg",
            "Diluc/PaimonBodyShadowRamp.jpg",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let p = preview_candidates(&files, &scan);
        assert_eq!(
            p,
            vec![
                "Diluc/prev (2).png",
                "Diluc/prev (10).png",
                "Diluc/extra.jpg",
                "NeuvilletteWedding/www.patreon.com annplan.png"
            ]
        );
    }

    #[test]
    fn previews_skip_textures_referenced_through_relative_paths() {
        let mut scan = ScanResult::default();
        scan.inis.push(crate::core::scanner::IniFacts {
            rel: "Diluc/Diluc.ini".into(),
            filenames: vec!["diluc/../shared/body.png".into(), "diluc/./face.jpg".into(), "diluc/hair.png".into()],
            ..Default::default()
        });
        let files: Vec<String> =
            ["Shared/Body.png", "Diluc/Face.jpg", "Diluc/Hair.png", "Diluc/preview.webp", "Diluc/notes.txt"]
                .iter()
                .map(|s| s.to_string())
                .collect();
        assert_eq!(preview_candidates(&files, &scan), vec!["Diluc/preview.webp"]);
        assert_eq!(normalize_rel("a/../../b/./c.png"), "b/c.png");
    }

    #[test]
    fn nsfw_defaults() {
        assert!(nsfw_guess(Path::new("/x/Veresa/nsfw/weebovz_-_cow_girl.rar")));
        assert!(nsfw_guess(Path::new("/x/Veresa/varesa_lewd_-_culott.zip")));
        assert!(!nsfw_guess(Path::new("/x/Veresa/sfw/varesa_by_neyori.zip")));
    }
}
