//! `<Library>/library.json` (SPEC §4): atomic writes with `library.json.bak`, ids, lookups.

use super::error::AppResult;
use super::fsutil;
use super::model::{Category, Entity, Library, Skin};
use super::names;
use super::paths;
use std::path::{Path, PathBuf};

pub const FILE: &str = "library.json";

pub fn path(library_dir: &Path) -> PathBuf {
    library_dir.join(FILE)
}

pub fn load(library_dir: &Path) -> AppResult<Library> {
    Ok(fsutil::read_json_or_bak::<Library>(&path(library_dir))?.unwrap_or_default())
}

pub fn save(library_dir: &Path, lib: &Library) -> AppResult<()> {
    fsutil::write_json_atomic(&path(library_dir), lib, true)?;
    Ok(())
}

impl Library {
    pub fn entity(&self, id: &str) -> Option<&Entity> {
        self.entities.iter().find(|e| e.id == id)
    }

    pub fn entity_mut(&mut self, id: &str) -> Option<&mut Entity> {
        self.entities.iter_mut().find(|e| e.id == id)
    }

    pub fn skin(&self, id: &str) -> Option<&Skin> {
        self.skins.iter().find(|s| s.id == id)
    }

    pub fn skin_mut(&mut self, id: &str) -> Option<&mut Skin> {
        self.skins.iter_mut().find(|s| s.id == id)
    }

    /// The skin whose folder list contains exactly this folder (relative to Mods), case-insensitively.
    /// A new mod root inside an imported skin's folder is *not* owned, so re-scan can report it (SPEC §5 step 6).
    pub fn owner_of(&self, rel: &str) -> Option<&Skin> {
        self.skins.iter().find(|s| s.folders.iter().any(|f| paths::same_path(f, rel)))
    }

    /// The skin whose folders contain this path (for "open folder" and path lookups).
    pub fn owner_containing(&self, rel: &str) -> Option<&Skin> {
        self.skins.iter().find(|s| s.folders.iter().any(|f| paths::is_within(rel, f)))
    }

    pub fn find_entity_by_name(&self, name: &str) -> Option<&Entity> {
        let c = names::compact(name);
        self.entities.iter().find(|e| names::compact(&e.name) == c || e.aliases.iter().any(|a| names::compact(a) == c))
    }

    pub fn unique_entity_id(&self, name: &str) -> String {
        unique(&names::slug(name), |id| self.entity(id).is_some())
    }

    pub fn unique_skin_id(&self, entity_id: &str, name: &str) -> String {
        unique(&format!("{entity_id}--{}", names::slug(name)), |id| self.skin(id).is_some())
    }

    /// Get or create an entity by name. New entities get a unique slug id.
    pub fn ensure_entity(&mut self, name: &str, category: Category, parent_id: Option<String>) -> String {
        if let Some(e) = self.find_entity_by_name(name) {
            return e.id.clone();
        }
        let id = self.unique_entity_id(name);
        self.entities.push(Entity { id: id.clone(), name: name.to_string(), category, parent_id, ..Entity::default() });
        id
    }

    /// Add a skin and link it to its entity.
    pub fn add_skin(&mut self, skin: Skin) {
        if let Some(e) = self.entity_mut(&skin.entity_id)
            && !e.skin_ids.contains(&skin.id)
        {
            e.skin_ids.push(skin.id.clone());
        }
        self.skins.push(skin);
    }

    pub fn remove_skin(&mut self, id: &str) -> Option<Skin> {
        let pos = self.skins.iter().position(|s| s.id == id)?;
        let skin = self.skins.remove(pos);
        if let Some(e) = self.entity_mut(&skin.entity_id) {
            e.skin_ids.retain(|s| s != id);
        }
        Some(skin)
    }
}

fn unique(base: &str, taken: impl Fn(&str) -> bool) -> String {
    if !taken(base) {
        return base.to_string();
    }
    (2..).map(|n| format!("{base}-{n}")).find(|c| !taken(c)).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_keeps_a_backup() {
        let dir = tempfile::tempdir().unwrap();
        let mut lib = Library::default();
        let e = lib.ensure_entity("Furina", Category::Character, None);
        lib.add_skin(Skin {
            id: lib.unique_skin_id(&e, "Remembrance"),
            entity_id: e.clone(),
            name: "Remembrance".into(),
            folders: vec!["Furina/Remembrance".into()],
            added_at: "2026-10-19T00:00:00Z".into(),
            ..Skin::default()
        });
        save(dir.path(), &lib).unwrap();
        save(dir.path(), &lib).unwrap();
        assert!(fsutil::with_suffix(&path(dir.path()), ".bak").exists());
        let back = load(dir.path()).unwrap();
        assert_eq!(back, lib);
        assert_eq!(back.entity("furina").unwrap().skin_ids, vec!["furina--remembrance".to_string()]);
        assert_eq!(back.owner_of("furina/REMEMBRANCE").unwrap().name, "Remembrance");
        assert!(back.owner_of("furina/REMEMBRANCE/sub").is_none());
        assert_eq!(back.owner_containing("furina/REMEMBRANCE/sub").unwrap().name, "Remembrance");
        assert_eq!(lib.ensure_entity("furina", Category::Character, None), "furina");
        assert_eq!(lib.unique_skin_id("furina", "Remembrance"), "furina--remembrance-2");
    }

    #[test]
    fn missing_library_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load(dir.path()).unwrap(), Library::default());
    }
}
