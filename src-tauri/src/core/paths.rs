//! Path rules. Windows semantics everywhere, even when tests run on Linux (SPEC §0, §3):
//! case-insensitive comparison, `\` in persist keys, NTFS-safe names.
//!
//! Relative paths inside the model (`Skin.folders`) use `/` separators, e.g. `Furina/Remembrance`.

use std::path::{Component, Path, PathBuf};

/// Comparison key for a path: lowercase, `/` separators, no trailing separator, `.` dropped and `..` resolved
/// lexically (so `D:\a\x\..\Mods` compares equal to `D:\a\Mods`).
pub fn cmp_key(p: &str) -> String {
    let unified = p.replace('\\', "/");
    let mut parts: Vec<&str> = vec![];
    for part in unified.split('/').filter(|s| !s.is_empty() && *s != ".") {
        if part == ".." {
            // never pop a drive ("d:") off the front
            if parts.last().map(|l| !l.ends_with(':')).unwrap_or(false) {
                parts.pop();
            }
            continue;
        }
        parts.push(part);
    }
    let lead = if unified.starts_with("//") {
        "//"
    } else if unified.starts_with('/') {
        "/"
    } else {
        ""
    };
    format!("{lead}{}", parts.join("/")).to_lowercase()
}

/// Any `..` component.
pub fn has_parent_ref(p: &str) -> bool {
    p.split(['/', '\\']).any(|c| c == "..")
}

/// Absolute on Windows (`X:\`, `\\server\share`) or, for Linux dev runs, `/...`.
pub fn is_absolute_like(p: &str) -> bool {
    let b = p.as_bytes();
    (b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/'))
        || p.starts_with("\\\\")
        || p.starts_with('/')
}

/// `X:\`, `X:`, `/` or a bare UNC share: too broad to be a Library.
pub fn is_drive_root(p: &str) -> bool {
    let k = cmp_key(p);
    let parts: Vec<&str> = k.trim_start_matches('/').split('/').filter(|s| !s.is_empty()).collect();
    if k.starts_with("//") {
        return parts.len() <= 2;
    }
    parts.is_empty() || (parts.len() == 1 && parts[0].ends_with(':'))
}

pub fn same_path(a: &str, b: &str) -> bool {
    cmp_key(a) == cmp_key(b)
}

/// True when `child` is `parent` or lies inside it (case-insensitive).
pub fn is_within(child: &str, parent: &str) -> bool {
    let c = cmp_key(child);
    let p = cmp_key(parent);
    if p.is_empty() {
        return false;
    }
    c == p || c.starts_with(&format!("{p}/"))
}

/// Join a `/`-separated relative path onto a base directory using OS separators. Returns None for anything that
/// could escape the base: `..`, drive prefixes (`C:`), or an absolute path.
pub fn join_rel(base: &Path, rel: &str) -> Option<PathBuf> {
    if rel.starts_with('/') || rel.starts_with('\\') {
        return None;
    }
    let mut out = base.to_path_buf();
    for part in rel.split(['/', '\\']).filter(|s| !s.is_empty() && *s != ".") {
        if part == ".." || part.contains(':') {
            return None;
        }
        out.push(part);
    }
    Some(out)
}

/// Express `path` relative to `base` with `/` separators. Case-insensitive prefix match.
pub fn rel_from(base: &Path, path: &Path) -> Option<String> {
    let b: Vec<String> = components(base);
    let p: Vec<String> = components(path);
    if p.len() < b.len() {
        return None;
    }
    for (x, y) in b.iter().zip(p.iter()) {
        if x.to_lowercase() != y.to_lowercase() {
            return None;
        }
    }
    Some(p[b.len()..].join("/"))
}

fn components(p: &Path) -> Vec<String> {
    p.components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
            Component::Prefix(pre) => Some(pre.as_os_str().to_string_lossy().into_owned()),
            Component::RootDir => Some(String::new()),
            _ => None,
        })
        .collect()
}

