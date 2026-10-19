//! In-mod toggle states (SPEC §3): 3DMigoto rewrites `d3dx_user.ini` with only the loaded inis' variables, so a
//! disabled skin's toggles vanish. The app copies each active skin's lines into `Skin.persist` whenever it reads the
//! disk, and merges them back when Apply activates the skin.

use super::error::AppResult;
use super::fsutil;
use super::ini;
use super::model::Skin;
use super::paths;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const FILE: &str = "d3dx_user.ini";

/// `d3dx_user.ini` sits next to the Mods folder (`D:\mods\3dmigoto\d3dx_user.ini`, `...\GIMI\d3dx_user.ini`).
pub fn user_ini_path(mods: &Path) -> Option<PathBuf> {
    mods.parent().map(|p| p.join(FILE))
}

#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub key: String,
    pub value: f64,
}

/// Every `$\mods\...` assignment in the file (keys as written, values parsed).
pub fn read_entries(text: &str) -> Vec<Entry> {
    let mut out = vec![];
    for line in text.lines() {
        let t = line.trim();
        if !t.starts_with('$') {
            continue;
        }
        let Some((k, v)) = t.split_once('=') else { continue };
        let key = k.trim();
        if !key.to_lowercase().starts_with("$\\mods\\") {
            continue; // never touch $\global\... or other namespaces (libraries own them)
        }
        if let Ok(value) = v.trim().parse::<f64>() {
            out.push(Entry { key: key.to_string(), value });
        }
    }
    out
}

/// Lines that belong to a skin: key starts with `$\mods\<one of its folders>\`.
pub fn entries_for<'a>(entries: &'a [Entry], skin: &Skin) -> impl Iterator<Item = &'a Entry> + 'a {
    let prefixes: Vec<String> = skin.folders.iter().map(|f| paths::persist_prefix(f)).collect();
    entries.iter().filter(move |e| {
        // same lowercasing as persist_prefix (Unicode, not just ASCII)
        let k = e.key.to_lowercase();
        prefixes.iter().any(|p| k.starts_with(p.as_str()))
    })
}

/// Copy the active skins' current values into `Skin.persist` (current values win, old keys are kept).
/// Returns true when anything changed.
pub fn backup(user_ini: &Path, skins: &mut [&mut Skin]) -> bool {
    let Ok(bytes) = std::fs::read(user_ini) else { return false };
    let entries = read_entries(&ini::decode(&bytes));
    let mut changed = false;
    for skin in skins.iter_mut() {
        let fresh: Vec<Entry> = entries_for(&entries, skin).cloned().collect();
        if fresh.is_empty() {
            continue;
        }
        let map = skin.persist.get_or_insert_with(BTreeMap::new);
        for e in fresh {
            // keys compare case-insensitively; keep the file's spelling
            let existing = map.keys().find(|k| k.eq_ignore_ascii_case(&e.key)).cloned();
            match existing {
                Some(k) if map[&k] == e.value && k == e.key => {}
                Some(k) => {
                    map.remove(&k);
                    map.insert(e.key, e.value);
                    changed = true;
                }
                None => {
                    map.insert(e.key, e.value);
                    changed = true;
                }
            }
        }
    }
    changed
}

fn fmt_value(v: f64) -> String {
    if v.fract() == 0.0 && v.abs() < 1e15 { format!("{}", v as i64) } else { format!("{v}") }
}

