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
  // the PIN hash never leaves the backend; Snapshot.pinSet says whether one is set
}

export interface Settings {
  activeLoader: Loader;
  modsPath: { xxmi?: string; "3dmigoto"?: string };
  libraryPath: string;
  disableMethod: DisableMethod;
  layout: LayoutMode;
  reduceMotion: ReduceMotion;
  nsfw: NsfwSettings;
  /** Leave added mods exactly as they come (no ORFix, no hash or blend updates). */
  skipModFixes?: boolean;
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
  /** Every .zip/.rar/.7z below Mods (the archive library and stray copies), relative to Mods. */
  archives: string[];
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
  /** A PIN guards revealing NSFW skins (SPEC §6 PIN lock). */
  pinSet: boolean;
  /** The tables for updating old mods (modfix_data.json) were found, so adds can fix mods. */
  modFixes: boolean;
}

/** Answer to a PIN guess. Wrong guesses are throttled: FREE tries, then a lockout that doubles. */
export interface PinCheck {
  ok: boolean;
  /** seconds until another guess is accepted (0 = now) */
  retryIn: number;
  /** guesses left before a lockout */
  triesLeft: number;
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
  /** Skins enabled or disabled. */
  changed: number;
  /** The disk changed since the UI last looked: nothing was applied, `snapshot` is the fresh state. */
  changedOutside: boolean;
  warnings: string[];
}

/** Metadata edits (A3). Empty strings clear optional fields. */
export interface SkinPatch {
  name?: string;
  author?: string;
  version?: string;
  notes?: string;
  nsfw?: boolean;
  gameBananaUrl?: string;
  entityId?: string;
  hotkeyLabels?: { section: string; iniFile: string; keys: string; label: string }[];
  /** Preview files (`Preview.file`) in the new order; the first is the cover. Files left out keep their order after these. */
  previewOrder?: string[];
}

export interface EntityPatch {
  name?: string;
  category?: Category;
  /** "" clears the parent */
  parentId?: string;
  aliases?: string[];
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

export interface EntityGuess {
  entityId: string | null; // existing entity id, if any
  name: string;
  category: Category;
  parentName?: string;
  confidence: number; // 0..1
  reason: "hash" | "learned" | "name" | "folder";
}

export interface ArchiveRoot {
  /** First folder of the root inside the archive ("" = the whole archive). */
  path: string;
  folders: string[];
  inis: string[];
  hotkeys: number;
  hashes: string[];
  guess: EntityGuess | null;
  /** Nested inside another root (Bennett's sword, Oz): split it out to toggle it on its own. */
  nested: boolean;
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
  wrapper: string | null;
}

export interface NewEntity {
  name: string;
  category: Category;
  parentId?: string;
  /** parent by name when it may not exist yet (Oz under a Fischl created by the same import) */
  parentName?: string;
  portraitPath?: string;
}

export interface AddTarget {
  entityId?: string | null;
  newEntity?: NewEntity;
  skinName: string;
}

export type PreviewChoice = "gamebanana" | "archive" | "user" | "later";

export interface AddSkinRequest {
  archivePath: string;
  main: AddTarget;
  /** `folders` lists every folder of a root that has several (Face + Outfit) */
  splits: (AddTarget & { rootPath: string; folders?: string[] })[];
  exclude: string[];
  nsfw: boolean;
  gameBananaUrl?: string;
  /** The main skin's author (from `gameBananaInfo`, or typed in). */
  author?: string;
  /**
   * "gamebanana" adds no previews itself: call `fetchGameBananaPreviews(mainSkinId)` right after the add (the main
   * skin is the last of `AddSkinResult.skinIds`), so the card can show the "Fetching from GameBanana…" state.
   */
  previewSource: PreviewChoice;
  userImagePath?: string;
  makeActive: boolean;
}

export interface AddSkinResult {
  snapshot: Snapshot;
  /** Every skin added; the main skin is the last. */
  skinIds: string[];
  warnings: string[];
  /** What updating the mod for the current game changed (ORFix, old hashes), as one line; null = nothing. */
  fixNote: string | null;
}

export interface AddProgress {
  done: number;
  total: number;
  label: string;
}

/** OS file drag over the window (Tauri drag-drop events; positions in CSS pixels). */
export type FileDropEvent =
  | { type: "enter"; paths: string[]; x: number; y: number }
  | { type: "over"; x: number; y: number }
  | { type: "drop"; paths: string[]; x: number; y: number }
  | { type: "leave" };

// ----- first-run import / Re-scan review (§5) -----

export type ImportSource =
  | { kind: "installed"; folders: string[] }
  | { kind: "archive"; archive: string; root: string; folders: string[]; main: boolean; nested: boolean };

export interface ImportItem {
  key: string;
  source: ImportSource;
  guess: EntityGuess;
  skinName: string;
  author?: string | null;
  nsfw: boolean;
  hotkeys: number;
  images: number;
  /** the archive's main item, for its other roots */
  parent?: string | null;
  /** default for a non-main root: its own skin rather than part of the main one */
  own: boolean;
}

export interface ImportArchive {
  path: string;
  size: number;
  error?: string | null;
}

export interface ImportPlan {
  items: ImportItem[];
  archives: ImportArchive[];
  stray: string[];
}

export interface ImportChoice extends AddTarget {
  key: string;
  include: boolean;
  nsfw: boolean;
  own: boolean;
}

export interface ImportRequest {
  choices: ImportChoice[];
  moveArchives: boolean;
  moveStray: boolean;
  /** item keys (or existing skin ids) that stay on where an entity has several enabled */
  keepActive: string[];
}

export interface ImportResult {
  snapshot: Snapshot;
  added: number;
  warnings: string[];
}

// ----- Previews (§10) -----

/** A GameBanana mod page (`apiv11/Mod/<id>/ProfilePage`), read without storing anything. */
export interface GameBananaInfo {
  modId: number;
  name: string;
  author: string | null;
  version: string | null;
  /** GameBanana hides the page by default or rates it for nudity / sexual content: pre-tick NSFW. */
  nsfw: boolean;
  /** Full-size image URLs on images.gamebanana.com, GameBanana's order (at most 12). */
  images: string[];
}

export interface PreviewFetchResult {
  snapshot: Snapshot;
  /** New previews stored (images the skin already had aren't counted). */
  added: number;
  /** Images that failed to download (the others were kept). */
  failed: number;
  /** GameBanana rates the mod 18+, so the skin was marked NSFW. */
  markedNsfw: boolean;
}

export interface FolderPreviewsResult {
  snapshot: Snapshot;
  added: number;
}

export interface ImportProgress {
  done: number;
  total: number;
  label: string;
}