/// `$\mods\<folder, lowercased, backslashes>\` - the d3dx_user.ini key prefix for a skin folder (SPEC §3).
pub fn persist_prefix(folder: &str) -> String {
    let inner = folder.replace('/', "\\").trim_matches('\\').to_lowercase();
    format!("$\\mods\\{inner}\\")
}

/// 3DMigoto skips any file or folder matching `DISABLED*`, case-insensitive (PCRE2_CASELESS), no underscore needed.
pub fn is_disabled_name(name: &str) -> bool {
    name.len() >= 8 && name.as_bytes()[..8].eq_ignore_ascii_case(b"disabled")
}

/// Any component of the relative path is DISABLED-prefixed.
pub fn has_disabled_component(rel: &str) -> bool {
    rel.split(['/', '\\']).any(is_disabled_name)
}

/// Junk entries never placed into Mods (SPEC §5, §9).
pub fn is_junk_name(name: &str) -> bool {
    let l = name.to_lowercase();
    matches!(l.as_str(), "desktop.ini" | "thumbs.db" | ".ds_store" | "__macosx") || l.starts_with("._")
}

pub fn is_dot_name(name: &str) -> bool {
    name.starts_with('.')
}

const RESERVED: [&str; 30] = [
    "CON", "PRN", "AUX", "NUL", "COM0", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT0",
    "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9", "COM¹", "COM²", "COM³", "LPT¹", "LPT²",
    "LPT³",
];

