// Real backend: thin typed wrappers around Tauri commands (src-tauri/src/commands.rs).
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl as openExternal } from "@tauri-apps/plugin-opener";
import { toFailure, type Api } from "./api";
import type { FirstRunDefaults, Settings, Snapshot } from "./types";

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw toFailure(e);
  }
}

let libraryRoot = "";

/** Remember the Library root from every snapshot so assetUrl() can resolve relative paths. */
async function snap(cmd: string, args?: Record<string, unknown>): Promise<Snapshot> {
  const s = await call<Snapshot>(cmd, args);
  libraryRoot = s.settings.libraryPath;
  return s;
}

export const api: Api = {
  kind: "tauri",
  load: () => snap("load"),
  rescan: () => snap("rescan"),
  saveSettings: (settings: Settings) => snap("save_settings", { settings }),
  updateHashIndex: () => snap("update_hash_index"),
  firstRunDefaults: () => call<FirstRunDefaults>("first_run_defaults"),
  async pickFolder({ title, defaultPath }) {
    const picked = await openDialog({ directory: true, multiple: false, title, defaultPath });
    return typeof picked === "string" ? picked : null;
  },
  openFolder: (target) => call<void>("open_folder", { target }),
  openUrl: (url) => openExternal(url),
  setWindowTitle: (title) => getCurrentWindow().setTitle(title),
  assetUrl(relPath) {
    if (!libraryRoot || relPath.split(/[\\/]/).some((p) => p === "..")) return "";
    const sep = libraryRoot.includes("\\") ? "\\" : "/";
    const full = `${libraryRoot.replace(/[\\/]+$/, "")}${sep}${relPath.replace(/[\\/]/g, sep)}`;
    return convertFileSrc(full);
  },
};
