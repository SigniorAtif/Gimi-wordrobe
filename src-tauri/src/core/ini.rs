//! Tolerant 3DMigoto ini reader: sections, `key = value` entries, `;` comments, BOM / UTF-16 / CRLF.

use std::path::Path;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Section {
    pub name: String,
    /// (lowercased key, raw value) in file order
    pub entries: Vec<(String, String)>,
}

impl Section {
    pub fn get(&self, key: &str) -> Option<&str> {
        let k = key.to_ascii_lowercase();
        self.entries.iter().find(|(ek, _)| *ek == k).map(|(_, v)| v.as_str())
    }

    pub fn name_lower(&self) -> String {
        self.name.to_ascii_lowercase()
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Ini {
    /// Entries before the first section header (e.g. `namespace = ...`).
    pub preamble: Section,
    pub sections: Vec<Section>,
}

pub fn decode(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]) {
        let le = bytes[0] == 0xFF;
        let units: Vec<u16> = bytes[2..]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|c| if le { u16::from_le_bytes([c[0], c[1]]) } else { u16::from_be_bytes([c[0], c[1]]) })
            .collect();
        return String::from_utf16_lossy(&units);
    }
    let b = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    String::from_utf8_lossy(b).into_owned()
}

impl Ini {
    pub fn parse(text: &str) -> Ini {
        let mut ini = Ini::default();
        let mut cur: Option<Section> = None;
        let text = text.strip_prefix('\u{feff}').unwrap_or(text);
        for raw in text.lines() {
            let line = raw.trim();
            if line.is_empty() || line.starts_with(';') || line.starts_with('#') {
                continue;
            }
            if line.starts_with('[')
                && let Some(end) = line.find(']')
            {
                if let Some(s) = cur.take() {
                    ini.sections.push(s);
                }
                cur = Some(Section { name: line[1..end].trim().to_string(), entries: vec![] });
                continue;
            }
            if let Some(eq) = line.find('=') {
                let key = line[..eq].trim().to_ascii_lowercase();
                let mut val = line[eq + 1..].trim();
                // trailing comments are not standard in 3DMigoto, but some mods add " ; note"
                if let Some(c) = val.find(" ;") {
                    val = val[..c].trim();
                }
                let target = cur.as_mut().unwrap_or(&mut ini.preamble);
                target.entries.push((key, val.to_string()));
            }
        }
        if let Some(s) = cur {
            ini.sections.push(s);
        }
        ini
    }

    pub fn read(path: &Path) -> std::io::Result<Ini> {
        Ok(Ini::parse(&decode(&std::fs::read(path)?)))
    }

    pub fn namespace(&self) -> Option<&str> {
        self.preamble.get("namespace").filter(|s| !s.is_empty())
    }

    pub fn sections_with_prefix<'a>(&'a self, prefix: &'a str) -> impl Iterator<Item = &'a Section> + 'a {
        let p = prefix.to_ascii_lowercase();
        self.sections.iter().filter(move |s| s.name_lower().starts_with(&p))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_sections_preamble_and_comments() {
        let ini = Ini::parse(
            "\u{feff}namespace = global\\ORFix\r\n; comment\r\n[KeyHat]\r\nkey = no_modifiers 8\r\n condition = $active == 1\r\n\t$Hat = 0,1,2\r\n[TextureOverrideX]\nhash = 65A4831F ; old hash\n",
        );
        assert_eq!(ini.namespace(), Some("global\\ORFix"));
        assert_eq!(ini.sections.len(), 2);
        assert_eq!(ini.sections[0].get("KEY"), Some("no_modifiers 8"));
        assert_eq!(ini.sections[0].get("condition"), Some("$active == 1"));
        assert_eq!(ini.sections[1].get("hash"), Some("65A4831F"));
        assert_eq!(ini.sections_with_prefix("textureoverride").count(), 1);
    }

    #[test]
    fn decodes_utf16() {
        let text = "[KeyA]\nkey = 6\n";
        let mut bytes = vec![0xFF, 0xFE];
        for u in text.encode_utf16() {
            bytes.extend_from_slice(&u.to_le_bytes());
        }
        assert_eq!(Ini::parse(&decode(&bytes)).sections[0].get("key"), Some("6"));
    }
}
