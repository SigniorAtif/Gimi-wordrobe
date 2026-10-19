//! Name normalisation and fuzzy entity matching (SPEC §5 step 4c): "Benny" -> Bennett, "Veresa" -> Varesa,
//! "Neuvilette" -> Neuvillette, "Aloysha.ini" -> Alyosha, "TomeOfTheEternalFlow.ini" -> Tome of the Eternal Flow.

/// Spellings seen in folder and archive names that edit distance can't bridge. Our own list.
pub const BUILTIN_ALIASES: &[(&str, &str)] = &[
    ("benny", "Bennett"),
    ("ei", "Raiden Shogun"),
    ("raiden", "Raiden Shogun"),
    ("childe", "Tartaglia"),
    ("yae", "Yae Miko"),
    ("miko", "Yae Miko"),
    ("kazuha", "Kazuha"),
    ("ayaka", "Kamisato Ayaka"),
    ("ayato", "Kamisato Ayato"),
    ("sara", "Kujou Sara"),
    ("shinobu", "Kuki Shinobu"),
    ("heizou", "Shikanoin Heizou"),
];

const STOPWORDS: &[&str] = &[
    "a",
    "an",
    "the",
    "of",
    "and",
    "by",
    "mod",
    "mods",
    "skin",
    "skins",
    "release",
    "updated",
    "update",
    "upscale",
    "recolor",
    "recolour",
    "recolorupscale",
    "zip",
    "rar",
    "7z",
    "ini",
    "final",
    "fixed",
    "fix",
    "new",
    "ver",
    "version",
    "sfw",
    "nsfw",
    "toggle",
    "toggles",
    "merged",
    "og",
];

/// Generic part folder names that say nothing about the entity (Sandrone's Face/Eyes, Varesa's Outfit).
pub const GENERIC_PARTS: &[&str] = &[
    "face",
    "faces",
    "eyes",
    "eye",
    "mouth",
    "brows",
    "hair",
    "head",
    "body",
    "outfit",
    "outfits",
    "dress",
    "texture",
    "textures",
    "face texture",
    "face textures",
    "mesh",
    "meshes",
    "parts",
    "part",
    "extra",
    "extras",
    "resource",
    "resources",
    "res",
    "files",
    "mod",
    "main",
    "base",
    "default",
    "alt",
    "alts",
    "variant",
    "variants",
    "weapon",
];

/// Drop accents from common Latin letters, keeping case (CamelCase splitting runs afterwards).
fn fold_char(c: char) -> char {
    let lower = c.to_lowercase().next().unwrap_or(c);
    let folded = match lower {
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' => 'a',
        'è' | 'é' | 'ê' | 'ë' => 'e',
        'ì' | 'í' | 'î' | 'ï' => 'i',
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' => 'o',
        'ù' | 'ú' | 'û' | 'ü' => 'u',
        'ç' => 'c',
        'ñ' => 'n',
        _ => return c,
    };
    if c.is_uppercase() { folded.to_ascii_uppercase() } else { folded }
}

/// Split CamelCase: "TomeOfTheEternalFlow" -> "Tome Of The Eternal Flow", "BearCharlotte" -> "Bear Charlotte".
pub fn split_camel(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len() + 8);
    for (i, &c) in chars.iter().enumerate() {
        if i > 0 {
            let p = chars[i - 1];
            let next_lower = chars.get(i + 1).map(|n| n.is_lowercase()).unwrap_or(false);
            if c.is_uppercase() && (p.is_lowercase() || (p.is_uppercase() && next_lower)) {
                out.push(' ');
            }
        }
        out.push(c);
    }
    out
}

/// Lowercase, accent-folded tokens with stopwords, version numbers and GameBanana id suffixes removed.
pub fn tokens(s: &str) -> Vec<String> {
    let folded: String = strip_ext(s).chars().map(fold_char).collect();
    let mut out = vec![];
    let pieces: Vec<&str> = folded.split(|c: char| !c.is_alphanumeric()).filter(|p| !p.is_empty()).collect();
    // version / id pieces are dropped before CamelCase splitting, which would break "ae58f" apart.
    // GameBanana ids only ever end a longer download name ("varesa_by_neyori_e0d4f"), never "paimon_cc116".
    for (i, piece) in pieces.iter().enumerate() {
        let low = piece.to_lowercase();
        if is_version(&low) || (i == pieces.len() - 1 && pieces.len() >= 3 && is_gb_suffix(&low)) {
            continue;
        }
        for t in split_camel(piece).split(' ') {
            // letters and digits apart: "Varesa1" -> "varesa", "1"
            let t = t.to_lowercase();
            let mut word = String::new();
            let mut words = vec![];
            for c in t.chars() {
                if !word.is_empty() && (c.is_ascii_digit() != word.chars().last().unwrap().is_ascii_digit()) {
                    words.push(std::mem::take(&mut word));
                }
                word.push(c);
            }
            if !word.is_empty() {
                words.push(word);
            }
            for w in words {
                if !w.is_empty() && !STOPWORDS.contains(&w.as_str()) && !is_version(&w) {
                    out.push(w);
                }
            }
        }
    }
    out
}

