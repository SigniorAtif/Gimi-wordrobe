//! Data model (SPEC §4). Serialised camelCase to match `src/api/types.ts`.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Category {
    #[default]
    Character,
    Weapon,
    Extra,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Entity {
    pub id: String,
    pub name: String,
    pub category: Category,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub portrait: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub skin_ids: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PreviewSource {
    Gamebanana,
    Archive,
    User,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub file: String,
    pub source: PreviewSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Modifier {
    Ctrl,
    Alt,
    Shift,
    Windows,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KeyDevice {
    Keyboard,
    Xinput,
    Mouse,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedKey {
    pub vk: String,
    pub required: Vec<Modifier>,
    pub forbidden: Vec<Modifier>,
    pub device: KeyDevice,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum HotkeyKind {
    Toggle,
    Cycle,
    Hold,
    #[default]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hotkey {
    pub keys: String,
    pub label: String,
    pub kind: HotkeyKind,
    pub gated: bool,
    pub section: String,
    pub ini_file: String,
    #[serde(default)]
    pub parsed: Vec<ParsedKey>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Skin {
    pub id: String,
    pub entity_id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub folders: Vec<String>,
    #[serde(default)]
    pub nsfw: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub game_banana_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_archive: Option<String>,
    #[serde(default)]
    pub previews: Vec<Preview>,
    #[serde(default)]
    pub hotkeys: Vec<Hotkey>,
    #[serde(default)]
    pub hashes: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub persist: Option<BTreeMap<String, f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    pub added_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Library {
    pub version: u32,
    #[serde(default)]
    pub entities: Vec<Entity>,
    #[serde(default)]
    pub skins: Vec<Skin>,
}

impl Default for Library {
    fn default() -> Self {
        Library { version: 1, entities: vec![], skins: vec![] }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum Loader {
    #[serde(rename = "xxmi")]
    Xxmi,
    #[default]
    #[serde(rename = "3dmigoto")]
    Migoto,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct ModsPaths {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub xxmi: Option<String>,
    #[serde(rename = "3dmigoto", default, skip_serializing_if = "Option::is_none")]
    pub migoto: Option<String>,
}

impl ModsPaths {
    pub fn get(&self, loader: Loader) -> Option<&str> {
        match loader {
            Loader::Xxmi => self.xxmi.as_deref(),
            Loader::Migoto => self.migoto.as_deref(),
        }
        .filter(|s| !s.trim().is_empty())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum DisableMethod {
    #[default]
    Move,
    Prefix,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum LayoutMode {
    Pages,
    #[default]
    Shelves,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ReduceMotion {
    #[default]
    System,
    On,
    Off,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum WhenHidden {
    #[default]
    Stub,
    Invisible,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NsfwSettings {
    pub hotkey: String,
    pub when_hidden: WhenHidden,
    pub auto_rehide: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pin_hash: Option<String>,
}

impl Default for NsfwSettings {
    fn default() -> Self {
        NsfwSettings { hotkey: "Ctrl+H".into(), when_hidden: WhenHidden::Stub, auto_rehide: true, pin_hash: None }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    #[serde(default)]
    pub active_loader: Loader,
    #[serde(default)]
    pub mods_path: ModsPaths,
    #[serde(default)]
    pub library_path: String,
    #[serde(default)]
    pub disable_method: DisableMethod,
    #[serde(default)]
    pub layout: LayoutMode,
    #[serde(default)]
    pub reduce_motion: ReduceMotion,
    #[serde(default)]
    pub nsfw: NsfwSettings,
}

impl Settings {
    pub fn mods_path(&self) -> Option<&str> {
        self.mods_path.get(self.active_loader)
    }

    pub fn is_configured(&self) -> bool {
        self.mods_path().is_some() && !self.library_path.trim().is_empty()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SkinLocation {
    Mods,
    Stash,
    Disabled,
    Missing,
    Partial,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkinDiskState {
    pub location: SkinLocation,
    pub active: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LibraryReason {
    Known,
    Heuristic,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryMod {
    pub path: String,
    pub name: String,
    pub reason: LibraryReason,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DiskState {
    pub mods_path: Option<String>,
    pub mods_exists: bool,
    pub skins: BTreeMap<String, SkinDiskState>,
    pub active: BTreeMap<String, Vec<String>>,
    pub libraries: Vec<LibraryMod>,
    pub unknown_roots: Vec<String>,
    /// Every .zip/.rar/.7z below Mods (the archive library and stray copies), relative to Mods.
    #[serde(default)]
    pub archives: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HashIndexInfo {
    pub date: Option<String>,
    pub entries: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryInfo {
    pub rolled_back: usize,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub settings: Settings,
    pub library: Library,
    pub disk: DiskState,
    pub changed_outside: bool,
    pub recovered: Option<RecoveryInfo>,
    pub hash_index: HashIndexInfo,
    pub configured: bool,
    /// Library and Mods on the same drive (moves are instant renames). None when unknown.
    pub same_drive: Option<bool>,
    /// Something the user must fix before the app can do its job (unreadable library.json, bad settings file).
    pub notice: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_round_trip_uses_spec_field_names() {
        let mut s = Settings::default();
        s.mods_path.migoto = Some("D:\\mods\\3dmigoto\\Mods".into());
        s.library_path = "D:\\mods\\SkinLibrary".into();
        let json = serde_json::to_value(&s).unwrap();
        assert_eq!(json["activeLoader"], "3dmigoto");
        assert_eq!(json["modsPath"]["3dmigoto"], "D:\\mods\\3dmigoto\\Mods");
        assert_eq!(json["disableMethod"], "move");
        assert_eq!(json["layout"], "shelves");
        assert_eq!(json["nsfw"]["whenHidden"], "stub");
        let back: Settings = serde_json::from_value(json).unwrap();
        assert_eq!(back, s);
        assert!(back.is_configured());
    }

    #[test]
    fn settings_tolerate_missing_fields() {
        let s: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(s.disable_method, DisableMethod::Move);
        assert!(!s.is_configured());
        // a partial nsfw object keeps the other defaults instead of failing the whole file
        let s: Settings = serde_json::from_str(r#"{"nsfw":{"whenHidden":"invisible"}}"#).unwrap();
        assert_eq!(s.nsfw.hotkey, "Ctrl+H");
        assert!(s.nsfw.auto_rehide);
        assert_eq!(s.nsfw.when_hidden, WhenHidden::Invisible);
    }
}
