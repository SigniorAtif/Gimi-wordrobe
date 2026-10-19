// Shared data model (SPEC §4). Mirrors the Rust serde structs in src-tauri/src/core/model.rs (camelCase).

export type Category = "character" | "weapon" | "extra";

export interface Entity {
  id: string;
  name: string;
  category: Category;
  portrait?: string;
  parentId?: string;
  aliases?: string[];
  skinIds: string[];
}

export type PreviewSource = "gamebanana" | "archive" | "user";

export interface Preview {
  file: string; // path relative to the Library (previews/<skinId>/<file>)
  source: PreviewSource;
}

export type Modifier = "ctrl" | "alt" | "shift" | "windows";

export interface ParsedKey {
  vk: string; // normalised virtual key, e.g. "8", "F1", "VK_OEM_PLUS", "XB_A"
  required: Modifier[];
  forbidden: Modifier[];
  device: "keyboard" | "xinput" | "mouse";
}

export interface Hotkey {
  keys: string; // raw value, e.g. "no_modifiers 6"
  label: string;
  kind: "toggle" | "cycle" | "hold" | "unknown";
  gated: boolean;
  section: string;
  iniFile: string;
  parsed: ParsedKey[]; // a key line can hold several alternatives (rare); empty when unparseable
}

export interface Skin {
  id: string;
  entityId: string;
  name: string;
  author?: string;
  version?: string;
  folders: string[];
  nsfw: boolean;
  gameBananaUrl?: string;
  sourceArchive?: string;
  previews: Preview[];
  hotkeys: Hotkey[];
  hashes: string[];
  persist?: Record<string, number>;
  notes?: string;
  addedAt: string;
}

export interface Library {
  version: number;
  entities: Entity[];
  skins: Skin[];
}

export type Loader = "xxmi" | "3dmigoto";
export type DisableMethod = "move" | "prefix";
export type LayoutMode = "pages" | "shelves";
export type ReduceMotion = "system" | "on" | "off";

export interface NsfwSettings {
  hotkey: string; // e.g. "Ctrl+H"
  whenHidden: "stub" | "invisible";
  autoRehide: boolean;
  pinHash?: string; // "salt$sha256hex"; present = PIN lock on
}

export interface Settings {
  activeLoader: Loader;
  modsPath: { xxmi?: string; "3dmigoto"?: string };
  libraryPath: string;
  disableMethod: DisableMethod;
  layout: LayoutMode;
  reduceMotion: ReduceMotion;
  nsfw: NsfwSettings;
}

/** Where a skin's folders currently are on disk. Active = all folders in Mods, none DISABLED. */
export type SkinLocation = "mods" | "stash" | "disabled" | "missing" | "partial";

export interface SkinDiskState {
  location: SkinLocation;
  active: boolean;
}

export interface LibraryMod {
  path: string; // relative to Mods
  name: string;
  reason: "known" | "heuristic";
}

export interface DiskState {
  modsPath: string | null;
  modsExists: boolean;
  skins: Record<string, SkinDiskState>;
  /** entityId -> active skin ids (more than one = conflict to resolve) */
  active: Record<string, string[]>;
  libraries: LibraryMod[];
  /** Mod roots found in Mods that no skin in the library owns (shown by Re-scan review). */
  unknownRoots: string[];
}

export interface HashIndexInfo {
  date: string | null; // snapshot date of the upstream data
  entries: number;
}

export interface RecoveryInfo {
  rolledBack: number;
  message: string;
}

export interface Snapshot {
  settings: Settings;
  library: Library;
  disk: DiskState;
  /** Disk changed since the last snapshot the UI saw (set by rescan before Apply). */
  changedOutside: boolean;
  recovered: RecoveryInfo | null;
  hashIndex: HashIndexInfo;
  /** False until a Mods folder and Library are configured (first run). */
  configured: boolean;
  /** Library and Mods on the same drive, so moves are instant renames. null = unknown. */
  sameDrive: boolean | null;
  /** Something the user must fix first (unreadable library.json, invalid settings file). */
  notice: string | null;
}

export interface FirstRunDefaults {
  loader: Loader | null;
  mods3dmigoto: string | null;
  modsXxmi: string | null;
  library: string | null;
}

/** entityId -> skinId, or null for "Original / no mod". Only entities the user changed. */
export type Picks = Record<string, string | null>;

export interface ApplyProgress {
  done: number;
  total: number;
  label: string;
}

export interface ApplyResult {
  snapshot: Snapshot;
  changed: number;
}

export interface ApiError {
  code: string;
  message: string;
}

// ----- Archives / add flow (§5, §9) -----

export interface ArchiveEntry {
  path: string;
  size: number;
  isDir: boolean;
}

export interface ArchiveRoot {
  /** Path inside the archive (after wrapper strip) of the mod root folder. */
  path: string;
  inis: string[];
  hotkeys: number;
  hashes: string[];
  guess: EntityGuess | null;
  /** Nested inside another root and must be moved out on import (Bennett's sword, Oz). */
  nested: boolean;
}

export interface EntityGuess {
  entityId: string | null; // existing entity id, if any
  name: string;
  category: Category;
  parentId?: string;
  confidence: number; // 0..1
  reason: "hash" | "learned" | "name" | "folder";
}

export interface ArchiveSummary {
  path: string;
  fileName: string;
  size: number;
  fileCount: number;
  iniCount: number;
  images: string[]; // candidate previews, best first
  entries: ArchiveEntry[];
  roots: ArchiveRoot[];
  skipped: string[]; // junk and bundled library copies that will not be extracted
  suggestedName: string;
  nsfwGuess: boolean;
}

export interface NewEntity {
  name: string;
  category: Category;
  parentId?: string;
  portraitPath?: string;
}

export interface AddSkinPart {
  rootPath: string; // ArchiveRoot.path
  entityId: string | null;
  newEntity?: NewEntity;
  skinName: string;
}

export interface AddSkinRequest {
  archivePath: string;
  parts: AddSkinPart[]; // first part is the main skin; others are split-out skins
  nsfw: boolean;
  gameBananaUrl?: string;
  previewSource: "gamebanana" | "archive" | "user" | "later";
  userImagePath?: string;
  makeActive: boolean;
}

export interface AddSkinResult {
  snapshot: Snapshot;
  skinIds: string[];
}

export interface GameBananaInfo {
  id: number;
  name: string;
  author: string;
  images: string[];
  version?: string;
}

// ----- First-run import (§5) -----

export interface ImportItem {
  key: string; // stable id inside the plan
  kind: "installed" | "archive";
  /** Installed: folders relative to Mods. Archive: archive path relative to the archive library. */
  folders: string[];
  archive?: string;
  guess: EntityGuess;
  skinName: string;
  nsfw: boolean;
  active: boolean;
  hashes: string[];
  hotkeys: number;
  /** Paths moved out to their own skin on import (nested foreign roots). */
  splitFrom?: string;
  note?: string;
  include: boolean;
}

export interface ImportPlan {
  items: ImportItem[];
  libraries: LibraryMod[];
  /** Detected by heuristic only; the user confirms ("Looks like a library"). */
  maybeLibraries: LibraryMod[];
  archiveLibrary: string | null; // e.g. "Charecters and wepon"
  strayArchives: string[]; // .zip/.rar/.7z files directly in Mods
  moveArchives: boolean; // pre-checked
  skippedJunk: string[];
}

export interface ImportProgress {
  done: number;
  total: number;
  label: string;
}