/// Merge saved lines into the file text: replace matching keys (case-insensitive) in place, append the rest to the
/// end of `[Constants]`, keep every other line exactly as it was.
pub fn merge_text(text: &str, lines: &BTreeMap<String, f64>) -> String {
    let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let mut pending: Vec<(&String, &f64)> = lines.iter().collect();
    let mut out: Vec<String> = vec![];
    let mut in_constants = false;
    let mut constants_end: Option<usize> = None;
    let mut saw_constants = false;
    for line in text.lines() {
        let t = line.trim();
        if t.starts_with('[') {
            if in_constants {
                constants_end = Some(out.len());
            }
            in_constants = t.eq_ignore_ascii_case("[constants]");
            saw_constants |= in_constants;
            out.push(line.to_string());
            continue;
        }
        if t.starts_with('$')
            && let Some((k, _)) = t.split_once('=')
        {
            let key = k.trim();
            if let Some(pos) = pending.iter().position(|(pk, _)| pk.eq_ignore_ascii_case(key)) {
                let (_, v) = pending.remove(pos);
                out.push(format!("{key} = {}", fmt_value(*v)));
                continue;
            }
        }
        out.push(line.to_string());
    }
    if in_constants {
        // [Constants] ran to the end of the file; insert before trailing blank lines
        let mut end = out.len();
        while end > 0 && out[end - 1].trim().is_empty() {
            end -= 1;
        }
        constants_end = Some(end);
    }
    let new_lines: Vec<String> = pending.iter().map(|(k, v)| format!("{k} = {}", fmt_value(**v))).collect();
    if !new_lines.is_empty() {
        match (saw_constants, constants_end) {
            (true, Some(at)) => {
                for (i, l) in new_lines.into_iter().enumerate() {
                    out.insert(at + i, l);
                }
            }
            _ => {
                if !out.is_empty() && !out.last().map(|l| l.trim().is_empty()).unwrap_or(true) {
                    out.push(String::new());
                }
                out.push("[Constants]".into());
                out.extend(new_lines);
            }
        }
    }
    let mut s = out.join(eol);
    s.push_str(eol);
    s
}

/// Merge saved lines into the raw file bytes, keeping its encoding, BOM, line endings and every other byte
/// exactly as they were (SPEC §3). Matching keys keep their original spelling; only the value changes.
pub fn merge_bytes(orig: &[u8], lines: &BTreeMap<String, f64>) -> Vec<u8> {
    // UTF-16 files: round-trip through text and write UTF-16 back with the same BOM
    if orig.starts_with(&[0xFF, 0xFE]) || orig.starts_with(&[0xFE, 0xFF]) {
        let le = orig[0] == 0xFF;
        let merged = merge_text(&ini::decode(orig), lines);
        let mut out = if le { vec![0xFF, 0xFE] } else { vec![0xFE, 0xFF] };
        for u in merged.encode_utf16() {
            out.extend_from_slice(&if le { u.to_le_bytes() } else { u.to_be_bytes() });
        }
        return out;
    }
    let crlf = orig.windows(2).any(|w| w == b"\r\n");
    let eol: &[u8] = if crlf { b"\r\n" } else { b"\n" };
    let mut pending: Vec<(&String, &f64)> = lines.iter().collect();
    let mut out: Vec<Vec<u8>> = vec![];
    let mut in_constants = false;
    let mut saw_constants = false;
    let mut constants_end: Option<usize> = None;
    let body = orig.strip_suffix(b"\n").unwrap_or(orig);
    if !orig.is_empty() {
        for raw in body.split(|b| *b == b'\n') {
            let has_cr = raw.ends_with(b"\r");
            let line = if has_cr { &raw[..raw.len() - 1] } else { raw };
            let t = line.trim_ascii();
            if t.starts_with(b"[") {
                if in_constants {
                    constants_end = Some(out.len());
                }
                in_constants = t.eq_ignore_ascii_case(b"[constants]");
                saw_constants |= in_constants;
                out.push(raw.to_vec());
                continue;
            }
            if t.starts_with(b"$")
                && let Some(eq) = t.iter().position(|b| *b == b'=')
            {
                let key_bytes = t[..eq].trim_ascii();
                let key = String::from_utf8_lossy(key_bytes).to_lowercase();
                if let Some(pos) = pending.iter().position(|(pk, _)| pk.to_lowercase() == key) {
                    let (_, v) = pending.remove(pos);
                    let mut l = key_bytes.to_vec();
                    l.extend_from_slice(format!(" = {}", fmt_value(*v)).as_bytes());
                    if has_cr {
                        l.push(b'\r');
                    }
                    out.push(l);
                    continue;
                }
            }
            out.push(raw.to_vec());
        }
    }
    if in_constants {
        let mut end = out.len();
        while end > 0 && out[end - 1].trim_ascii().is_empty() {
            end -= 1;
        }
        constants_end = Some(end);
    }
    let cr = if crlf { "\r" } else { "" };
    let new_lines: Vec<Vec<u8>> =
        pending.iter().map(|(k, v)| format!("{k} = {}{cr}", fmt_value(**v)).into_bytes()).collect();
    if !new_lines.is_empty() {
        match (saw_constants, constants_end) {
            (true, Some(at)) => {
                for (i, l) in new_lines.into_iter().enumerate() {
                    out.insert(at + i, l);
                }
            }
            _ => {
                if out.last().map(|l| !l.trim_ascii().is_empty()).unwrap_or(false) {
                    out.push(cr.as_bytes().to_vec());
                }
                out.push(format!("[Constants]{cr}").into_bytes());
                out.extend(new_lines);
            }
        }
    }
    let mut bytes = out.join(&b"\n"[..]);
    if !bytes.is_empty() {
        bytes.extend_from_slice(if crlf { b"\n" } else { eol });
    }
    bytes
}