fn strip_ext(s: &str) -> &str {
    for ext in [".ini", ".zip", ".rar", ".7z"] {
        // byte slicing must land on a char boundary ("Éva" is 4 bytes)
        let cut = s.len().wrapping_sub(ext.len());
        if s.len() > ext.len() && s.get(cut..).is_some_and(|t| t.eq_ignore_ascii_case(ext)) {
            return &s[..cut];
        }
    }
    s
}

fn is_version(t: &str) -> bool {
    let t = t.strip_prefix('v').unwrap_or(t);
    !t.is_empty() && t.chars().all(|c| c.is_ascii_digit())
}

/// GameBanana appends a 5-hex id: "alyosha_-_frostbound_hunt_ae58f".
fn is_gb_suffix(t: &str) -> bool {
    t.len() == 5 && t.chars().all(|c| c.is_ascii_hexdigit()) && t.chars().any(|c| c.is_ascii_digit())
}

/// Compact form for whole-name comparison: "Yae Miko" -> "yaemiko".
pub fn compact(s: &str) -> String {
    tokens(s).concat()
}

pub fn is_generic_part(name: &str) -> bool {
    let n: String = name.to_lowercase().chars().map(fold_char).collect();
    let n = n.trim();
    GENERIC_PARTS.contains(&n) || tokens(name).is_empty()
}

/// Edit distance where an adjacent transposition counts as one edit ("aloysha" vs "alyosha").
pub fn edit_distance(a: &str, b: &str) -> usize {
    osa_distance(a, b)
}

fn osa_distance(a: &str, b: &str) -> usize {
    // Optimal string alignment distance (adjacent transposition counts as 1).
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let (n, m) = (a.len(), b.len());
    let mut d = vec![vec![0usize; m + 1]; n + 1];
    for (i, row) in d.iter_mut().enumerate() {
        row[0] = i;
    }
    for (j, cell) in d[0].iter_mut().enumerate() {
        *cell = j;
    }
    for i in 1..=n {
        for j in 1..=m {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            d[i][j] = (d[i - 1][j] + 1).min(d[i][j - 1] + 1).min(d[i - 1][j - 1] + cost);
            if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] {
                d[i][j] = d[i][j].min(d[i - 2][j - 2] + 1);
            }
        }
    }
    d[n][m]
}

/// Fuzzy token equality: exact, or a small typo for longer words.
pub fn token_close(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    let len = a.chars().count().min(b.chars().count());
    if len < 5 {
        return false;
    }
    let max = if len >= 9 { 2 } else { 1 };
    osa_distance(a, b) <= max
}

/// How well a piece of text (folder, archive or ini name) names an entity. 0 = no match.
/// 1.0 exact, 0.85 alias, 0.75 all tokens fuzzily present, 0.6 compact substring.
pub fn name_score(text: &str, entity_name: &str, aliases: &[String]) -> f32 {
    let t = tokens(text);
    if t.is_empty() {
        return 0.0;
    }
    let e = tokens(entity_name);
    if e.is_empty() {
        return 0.0;
    }
    let tc = t.concat();
    let ec = e.concat();
    if tc == ec {
        return 1.0;
    }
    for a in aliases {
        let ac = compact(a);
        if !ac.is_empty() && (tc == ac || t.contains(&ac)) {
            return 0.85;
        }
    }
    for (alias, target) in BUILTIN_ALIASES {
        if compact(target) == ec && (tc == *alias || t.iter().any(|x| x == alias)) {
            return 0.85;
        }
    }
    if e.iter().all(|et| t.iter().any(|tt| token_close(tt, et))) {
        return 0.75;
    }
    // multi-word entity glued in a folder name ("YaeMiko" handled by split; "dilucinwhite" is not)
    // the rest of the glued word must be long enough to be its own word ("Monarch" is not Mona + "rch")
    let elen = ec.chars().count();
    if elen >= 4
        && t.iter().any(|tt| {
            let tl = tt.chars().count();
            (tt.starts_with(&ec) && tl >= elen + 4) || (elen >= 6 && tt.contains(&ec) && tl >= elen + 4)
        })
    {
        return 0.6;
    }
    if tc.chars().count() >= 5 && token_close(&tc, &ec) {
        return 0.75;
    }
    // shortened name: every text token is in the entity name and covers at least 2/3 of it ("Tome_of_Eternal")
    if t.len() >= 2 && t.iter().all(|tt| e.iter().any(|et| token_close(tt, et))) && t.len() * 3 >= e.len() * 2 {
        return 0.55;
    }
    0.0
}

