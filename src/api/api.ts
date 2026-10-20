// The one typed interface every component goes through (SPEC §13). Two implementations:
// tauri.ts (real backend) and mock.ts (in-memory fixtures for the browser test harness, VITE_MOCK=1).
import type {
  AddProgress,
  AddSkinRequest,
  AddSkinResult,
  ApplyProgress,
  ApplyResult,
  ArchiveSummary,
  EntityPatch,
  FileDropEvent,
  FirstRunDefaults,
  ImportPlan,
  ImportRequest,
  ImportResult,
  Picks,
  PinCheck,
  Settings,
  SkinPatch,
  Snapshot,
} from "./types";

export type OpenTarget =
  | { kind: "mods" }
  | { kind: "library" }
  | { kind: "skin"; skinId: string }
  | { kind: "entity"; entityId: string };

export interface FolderPickOptions {
  title: string;
  defaultPath?: string;
}

export interface Api {
  readonly kind: "tauri" | "mock";
  /** Startup: load settings, recover an interrupted Apply, scan disk. */
  load(): Promise<Snapshot>;
  /** Re-read the Mods folder and Library. */
  rescan(): Promise<Snapshot>;
  /** Save settings (instantly, no Save button). Changing loader or paths re-scans. */
  saveSettings(settings: Settings): Promise<Snapshot>;
  /** Fetch the latest hash index from GI-Model-Importer-Assets, then re-scan (SPEC §5). */
  updateHashIndex(): Promise<Snapshot>;
  /** First-run pre-fill (SPEC §5): existing loader paths and a suggested Library. Windows only. */
  firstRunDefaults(): Promise<FirstRunDefaults>;
  pickFolder(opts: FolderPickOptions): Promise<string | null>;
  /** Apply pending picks as one batch with rollback (SPEC §3). */
  apply(picks: Picks, onProgress?: (p: ApplyProgress) => void): Promise<ApplyResult>;
  /** Folders and previews go to the Recycle Bin. */
  removeSkin(skinId: string): Promise<Snapshot>;
  /** Edit a skin's metadata (library.json only; the mod's files are never changed). */
  updateSkin(skinId: string, patch: SkinPatch): Promise<Snapshot>;
  updateEntity(entityId: string, patch: EntityPatch): Promise<Snapshot>;
  /** Pick an archive (.zip / .rar / .7z) or an image with the system dialog. */
  pickArchive(): Promise<string | null>;
  pickImage(): Promise<string | null>;
  /** List and analyse an archive for the add dialogs (refuses unsafe archives). */
  analyzeArchive(path: string): Promise<ArchiveSummary>;
  /** Extract & add; skins land inactive unless makeActive. */
  addSkin(req: AddSkinRequest, onProgress?: (p: AddProgress) => void): Promise<AddSkinResult>;
  /** First-run / Re-scan review list: reads only (SPEC §5). */
  planImport(onProgress?: (p: AddProgress) => void): Promise<ImportPlan>;
  applyImport(request: ImportRequest, onProgress?: (p: AddProgress) => void): Promise<ImportResult>;
  /** OS file drags over the window (SPEC §13: Tauri intercepts drops, so DOM drop events carry no paths). */
  onFileDrop(handler: (e: FileDropEvent) => void): Promise<() => void>;
  openFolder(target: OpenTarget): Promise<void>;
  openUrl(url: string): Promise<void>;
  setWindowTitle(title: string): Promise<void>;
  /** Check the NSFW PIN before revealing; always ok when no PIN is set. */
  verifyPin(pin: string): Promise<PinCheck>;
  /** Set (`next`), change or remove (`next` null) the PIN; an existing PIN must be given as `current`. */
  setPin(current: string | null, next: string | null): Promise<Snapshot>;
  /** The window was minimized (auto re-hide, SPEC §11). */
  onMinimize(handler: () => void): Promise<() => void>;
  /** URL for an image stored under the Library (previews, portraits). Sync, safe to call in render. */
  assetUrl(relPath: string): string;
}

export class ApiFailure extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Normalise anything thrown by invoke() or the mock into an ApiFailure. */
export function toFailure(e: unknown): ApiFailure {
  if (e instanceof ApiFailure) return e;
  if (e && typeof e === "object" && "code" in e && "message" in e) {
    const o = e as { code: unknown; message: unknown };
    return new ApiFailure(String(o.code), String(o.message));
  }
  if (typeof e === "string") return new ApiFailure("error", e);
  if (e instanceof Error) return new ApiFailure("error", e.message);
  return new ApiFailure("error", "Something went wrong.");
}