/// Restore skins' saved toggles into d3dx_user.ini: keep a one-time copy of the original, `.bak` the current file,
/// then write atomically. Best effort (SPEC §3), but never on top of a file it couldn't read.
pub fn restore(user_ini: &Path, skins: &[&Skin]) -> AppResult<usize> {
    let mut lines = BTreeMap::new();
    for s in skins {
        if let Some(p) = &s.persist {
            for (k, v) in p {
                lines.insert(k.clone(), *v);
            }
        }
    }
    if lines.is_empty() {
        return Ok(0);
    }
    let original = match std::fs::read(user_ini) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => vec![],
        Err(e) => return Err(e.into()),
    };
    let merged = merge_bytes(&original, &lines);
    if merged == original {
        return Ok(0);
    }
    if user_ini.exists() {
        let first = fsutil::with_suffix(user_ini, ".skinswitcher-original");
        if !first.exists() {
            std::fs::copy(user_ini, &first)?;
        }
        std::fs::copy(user_ini, fsutil::with_suffix(user_ini, ".bak"))?;
    }
    fsutil::write_atomic(user_ini, &merged, false)?;
    Ok(lines.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    const USER_INI: &str = "; AUTOMATICALLY GENERATED FILE - DO NOT EDIT\r\n[Constants]\r\n$version = 7\r\n$\\global\\healthbar\\health = -1\r\n$\\mods\\sandrone_marionette_by_neyori\\outfit\\sandrone.ini\\hat = 2\r\n$\\mods\\sandrone_marionette_by_neyori\\outfit\\sandrone.ini\\body = 2\r\n";

    fn sandrone() -> Skin {
        Skin {
            id: "sandrone--marionette".into(),
            folders: vec!["sandrone_marionette_by_neyori/Face".into(), "sandrone_marionette_by_neyori/outfit".into()],
            ..Skin::default()
        }
    }

    #[test]
    fn reads_only_mods_keys() {
        let e = read_entries(USER_INI);
        assert_eq!(e.len(), 2);
        assert!(e.iter().all(|x| x.key.starts_with("$\\mods\\")));
    }

    #[test]
    fn backup_then_restore_survives_the_game_dropping_the_lines() {
        let t = tempfile::tempdir().unwrap();
        let p = t.path().join(FILE);
        std::fs::write(&p, USER_INI).unwrap();
        let mut s = sandrone();
        assert!(backup(&p, &mut [&mut s]));
        assert_eq!(s.persist.as_ref().unwrap().len(), 2);

        // the game exits with the skin disabled: its lines are gone
        std::fs::write(&p, "[Constants]\r\n$version = 7\r\n$\\global\\healthbar\\health = -1\r\n").unwrap();
        assert_eq!(restore(&p, &[&s]).unwrap(), 2);
        let text = std::fs::read_to_string(&p).unwrap();
        assert!(text.contains("$\\mods\\sandrone_marionette_by_neyori\\outfit\\sandrone.ini\\hat = 2"));
        assert!(text.contains("$\\global\\healthbar\\health = -1"), "other lines untouched");
        assert!(fsutil::with_suffix(&p, ".bak").exists());
    }

    #[test]
    fn merge_replaces_case_insensitively_and_appends_into_constants() {
        let mut lines = BTreeMap::new();
        lines.insert("$\\mods\\Sandrone_Marionette_by_Neyori\\outfit\\Sandrone.ini\\HAT".to_string(), 1.0);
        lines.insert("$\\mods\\furina\\remembrance\\furina.ini\\hat".to_string(), 1.0);
        let text = "[Constants]\n$version = 7\n$\\mods\\sandrone_marionette_by_neyori\\outfit\\sandrone.ini\\hat = 2\n\n[Other]\nx = 1\n";
        let out = merge_text(text, &lines);
        assert!(out.contains("$\\mods\\sandrone_marionette_by_neyori\\outfit\\sandrone.ini\\hat = 1"));
        let furina_at = out.find("furina.ini\\hat = 1").unwrap();
        assert!(furina_at < out.find("[Other]").unwrap(), "appended inside [Constants]");
        assert_eq!(out.matches("sandrone.ini\\hat").count(), 1);
        // no [Constants] at all
        let out2 = merge_text("", &lines);
        assert!(out2.starts_with("[Constants]"));
    }

    #[test]
    fn byte_merge_keeps_bom_crlf_and_non_utf8_bytes() {
        let mut orig = vec![0xEF, 0xBB, 0xBF];
        orig.extend_from_slice(b"; caf\xe9 (ANSI)\r\n[Constants]\r\n$version = 7\r\n$\\mods\\x\\a.ini\\hat = 0\r\n");
        let mut lines = BTreeMap::new();
        lines.insert("$\\mods\\X\\A.ini\\HAT".to_string(), 2.0);
        lines.insert("$\\mods\\y\\b.ini\\v".to_string(), 1.0);
        let out = merge_bytes(&orig, &lines);
        assert!(out.starts_with(&[0xEF, 0xBB, 0xBF]), "BOM kept");
        assert!(out.windows(5).any(|w| w == b"caf\xe9 "), "ANSI byte untouched");
        let text = String::from_utf8_lossy(&out);
        assert!(text.contains("$\\mods\\x\\a.ini\\hat = 2\r\n"), "original key spelling, new value: {text}");
        assert!(text.contains("$\\mods\\y\\b.ini\\v = 1\r\n"));
        assert!(!text.contains("\n\n"));
    }

    #[test]
    fn unicode_folder_names_match_their_keys() {
        let s = Skin { folders: vec!["Éclair/Outfit".into()], ..Skin::default() };
        let e = read_entries("[Constants]\n$\\mods\\éclair\\outfit\\x.ini\\hat = 1\n");
        assert_eq!(entries_for(&e, &s).count(), 1);
    }

    #[test]
    fn newer_values_win_and_old_keys_stay() {
        let t = tempfile::tempdir().unwrap();
        let p = t.path().join(FILE);
        let mut s = sandrone();
        let mut old = BTreeMap::new();
        old.insert("$\\mods\\sandrone_marionette_by_neyori\\outfit\\sandrone.ini\\hat".to_string(), 0.0);
        old.insert(
            "$\\mods\\sandrone_marionette_by_neyori\\face\\face texture\\sandrone.ini\\swapvar".to_string(),
            3.0,
        );
        s.persist = Some(old);
        std::fs::write(&p, USER_INI).unwrap();
        backup(&p, &mut [&mut s]);
        let m = s.persist.unwrap();
        assert_eq!(m["$\\mods\\sandrone_marionette_by_neyori\\outfit\\sandrone.ini\\hat"], 2.0);
        assert_eq!(m["$\\mods\\sandrone_marionette_by_neyori\\face\\face texture\\sandrone.ini\\swapvar"], 3.0);
    }
}
