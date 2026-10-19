//! Hotkey parsing and overlap rules (SPEC §8). Canonical parser: it fills `Hotkey.parsed`, which the UI
//! (src/lib/hotkeys.ts) uses to compute conflicts against the pending state.

use super::ini::Ini;
use super::model::{Hotkey, HotkeyKind, KeyDevice, Modifier, ParsedKey};

const ALL_MODS: [Modifier; 4] = [Modifier::Ctrl, Modifier::Alt, Modifier::Shift, Modifier::Windows];

fn norm_mod(s: &str) -> Option<Modifier> {
    match s {
        "ctrl" | "control" => Some(Modifier::Ctrl),
        "alt" | "menu" => Some(Modifier::Alt),
        "shift" => Some(Modifier::Shift),
        "windows" | "win" => Some(Modifier::Windows),
        _ => None,
    }
}

fn norm_vk(t: &str) -> String {
    let mut u = t.to_ascii_uppercase();
    if u.chars().count() == 1 || u.starts_with("0X") {
        return u;
    }
    if let Some(rest) = u.strip_prefix("VK_") {
        u = rest.to_string();
    }
    match u.as_str() {
        "CONTROL" => "CTRL".into(),
        "RETURN" => "ENTER".into(),
        "ESC" => "ESCAPE".into(),
        "PRIOR" => "PAGEUP".into(),
        "NEXT" => "PAGEDOWN".into(),
        "BACK" => "BACKSPACE".into(),
        _ => u,
    }
}

/// Parse one key binding: one virtual key plus modifier rules, space separated, case-insensitive.
/// A modifier that isn't mentioned is "don't care".
pub fn parse_key(raw: &str) -> Option<ParsedKey> {
    let mut required: Vec<Modifier> = vec![];
    let mut forbidden: Vec<Modifier> = vec![];
    let mut vk: Option<String> = None;
    for t in raw.split_whitespace() {
        let low = t.to_ascii_lowercase();
        if low == "no_modifiers" {
            forbidden.extend(ALL_MODS);
            continue;
        }
        if let Some(m) = low.strip_prefix("no_").and_then(norm_mod) {
            forbidden.push(m);
            continue;
        }
        if let Some(m) = norm_mod(&low) {
            required.push(m);
            continue;
        }
        vk = Some(norm_vk(t));
    }
    let vk = vk?;
    forbidden.retain(|m| !required.contains(m));
    let mut req: Vec<Modifier> = ALL_MODS.iter().copied().filter(|m| required.contains(m)).collect();
    let mut forb: Vec<Modifier> = ALL_MODS.iter().copied().filter(|m| forbidden.contains(m)).collect();
    req.dedup();
    forb.dedup();
    let device = if vk.starts_with("XB_") {
        KeyDevice::Xinput
    } else if matches!(vk.as_str(), "LBUTTON" | "RBUTTON" | "MBUTTON" | "XBUTTON1" | "XBUTTON2") {
        KeyDevice::Mouse
    } else {
        KeyDevice::Keyboard
    };
    Some(ParsedKey { vk, required: req, forbidden: forb, device })
}

/// Two keys overlap when some real key press fires both: same vk, and neither requires a modifier the other forbids.
pub fn keys_overlap(a: &ParsedKey, b: &ParsedKey) -> bool {
    if a.device != KeyDevice::Keyboard || b.device != KeyDevice::Keyboard || a.vk != b.vk {
        return false;
    }
    let clash = |x: &ParsedKey, y: &ParsedKey| x.required.iter().any(|m| y.forbidden.contains(m));
    !clash(a, b) && !clash(b, a)
}

pub fn hotkeys_overlap(a: &Hotkey, b: &Hotkey) -> bool {
    a.parsed.iter().any(|x| b.parsed.iter().any(|y| keys_overlap(x, y)))
}