/// Slug for ids: "Tome of the Eternal Flow" -> "tome-of-the-eternal-flow".
pub fn slug(s: &str) -> String {
    let folded: String = s.to_lowercase().chars().map(fold_char).collect();
    let mut out = String::new();
    for c in folded.chars() {
        if c.is_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let out = out.trim_end_matches('-').to_string();
    if out.is_empty() { "item".into() } else { out }
}

/// Display form of a folder-ish name: "sandrone_marionette" -> "Sandrone Marionette",
/// "BearCharlotte" -> "Bear Charlotte". Names that already have capitals keep their own casing.
pub fn display_name(s: &str) -> String {
    let spaced = split_camel(strip_ext(s)).replace(['_'], " ");
    let spaced = spaced.split_whitespace().collect::<Vec<_>>().join(" ");
    if spaced.chars().any(|c| c.is_uppercase()) {
        return spaced;
    }
    const SMALL: &[&str] = &["of", "the", "a", "an", "and", "by", "in", "on", "to"];
    spaced
        .split(' ')
        .enumerate()
        .map(|(i, w)| {
            if i > 0 && SMALL.contains(&w) {
                return w.to_string();
            }
            // short ids like "cc116" read better in capitals
            if w.len() <= 6 && w.chars().any(|c| c.is_ascii_digit()) && w.chars().any(|c| c.is_alphabetic()) {
                return w.to_uppercase();
            }
            let mut c = w.chars();
            match c.next() {
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokenises_real_names() {
        assert_eq!(tokens("alyosha_-_frostbound_hunt_ae58f.zip"), vec!["alyosha", "frostbound", "hunt"]);
        assert_eq!(tokens("TomeOfTheEternalFlow.ini"), vec!["tome", "eternal", "flow"]);
        assert_eq!(tokens("FurinaRemembrance-kaichume_6.1"), vec!["furina", "remembrance", "kaichume"]);
        assert_eq!(tokens("kazuha_multi_v10"), vec!["kazuha", "multi"]);
        assert_eq!(tokens("paimon_cc116"), vec!["paimon", "cc"]);
        assert_eq!(tokens("Varesa lewd - Culottée à mort"), vec!["varesa", "lewd", "culottee", "mort"]);
    }

    #[test]
    fn matches_spellings_from_the_archive_library() {
        let none: Vec<String> = vec![];
        assert!(name_score("Benny", "Bennett", &none) > 0.8);
        assert!(name_score("Veresa", "Varesa", &none) >= 0.75);
        assert!(name_score("Neuvilette", "Neuvillette", &none) >= 0.75);
        assert!(name_score("Aloysha.ini", "Alyosha", &none) >= 0.75);
        assert!(name_score("YaeMiko", "Yae Miko", &none) >= 1.0);
        assert!(name_score("TomeOfTheEternalFlow.ini", "Tome of the Eternal Flow", &none) >= 1.0);
        assert!(name_score("Tome of Eternal Blood Flow", "Tome of the Eternal Flow", &none) >= 0.75);
        assert!(name_score("sandrone_marionette_by_neyori", "Sandrone", &none) >= 0.75);
        assert!(name_score("dilucinwhitebetterhair", "Diluc", &none) >= 0.6);
        assert!(name_score("Tome_of_Eternal", "Tome of the Eternal Flow", &none) >= 0.5);
        assert_eq!(name_score("Monarch", "Mona", &none), 0.0);
        assert_eq!(name_score("OzMod", "Oz", &none), 1.0);
        assert_eq!(name_score("Ozone", "Oz", &none), 0.0);
        assert_eq!(name_score("Face", "Fischl", &none), 0.0);
    }

    #[test]
    fn slugs_and_display_names() {
        assert_eq!(slug("Tome of the Eternal Flow"), "tome-of-the-eternal-flow");
        assert_eq!(slug("Culottée à mort"), "culottee-a-mort");
        // multi-byte names never panic, and capital accents fold too
        assert_eq!(tokens("Éva"), vec!["eva"]);
        assert_eq!(tokens("Léabc.zip"), vec!["leabc"]);
        assert_eq!(name_score("Éclair", "Eclair", &[]), 1.0);
        assert_eq!(display_name("sandrone_marionette"), "Sandrone Marionette");
        assert_eq!(display_name("BearCharlotte"), "Bear Charlotte");
        assert_eq!(display_name("A Teaspoon of Transcendence"), "A Teaspoon of Transcendence");
        assert_eq!(display_name("paimon_cc116"), "Paimon CC116");
        assert_eq!(display_name("tome_of_eternal"), "Tome of Eternal");
        assert!(is_generic_part("Face Texture"));
        assert!(is_generic_part("Outfit"));
        assert!(!is_generic_part("A Teaspoon of Transcendence"));
        assert_eq!(edit_distance("abc", "abc"), 0);
        assert_eq!(edit_distance("aloysha", "alyosha"), 1);
    }
}
