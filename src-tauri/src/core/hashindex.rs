//! Bundled hash index (SPEC §5): TextureOverride hash -> entity, built by scripts/build-hash-index.mjs.

use super::model::{Category, HashIndexInfo};
use serde::Deserialize;
use std::collections::HashMap;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IndexGroup {
    Character,
    Weapon,
    Npc,
    Enemy,
    Misc,
    Skill,
}

#[derive(Debug, Clone, Deserialize)]
pub struct IndexEntity {
    pub key: String,
    pub name: String,
    pub group: IndexGroup,
    #[serde(default)]
    pub base: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct RawIndex {
    #[serde(default)]
    date: Option<String>,
    #[serde(default)]
    entities: Vec<IndexEntity>,
    #[serde(default)]
    hashes: HashMap<String, Vec<(usize, String, String)>>,
}

#[derive(Debug, Clone)]
pub struct Hit {
    /// Index of the resolved entity (outfit variants already folded into their base).
    pub entity: usize,
    pub component: String,
}

impl Hit {
    /// Geometry buffers identify a model far better than a texture.
    pub fn is_geometry(&self) -> bool {
        matches!(self.component.as_str(), "position_vb" | "ib" | "blend_vb" | "texcoord_vb" | "draw_vb")
    }
}

#[derive(Debug, Clone, Default)]
pub struct HashIndex {
    pub date: Option<String>,
    pub entities: Vec<IndexEntity>,
    hashes: HashMap<String, Vec<Hit>>,
}

/// Extras that belong to a character (SPEC §4 `parentId`). Our own knowledge, not upstream data.
const KNOWN_EXTRAS: &[(&str, &str)] = &[("Oz", "Fischl")];

impl HashIndex {
    pub fn empty() -> Self {
        HashIndex::default()
    }

    pub fn load(path: &Path) -> std::io::Result<Self> {
        let raw: RawIndex = serde_json::from_slice(&std::fs::read(path)?).map_err(std::io::Error::other)?;
        Ok(Self::from_raw(raw))
    }

    pub fn from_json(text: &str) -> serde_json::Result<Self> {
        Ok(Self::from_raw(serde_json::from_str(text)?))
    }

    fn from_raw(raw: RawIndex) -> Self {
        let by_key: HashMap<String, usize> = raw.entities.iter().enumerate().map(|(i, e)| (e.key.clone(), i)).collect();
        let resolve = |i: usize| -> usize {
            raw.entities.get(i).and_then(|e| e.base.as_ref()).and_then(|b| by_key.get(b).copied()).unwrap_or(i)
        };
        let mut hashes: HashMap<String, Vec<Hit>> = HashMap::new();
        for (h, hits) in raw.hashes {
            let list = hashes.entry(h.to_ascii_lowercase()).or_default();
            for (i, comp, _part) in hits {
                if i < raw.entities.len() {
                    // skill effects (Oz's attack) are not a model to skin
                    if raw.entities[i].group == IndexGroup::Skill {
                        continue;
                    }
                    list.push(Hit { entity: resolve(i), component: comp });
                }
            }
        }
        hashes.retain(|_, v| !v.is_empty());
        HashIndex { date: raw.date, entities: raw.entities, hashes }
    }

    pub fn info(&self) -> HashIndexInfo {
        HashIndexInfo { date: self.date.clone(), entries: self.hashes.len() }
    }

    pub fn lookup(&self, hash: &str) -> &[Hit] {
        self.hashes.get(&hash.to_ascii_lowercase()).map(Vec::as_slice).unwrap_or(&[])
    }

    pub fn entity(&self, i: usize) -> &IndexEntity {
        &self.entities[i]
    }

    /// App category for an index entity. NPCs and others default to character (SPEC §5), known extras to extra.
    pub fn category(&self, i: usize) -> Category {
        let e = &self.entities[i];
        if KNOWN_EXTRAS.iter().any(|(n, _)| n.eq_ignore_ascii_case(&e.name)) {
            return Category::Extra;
        }
        match e.group {
            IndexGroup::Weapon => Category::Weapon,
            _ => Category::Character,
        }
    }

    pub fn parent_name(&self, i: usize) -> Option<&'static str> {
        let n = &self.entities[i].name;
        KNOWN_EXTRAS.iter().find(|(e, _)| e.eq_ignore_ascii_case(n)).map(|(_, p)| *p)
    }

    /// Names of entities that can own skins (variants folded into bases).
    pub fn entity_names(&self) -> impl Iterator<Item = (usize, &str)> {
        self.entities
            .iter()
            .enumerate()
            .filter(|(_, e)| e.base.is_none() && e.group != IndexGroup::Skill)
            .map(|(i, e)| (i, e.name.as_str()))
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;

    pub fn test_index() -> HashIndex {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/hash_index.test.json");
        HashIndex::load(&path).expect("fixtures/hash_index.test.json")
    }

    #[test]
    fn looks_up_real_hashes_from_the_test_index() {
        let idx = test_index();
        let hits = idx.lookup("65A4831F");
        assert!(!hits.is_empty());
        assert_eq!(idx.entity(hits[0].entity).name, "Sandrone");
        assert!(hits[0].is_geometry());
        let paimon = idx.lookup("1f7f0600");
        assert_eq!(idx.entity(paimon[0].entity).name, "Paimon");
        // Mona CN folds into Mona
        let cn = idx.lookup("515f3ce6");
        assert_eq!(idx.entity(cn[0].entity).name, "Mona");
        let oz = idx.entities.iter().position(|e| e.name == "Oz").unwrap();
        assert_eq!(idx.category(oz), Category::Extra);
        assert_eq!(idx.parent_name(oz), Some("Fischl"));
        assert!(idx.info().entries > 50);
    }
}