/// Make one path component safe on NTFS: strip `<>:"/\|?*` and control characters, trailing dots and spaces,
/// and suffix reserved device names. Valid Unicode is kept as it is (SPEC §9). U+FFFD (what a wrong code page turns
/// "é" into) can't be recovered, so it is dropped and the leftover spaces collapsed.
pub fn sanitize_component(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter(|c| !matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') && !c.is_control())
        .filter(|c| *c != '\u{FFFD}')
        .collect();
    let mut s = cleaned.split(' ').filter(|w| !w.is_empty()).collect::<Vec<_>>().join(" ");
    while s.ends_with('.') || s.ends_with(' ') {
        s.pop();
    }
    let s = s.trim_start().to_string();
    if s.is_empty() {
        return "_".into();
    }
    let stem = s.split('.').next().unwrap_or("").to_uppercase();
    if RESERVED.contains(&stem.as_str()) {
        return format!("{s}_");
    }
    s
}

/// A Windows device name (`CON`, `nul.txt`, `COM1`…), which can't be a file name on NTFS.
pub fn is_reserved_name(component: &str) -> bool {
    let stem = component.trim_end_matches(['.', ' ']).split('.').next().unwrap_or("").trim_end().to_uppercase();
    RESERVED.contains(&stem.as_str())
}

/// Sanitise every component of a relative path.
pub fn sanitize_rel(rel: &str) -> String {
    rel.split(['/', '\\']).filter(|s| !s.is_empty()).map(sanitize_component).collect::<Vec<_>>().join("/")
}

/// Windows drive or volume root of an absolute path ("D:" / "\\server\share"); None on non-Windows-style paths.
pub fn windows_drive(p: &str) -> Option<String> {
    let b = p.as_bytes();
    if b.len() >= 2 && b[1] == b':' && b[0].is_ascii_alphabetic() {
        return Some(format!("{}:", (b[0] as char).to_ascii_uppercase()));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_case_insensitively_with_either_separator() {
        assert!(same_path("D:\\Mods\\Furina\\", "d:/mods/furina"));
        assert!(is_within("D:\\mods\\3dmigoto\\Mods\\Furina", "d:/MODS/3dmigoto/mods"));
        assert!(!is_within("D:\\mods\\3dmigoto\\ModsX", "D:\\mods\\3dmigoto\\Mods"));
        assert!(is_within("/a/b", "/a/b"));
        // `..` is resolved before comparing, so it can't sneak a Library into Mods
        assert!(is_within("D:\\mods\\3dmigoto\\X\\..\\Mods\\Lib", "D:\\mods\\3dmigoto\\Mods"));
        assert_eq!(cmp_key("D:\\..\\x"), "d:/x");
    }

    #[test]
    fn absolute_and_root_detection() {
        assert!(is_absolute_like("D:\\mods\\SkinLibrary"));
        assert!(is_absolute_like("\\\\nas\\share\\lib"));
        assert!(is_absolute_like("/home/x/lib"));
        assert!(!is_absolute_like("SkinLibrary"));
        assert!(!is_absolute_like("D:SkinLibrary"));
        assert!(is_drive_root("D:\\"));
        assert!(is_drive_root("d:"));
        assert!(is_drive_root("/"));
        assert!(is_drive_root("\\\\nas\\share"));
        assert!(!is_drive_root("D:\\SkinLibrary"));
        assert!(has_parent_ref("a/../b"));
    }

    #[test]
    fn persist_prefix_matches_d3dx_user_keys() {
        assert_eq!(
            persist_prefix("sandrone_marionette_by_neyori/outfit"),
            "$\\mods\\sandrone_marionette_by_neyori\\outfit\\"
        );
        assert_eq!(persist_prefix("Furina/Remembrance/"), "$\\mods\\furina\\remembrance\\");
    }

    #[test]
    fn disabled_rule_is_caseless_and_needs_no_underscore() {
        for n in ["DISABLEDVaresa.ini", "disabled_x", "DISABLED_Includes.ini", "Disabled"] {
            assert!(is_disabled_name(n), "{n}");
        }
        for n in ["Disable", "xDISABLED", "MyDisabled"] {
            assert!(!is_disabled_name(n), "{n}");
        }
        assert!(has_disabled_component("Kazuha/Toukabou/DISABLEDtoukabou.ini"));
    }

    #[test]
    fn junk_names() {
        assert!(is_junk_name("desktop.ini"));
        assert!(is_junk_name("Desktop.INI"));
        assert!(is_junk_name("Thumbs.db"));
        assert!(is_junk_name("__MACOSX"));
        assert!(!is_junk_name("Furina.ini"));
    }

    #[test]
    fn sanitises_for_ntfs() {
        assert_eq!(sanitize_component("Culottée à mort"), "Culottée à mort");
        assert_eq!(sanitize_component("Culott\u{FFFD}e \u{FFFD} mort"), "Culotte mort");
        assert_eq!(sanitize_component("COM0"), "COM0_");
        assert_eq!(sanitize_component("LPT¹.txt"), "LPT¹.txt_");
        assert_eq!(sanitize_component("a<b>c:d\"e|f?g*h"), "abcdefgh");
        assert_eq!(sanitize_component("name. . "), "name");
        assert_eq!(sanitize_component("CON"), "CON_");
        assert_eq!(sanitize_component("nul.txt"), "nul.txt_");
        assert_eq!(sanitize_component("..."), "_");
        assert_eq!(sanitize_rel("a/b?/c."), "a/b/c");
    }

    #[test]
    fn relative_paths() {
        let base = Path::new("/x/Mods");
        assert_eq!(rel_from(base, Path::new("/x/mods/Furina/Rem")).as_deref(), Some("Furina/Rem"));
        assert_eq!(rel_from(base, Path::new("/y/Furina")), None);
        assert_eq!(join_rel(base, "Furina/Rem").unwrap(), Path::new("/x/Mods/Furina/Rem"));
        assert!(join_rel(base, "../x").is_none());
        assert!(join_rel(base, "C:/x").is_none());
        assert!(join_rel(base, "/etc").is_none());
        assert_eq!(windows_drive("d:\\mods"), Some("D:".into()));
        assert_eq!(windows_drive("/run/media"), None);
    }
}
