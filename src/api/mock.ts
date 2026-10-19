// In-memory fixture backend for the browser test harness (SPEC §0). Enabled with VITE_MOCK=1, never in release builds.
// URL flags: ?firstrun=1 starts unconfigured; ?pages=1 starts in Pages layout; ?reduced=1 forces reduced motion.
import { ApiFailure, type Api } from "./api";
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
  /** Next Apply fails after some progress and "rolls back". */
  failNextApply: false,
  /** Next Apply reports that the Mods folder changed outside the app. */
  changeOutsideNextApply: false,
  /** ms per simulated folder move */
  applyStepMs: 260,
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
    notice: null,
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
  async apply(picks, onProgress) {
    const before = new Set(world.active);
    const steps: string[] = [];
    for (const [entityId, target] of Object.entries(picks)) {
      for (const s of world.library.skins.filter((k) => k.entityId === entityId)) {
        const on = world.active.has(s.id);
        if (s.id === target && !on) steps.push(`Moving ${s.folders[0].split("/").pop()}`);
        if (s.id !== target && on) steps.push(`Moving ${s.folders[0].split("/").pop()}`);
      }
    }
    if (mockControls.changeOutsideNextApply) {
      mockControls.changeOutsideNextApply = false;
      await wait();
      return { snapshot: snapshot(), changed: 0, changedOutside: true, warnings: [] };
    }
    for (let i = 0; i < steps.length; i++) {
      onProgress?.({ done: i, total: steps.length, label: steps[i] });
      await wait(mockControls.applyStepMs);
      if (mockControls.failNextApply && i === Math.floor(steps.length / 2)) {
        mockControls.failNextApply = false;
        world.active = before;
        throw new ApiFailure("move_failed", "Couldn't move Furina\\Remembrance: it's in use. Close the game or any Explorer window showing it. Nothing was changed.");
      }
    }
    for (const [entityId, target] of Object.entries(picks)) {
      for (const s of world.library.skins.filter((k) => k.entityId === entityId)) world.active.delete(s.id);
      if (target) world.active.add(target);
    }
    onProgress?.({ done: steps.length, total: steps.length, label: "Done" });
    return { snapshot: snapshot(), changed: steps.length, changedOutside: false, warnings: [] };
  },
  async removeSkin(skinId) {
    await wait();
    const s = world.library.skins.find((k) => k.id === skinId);
    if (!s) throw new ApiFailure("unknown_skin", "That skin no longer exists.");
    world.library.skins = world.library.skins.filter((k) => k.id !== skinId);
    const e = world.library.entities.find((x) => x.id === s.entityId);
    if (e) e.skinIds = e.skinIds.filter((x) => x !== skinId);
    world.active.delete(skinId);
    return snapshot();
  },
  async updateSkin(skinId, patch) {
    await wait(30);
    const s = world.library.skins.find((k) => k.id === skinId);
    if (!s) throw new ApiFailure("unknown_skin", "That skin no longer exists.");
    // refuse before changing anything, like the Rust side
    const moveTo = patch.entityId && patch.entityId !== s.entityId ? world.library.entities.find((e) => e.id === patch.entityId) : undefined;
    if (patch.entityId && patch.entityId !== s.entityId) {
      if (!moveTo) throw new ApiFailure("unknown_entity", "That character or item doesn't exist.");
      if (world.active.has(skinId)) throw new ApiFailure("skin_enabled", `${s.name} is switched on. Turn it off (pick Original) and Apply before moving it.`);
    }
    if (patch.name !== undefined && !patch.name.trim()) throw new ApiFailure("invalid_name", "A skin needs a name.");
    const clean = (v: string) => (v.trim() ? v.trim() : undefined);
    if (patch.name !== undefined) s.name = patch.name.trim();
    if (patch.author !== undefined) s.author = clean(patch.author);
    if (patch.version !== undefined) s.version = clean(patch.version);
    if (patch.notes !== undefined) s.notes = patch.notes.trim() ? patch.notes : undefined;
    if (patch.nsfw !== undefined) s.nsfw = patch.nsfw;
    if (patch.gameBananaUrl !== undefined) s.gameBananaUrl = clean(patch.gameBananaUrl);
    for (const l of patch.hotkeyLabels ?? []) {
      const h = s.hotkeys.find((x) => x.section === l.section && x.iniFile === l.iniFile && x.keys === l.keys);
      if (h) h.label = l.label.trim() || h.section.replace(/^Key/i, "");
    }
    if (patch.previewOrder) {
      const order = patch.previewOrder;
      s.previews = [...s.previews].sort((a, b) => {
        const ia = order.indexOf(a.file);
        const ib = order.indexOf(b.file);
        return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib);
      });
    }
    if (moveTo) {
      const from = world.library.entities.find((e) => e.id === s.entityId);
      if (from) from.skinIds = from.skinIds.filter((x) => x !== skinId);
      moveTo.skinIds.push(skinId);
      s.entityId = moveTo.id;
    }
    return snapshot();
  },
  async updateEntity(entityId, patch) {
    await wait(30);
    const e = world.library.entities.find((x) => x.id === entityId);
    if (!e) throw new ApiFailure("unknown_entity", "That character or item doesn't exist.");
    if (patch.name !== undefined) e.name = patch.name.trim() || e.name;
    if (patch.category) e.category = patch.category;
    if (patch.parentId !== undefined) e.parentId = patch.parentId || undefined;
    if (patch.aliases) e.aliases = patch.aliases.map((a) => a.trim()).filter(Boolean);
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
