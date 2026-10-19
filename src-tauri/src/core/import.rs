//! Turning scan candidates into library entities and skins: names, authors, hotkeys, hashes.

use super::model::{Category, Hotkey, Library, Skin};
use super::names;
use super::scanner::{Candidate, Guess, GuessReason, ScanResult};

const NOISE: &[&str] =
    &["mod", "mods", "release", "updated", "update", "skin", "upscale", "recolorupscale", "final", "fixed"];

/// Current time as RFC 3339 UTC, e.g. "2026-10-19T09:41:00Z".
pub fn now_iso() -> String {
    let secs =
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // civil-from-days (Howard Hinnant)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

/// Words of a folder or archive name with their original casing ("FurinaRemembrance-kaichume_6.1" ->
/// ["Furina", "Remembrance", "kaichume", "6", "1"]).
fn words(s: &str) -> Vec<String> {
    let stem = s
        .rsplit_once('.')
        .filter(|(_, e)| ["zip", "rar", "7z", "ini"].contains(&e.to_ascii_lowercase().as_str()))
        .map(|(a, _)| a)
        .unwrap_or(s);
    let pieces: Vec<&str> =
        stem.split(|c: char| c == '_' || c == '-' || c.is_whitespace() || c == '.').filter(|p| !p.is_empty()).collect();
    let n = pieces.len();
    pieces
        .iter()
        .enumerate()
        // GameBanana appends a 5-hex id to downloads with 3+ name parts
        .filter(|(i, p)| {
            !(*i == n - 1
                && n >= 3
                && p.len() == 5
                && p.chars().all(|c| c.is_ascii_hexdigit())
                && p.chars().any(|c| c.is_ascii_digit()))
        })
        .flat_map(|(_, p)| names::split_camel(p).split(' ').map(str::to_string).collect::<Vec<_>>())
        .filter(|w| !w.is_empty())
        .collect()
}

fn is_number(w: &str) -> bool {
    let w = w.strip_prefix(['v', 'V']).unwrap_or(w);
    !w.is_empty() && w.chars().all(|c| c.is_ascii_digit())
}

/// Split "<name> by <author>" and "<name>-<author>" (a single lowercase word after a hyphen, as GameBanana
/// file names often end). Returns (remaining words, author).
fn split_author(s: &str) -> (Vec<String>, Option<String>) {
    let ws = words(s);
    if let Some(pos) = ws.iter().position(|w| w.eq_ignore_ascii_case("by")) {
        let author: Vec<&String> = ws[pos + 1..].iter().filter(|w| !is_number(w)).collect();
        if !author.is_empty() && pos > 0 {
            let a = author.iter().map(|w| w.as_str()).collect::<Vec<_>>().join(" ");
            return (ws[..pos].to_vec(), Some(names::display_name(&a)));
        }
    }
    if let Some((left, right)) = s.rsplit_once('-') {
        let rw: Vec<String> = words(right).into_iter().filter(|w| !is_number(w)).collect();
        if rw.len() == 1 && rw[0].chars().all(|c| c.is_lowercase() || c.is_ascii_digit()) && !words(left).is_empty() {
            return (words(left), Some(rw[0].clone()));
        }
    }
    (ws, None)
}

/// Skin name and author suggested from folders (and the archive, when there is one), minus the entity's name.
pub fn suggest_name(
    folders: &[String],
    entity_name: &str,
    archive: Option<&str>,
    child_hint: Option<&str>,
) -> (String, Option<String>) {
    let ent_tokens = names::tokens(entity_name);
    let strip_entity = |ws: Vec<String>| -> Vec<String> {
        ws.into_iter()
            .filter(|w| {
                let t = w.to_lowercase();
                !is_number(w)
                    && !NOISE.contains(&t.as_str())
                    && !ent_tokens.iter().any(|e| names::token_close(&t, e))
                    && !names::tokens(w).is_empty()
            })
            .collect()
    };
    // candidate texts, most specific first
    let mut texts: Vec<String> = vec![];
    let common = common_parent(folders);
    if folders.len() == 1 {
        let comps: Vec<&str> = folders[0].split('/').collect();
        for c in comps.iter().rev() {
            texts.push(c.to_string());
        }
    } else if let Some(c) = &common {
        for comp in c.split('/').rev() {
            texts.push(comp.to_string());
        }
    }
    if let Some(h) = child_hint {
        texts.insert(0, h.to_string());
    }
    if let Some(a) = archive {
        texts.push(a.to_string());
    }
    let mut author = None;
    for t in &texts {
        if names::is_generic_part(t) && !t.contains(' ') {
            continue;
        }
        let (ws, a) = split_author(t);
        if author.is_none() {
            author = a;
        }
        let rest = strip_entity(ws);
        if !rest.is_empty() {
            let joined = rest.join(" ");
            return (names::display_name(&joined), author);
        }
    }
    (format!("{entity_name} mod"), author)
}

fn common_parent(folders: &[String]) -> Option<String> {
    let first: Vec<&str> = folders.first()?.split('/').collect();
    let mut n = first.len().saturating_sub(1);
    for f in &folders[1..] {
        let parts: Vec<&str> = f.split('/').collect();
        n = n.min(first.iter().zip(parts.iter()).take_while(|(a, b)| a.eq_ignore_ascii_case(b)).count());
    }
    (n > 0).then(|| first[..n].join("/"))
}

/// The folder every ini of a single-folder candidate sits under, one level down (`Odette` -> "Black Swan").
pub fn child_hint(scan: &ScanResult, c: &Candidate) -> Option<String> {
    if c.folders.len() != 1 {
        return None;
    }
    let base = format!("{}/", c.folders[0].to_lowercase());
    let mut hint: Option<String> = None;
    for &i in &c.inis {
        let rel = &scan.inis[i].rel;
        let below = rel.get(base.len()..).filter(|_| rel.to_lowercase().starts_with(&base))?;
        let first = below.split('/').next()?;
        if !below.contains('/') {
            return None; // an ini directly in the folder
        }
        match &hint {
            None => hint = Some(first.to_string()),
            Some(h) if h.eq_ignore_ascii_case(first) => {}
            _ => return None,
        }
    }
    hint
}

/// Keep user-edited hotkey labels when a skin's inis are parsed again.
pub fn merge_hotkey_labels(old: &[Hotkey], fresh: Vec<Hotkey>) -> Vec<Hotkey> {
    fresh
        .into_iter()
        .map(|mut h| {
            if let Some(o) = old.iter().find(|o| {
                o.section.eq_ignore_ascii_case(&h.section)
                    && o.ini_file.eq_ignore_ascii_case(&h.ini_file)
                    && o.keys.eq_ignore_ascii_case(&h.keys)
            }) {
                h.label = o.label.clone();
            }
            h
        })
        .collect()
}

/// Resolve a guess to a library entity, creating it (and its parent) when needed.
pub fn ensure_entity_for(lib: &mut Library, g: &Guess) -> String {
    if let Some(id) = g.entity_id.as_ref().filter(|id| lib.entity(id).is_some()) {
        return id.clone();
    }
    let parent_id = g.parent_name.as_ref().map(|p| lib.ensure_entity(p, Category::Character, None));
    lib.ensure_entity(&g.name, g.category, parent_id)
}

pub fn fallback_guess(c: &Candidate) -> Guess {
    Guess {
        entity_id: None,
        name: names::display_name(c.folders[0].rsplit('/').next().unwrap_or("Unknown")),
        category: if c.geometry { Category::Character } else { Category::Weapon },
        parent_name: None,
        confidence: 0.1,
        reason: GuessReason::NewName,
    }
}

/// Build a skin for a candidate (not yet added).
pub fn skin_for(lib: &mut Library, scan: &ScanResult, c: &Candidate, guess: &Guess, archive: Option<&str>) -> Skin {
    let entity_id = ensure_entity_for(lib, guess);
    let entity_name = lib.entity(&entity_id).map(|e| e.name.clone()).unwrap_or_else(|| guess.name.clone());
    let hint = child_hint(scan, c);
    let (name, author) = suggest_name(&c.folders, &entity_name, archive, hint.as_deref());
    Skin {
        id: lib.unique_skin_id(&entity_id, &name),
        entity_id,
        name,
        author,
        folders: c.folders.clone(),
        hotkeys: scan.hotkeys_of(c),
        hashes: c.hashes.iter().cloned().collect(),
        added_at: now_iso(),
        ..Skin::default()
    }
}

/// First-run quick import: adopt every candidate no skin owns yet. Returns the number added.
pub fn adopt_unowned(lib: &mut Library, scan: &ScanResult) -> usize {
    let mut added = 0;
    for c in &scan.candidates {
        if c.folders.iter().any(|f| lib.owner_of(f).is_some()) {
            continue;
        }
        let guess = c.guess.clone().unwrap_or_else(|| fallback_guess(c));
        let skin = skin_for(lib, scan, c, &guess, None);
        lib.add_skin(skin);
        added += 1;
    }
    added
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn names_skins_from_folders() {
        assert_eq!(suggest_name(&f(&["Furina/Remembrance"]), "Furina", None, None), ("Remembrance".into(), None));
        assert_eq!(suggest_name(&f(&["paimon_cc116"]), "Paimon", None, None).0, "CC116");
        assert_eq!(
            suggest_name(
                &f(&["sandrone_marionette_by_neyori/Face", "sandrone_marionette_by_neyori/outfit"]),
                "Sandrone",
                None,
                None
            ),
            ("Marionette".into(), Some("Neyori".into()))
        );
        assert_eq!(
            suggest_name(
                &f(&["sandrone_marionette_by_neyori/A Teaspoon of Transcendence"]),
                "A Teaspoon of Transcendence",
                None,
                None
            ),
            ("Sandrone Marionette".into(), Some("Neyori".into()))
        );
        assert_eq!(suggest_name(&f(&["Odette"]), "Odette", None, Some("Black Swan")).0, "Black Swan");
        assert_eq!(suggest_name(&f(&["Varesa/Face", "Varesa/Outfit"]), "Varesa", None, None).0, "Varesa mod");
        assert_eq!(
            suggest_name(&f(&["FurinaRemembrance-kaichume_6.1"]), "Furina", None, None),
            ("Remembrance".into(), Some("kaichume".into()))
        );
        assert_eq!(suggest_name(&f(&["Kazuha/Multi"]), "Kazuha", None, None).0, "Multi");
    }

    #[test]
    fn iso_time_shape() {
        let t = now_iso();
        assert_eq!(t.len(), 20);
        assert!(t.ends_with('Z') && t.starts_with("20"));
    }
}