/// "[KeyHat]" -> "Hat", "[KeyToggleCoat]" -> "Toggle Coat", "[Key_Swap]" -> "Swap".
pub fn label_for(section: &str) -> String {
    let rest = if section.len() >= 3 && section[..3].eq_ignore_ascii_case("key") { &section[3..] } else { section };
    let rest = rest.trim_start_matches(|c: char| !c.is_alphanumeric());
    let mut out = String::new();
    let mut prev_lower = false;
    for c in rest.chars() {
        if c == '_' || c == '.' || c == '-' {
            if !out.ends_with(' ') {
                out.push(' ');
            }
            prev_lower = false;
            continue;
        }
        if c.is_uppercase() && prev_lower {
            out.push(' ');
        }
        prev_lower = c.is_lowercase() || c.is_ascii_digit();
        out.push(c);
    }
    let out = out.trim().to_string();
    if out.is_empty() { section.to_string() } else { out }
}

fn kind_of(t: Option<&str>) -> HotkeyKind {
    match t.map(|s| s.trim().to_ascii_lowercase()).as_deref() {
        Some("cycle") => HotkeyKind::Cycle,
        Some("toggle") => HotkeyKind::Toggle,
        Some("hold") => HotkeyKind::Hold,
        _ => HotkeyKind::Unknown,
    }
}

/// Every `[Key*]` section in an ini. `back` bindings become their own entry ("Hat (back)").
pub fn hotkeys_from_ini(ini: &Ini, ini_file: &str) -> Vec<Hotkey> {
    let mut out = vec![];
    for s in ini.sections_with_prefix("key") {
        let gated = s.get("condition").map(|c| !c.trim().is_empty()).unwrap_or(false);
        let label = label_for(&s.name);
        let kind = kind_of(s.get("type"));
        for (field, suffix) in [("key", ""), ("back", " (back)")] {
            for (k, v) in s.entries.iter() {
                if k != field || v.trim().is_empty() {
                    continue;
                }
                out.push(Hotkey {
                    keys: v.trim().to_string(),
                    label: format!("{label}{suffix}"),
                    kind,
                    gated,
                    section: s.name.clone(),
                    ini_file: ini_file.to_string(),
                    parsed: parse_key(v).into_iter().collect(),
                });
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn k(s: &str) -> ParsedKey {
        parse_key(s).unwrap()
    }

    #[test]
    fn parses_key_syntax() {
        let p = k("no_modifiers 6");
        assert_eq!(p.vk, "6");
        assert!(p.required.is_empty());
        assert_eq!(p.forbidden.len(), 4);
        assert_eq!(k("ALT 8").required, vec![Modifier::Alt]);
        assert_eq!(k("VK_F1").vk, "F1");
        assert_eq!(k("f1").vk, "F1");
        assert_eq!(k("ctrl no_shift x").forbidden, vec![Modifier::Shift]);
        assert_eq!(k("XB_A").device, KeyDevice::Xinput);
        assert_eq!(k("0x31").vk, "0X31");
        assert!(parse_key("  ").is_none());
    }

    #[test]
    fn overlap_rules_from_spec() {
        assert!(keys_overlap(&k("8"), &k("alt 8")));
        assert!(keys_overlap(&k("8"), &k("no_modifiers 8")));
        assert!(!keys_overlap(&k("no_modifiers 8"), &k("alt 8")));
        assert!(keys_overlap(&k("9"), &k("alt 9")));
        assert!(keys_overlap(&k("9"), &k("no_modifiers 9")));
        assert!(!keys_overlap(&k("XB_A"), &k("XB_A")));
    }

    #[test]
    fn reads_key_sections() {
        let ini = Ini::parse(
            "[KeyHat]\ncondition = $active == 1\ntype = cycle\nkey = no_modifiers 8\n$Hat = 0,1,2\n\
             [KeySwap]\nkey = alt 7\nback = alt 6\n[TextureOverrideX]\nhash = 1\n",
        );
        let hk = hotkeys_from_ini(&ini, "outfit/Sandrone.ini");
        assert_eq!(hk.len(), 3);
        assert_eq!(hk[0].label, "Hat");
        assert_eq!(hk[0].kind, HotkeyKind::Cycle);
        assert!(hk[0].gated);
        assert!(!hk[1].gated);
        assert_eq!(hk[2].label, "Swap (back)");
        assert_eq!(label_for("KeyToggleCoat"), "Toggle Coat");
        assert_eq!(label_for("Key_Swap"), "Swap");
    }
}
