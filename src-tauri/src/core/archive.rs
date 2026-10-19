//! Archive handling (SPEC §9): list, refuse unsafe entries, extract with the system bsdtar (Windows `tar.exe`,
//! Linux `bsdtar`), drop junk and bundled library copies, sanitise names for NTFS, strip a single wrapper folder,
//! and pick preview images (SPEC §10). Archives are untrusted input.

use super::error::{AppError, AppResult};
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

/// Parse one `tar -tv` line: `-rw-r--r--  0 0      0       2015 Jun 12  2023 DilucInWhite/Diluc.ini`.
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
    let size = fields[4].parse::<u64>().unwrap_or(0);
    let link = kind == 'l' || kind == 'h' || name.contains(" link to ");
    let name = name.split(" -> ").next().unwrap_or(name).to_string();
    let is_dir = kind == 'd' || name.ends_with('/');
    Some(Entry { path: name.replace('\\', "/"), size, is_dir, link })
}

/// List an archive's entries (SPEC §9 "list contents before extracting").
pub fn list(archive: &Path) -> AppResult<Vec<Entry>> {
    let out = command(&tar_program()).arg("-tvf").arg(archive).output().map_err(|e| {
        AppError::new("extractor_missing", format!("Couldn't run the archive tool ({}): {e}", tar_program().display()))
    })?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(AppError::new("unreadable_archive", format!("This archive can't be read: {err}")));
    }
    Ok(String::from_utf8_lossy(&out.stdout).lines().filter_map(parse_tv_line).collect())
}

/// Refuse the whole archive on any absolute path, drive letter, `..` component or link (SPEC §9).
pub fn check_entries(entries: &[Entry]) -> AppResult<()> {
    for e in entries {
        let p = e.path.replace('\\', "/");
        let bad = e.link
            || p.starts_with('/')
            || p.contains(':')
            || p.split('/').any(|c| c == "..")
            || p.bytes().any(|b| b < 0x20);
        if bad {
            return Err(AppError::new(
                "unsafe_archive",
                format!("It contains an unsafe entry ({}). Nothing was extracted.", e.path),
            ));
        }
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
    let status = loop {
        if let Some(st) = child.try_wait()? {
            break st;
        }
        progress(dir_size(dest));
        std::thread::sleep(Duration::from_millis(200));
    };
    if !status.success() {
        let mut err = String::new();
        if let Some(mut s) = child.stderr.take() {
            use std::io::Read;
            let _ = s.read_to_string(&mut err);
        }
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
    let candidates =
        [PathBuf::from(r"C:\Program Files\7-Zip\7z.exe"), PathBuf::from(r"C:\Program Files (x86)\7-Zip\7z.exe")];
    for z in candidates.iter().filter(|p| p.exists()) {
        let st = command(z).arg("x").arg("-y").arg(format!("-o{}", dest.display())).arg(archive).status()?;
        if st.success() {
            return Ok(());
        }
    }
    let unrar = PathBuf::from(r"C:\Program Files\WinRAR\UnRAR.exe");
    let is_rar = archive.extension().map(|e| e.eq_ignore_ascii_case("rar")).unwrap_or(false);
    if is_rar && unrar.exists() {
        let st = command(&unrar).arg("x").arg("-o+").arg(archive).arg(format!("{}\\", dest.display())).status()?;
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
                    fs::remove_dir_all(&path)?
                } else {
                    fs::remove_file(&path)?
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
    let referenced: std::collections::HashSet<String> =
        scan.inis.iter().flat_map(|i| i.filenames.iter().cloned()).collect();
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
        assert_eq!(sanitize_tree(t.path()).unwrap(), 2);
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
    fn nsfw_defaults() {
        assert!(nsfw_guess(Path::new("/x/Veresa/nsfw/weebovz_-_cow_girl.rar")));
        assert!(nsfw_guess(Path::new("/x/Veresa/varesa_lewd_-_culott.zip")));
        assert!(!nsfw_guess(Path::new("/x/Veresa/sfw/varesa_by_neyori.zip")));
    }
}
