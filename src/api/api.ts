// The one typed interface every component goes through (SPEC §13). Two implementations:
// tauri.ts (real backend) and mock.ts (in-memory fixtures for the browser test harness, VITE_MOCK=1).
import type { FirstRunDefaults, Settings, Snapshot } from "./types";

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
  /** First-run pre-fill (SPEC §5): existing loader paths and a suggested Library. Windows only. */
  firstRunDefaults(): Promise<FirstRunDefaults>;
  pickFolder(opts: FolderPickOptions): Promise<string | null>;
  openFolder(target: OpenTarget): Promise<void>;
  openUrl(url: string): Promise<void>;
  setWindowTitle(title: string): Promise<void>;
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
