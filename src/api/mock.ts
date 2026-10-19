// In-memory fixture backend for the browser test harness (SPEC §0). Enabled with VITE_MOCK=1, never in release builds.
// URL flags: ?firstrun=1 starts unconfigured; ?pages=1 starts in Pages layout; ?reduced=1 forces reduced motion.
import type { Api } from "./api";
import { buildMockWorld, MOCK_LIBRARIES, MOCK_SETTINGS, type MockWorld } from "./mockData";
import type { DiskState, Settings, Snapshot } from "./types";

const params = new URLSearchParams(typeof location !== "undefined" ? location.search : "");

const world: MockWorld = buildMockWorld();
let settings: Settings = structuredClone(MOCK_SETTINGS);
let configured = params.get("firstrun") !== "1";
let hashIndex = { date: "2026-08-03", entries: 3941 };
if (params.get("pages") === "1") settings.layout = "pages";
if (params.get("reduced") === "1") settings.reduceMotion = "on";

/** Test controls, reachable from agent-browser via `window.__mock`. */
export const mockControls = {
  latencyMs: 120,
  failNextApply: false,
  world,
};
(globalThis as unknown as { __mock: typeof mockControls }).__mock = mockControls;

const wait = (ms = mockControls.latencyMs) => new Promise((r) => setTimeout(r, ms));

function diskState(): DiskState {
  const skins: DiskState["skins"] = {};
  const active: DiskState["active"] = {};
  for (const s of world.library.skins) {
    const on = world.active.has(s.id);
    skins[s.id] = { location: on ? "mods" : settings.disableMethod === "move" ? "stash" : "disabled", active: on };
    if (on) (active[s.entityId] ??= []).push(s.id);
  }
  return {
    modsPath: settings.modsPath[settings.activeLoader] ?? null,
    modsExists: true,
    skins,
    active,
    libraries: MOCK_LIBRARIES,
    unknownRoots: [],
  };
}

function snapshot(): Snapshot {
  return {
    settings: structuredClone(settings),
    library: structuredClone(world.library),
    disk: diskState(),
    changedOutside: false,
    recovered: null,
    hashIndex,
    configured,
    sameDrive: true,
  };
}

export const api: Api = {
  kind: "mock",
  async load() {
    await wait();
    return snapshot();
  },
  async rescan() {
    await wait();
    return snapshot();
  },
  async saveSettings(next) {
    await wait(40);
    settings = structuredClone(next);
    configured = !!(settings.modsPath[settings.activeLoader]?.trim() && settings.libraryPath.trim());
    return snapshot();
  },
  async updateHashIndex() {
    await wait(1200);
    hashIndex = { date: "2026-10-12", entries: 3990 };
    return snapshot();
  },
  async firstRunDefaults() {
    await wait(40);
    return {
      loader: "3dmigoto",
      mods3dmigoto: "D:\\mods\\3dmigoto\\Mods",
      modsXxmi: null,
      library: "D:\\mods\\SkinLibrary",
    };
  },
  async pickFolder({ defaultPath }) {
    await wait(60);
    return defaultPath || "D:\\mods\\picked";
  },
  async openFolder() {
    await wait(20);
  },
  async openUrl(url) {
    window.open(url, "_blank", "noopener");
  },
  async setWindowTitle(title) {
    document.title = title;
  },
  assetUrl(relPath) {
    return world.images.get(relPath) ?? "";
  },
};
