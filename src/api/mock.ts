// In-memory fixture backend for the browser test harness (SPEC §0). Enabled with VITE_MOCK=1, never in release builds.
// URL flags: ?firstrun=1 starts unconfigured; ?pages=1 starts in Pages layout; ?reduced=1 forces reduced motion.
import { ApiFailure, type Api } from "./api";
import { buildMockWorld, coverArt, MOCK_LIBRARIES, MOCK_SETTINGS, type MockWorld } from "./mockData";
import type { AddTarget, ArchiveSummary, DiskState, FileDropEvent, Settings, Snapshot } from "./types";

const params = new URLSearchParams(typeof location !== "undefined" ? location.search : "");

const world: MockWorld = buildMockWorld();
let settings: Settings = structuredClone(MOCK_SETTINGS);
let configured = params.get("firstrun") !== "1";
let hashIndex = { date: "2026-08-03", entries: 3941 };
if (params.get("pages") === "1") settings.layout = "pages";
if (params.get("reduced") === "1") settings.reduceMotion = "on";

/** Test controls, reachable from agent-browser via `window.__mock`. */
const dropHandlers = new Set<(e: FileDropEvent) => void>();

export const mockControls = {
  /** Simulate an OS file drag: phase enter/over/drop/leave at CSS pixel x/y. */
  drag(phase: FileDropEvent["type"], name = "Mona_[skin].zip", x = 0, y = 0) {
    const path = `C:\\Users\\you\\Downloads\\${name}`;
    const e: FileDropEvent =
      phase === "enter" ? { type: "enter", paths: [path], x, y } : phase === "drop" ? { type: "drop", paths: [path], x, y } : phase === "over" ? { type: "over", x, y } : { type: "leave" };
    dropHandlers.forEach((h) => h(e));
  },
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
  async pickArchive() {
    await wait(60);
    return "C:\\Users\\you\\Downloads\\Mona_[skin].zip";
  },
  async pickImage() {
    await wait(60);
    return "C:\\Users\\you\\Pictures\\portrait.png";
  },
  async analyzeArchive(path) {
    await wait(260);
    const fileName = path.split(/[\\/]/).pop() ?? path;
    if (/evil/i.test(fileName)) throw new ApiFailure("unsafe_archive", `It contains an unsafe entry (../evil.ini). Nothing was extracted.`);
    const lower = fileName.toLowerCase();
    const ent = world.library.entities.find((e) => lower.includes(e.name.toLowerCase().split(" ")[0])) ?? null;
    const guess = ent ? { entityId: ent.id, name: ent.name, category: ent.category, confidence: 0.9, reason: "hash" as const } : null;
    const roots: ArchiveSummary["roots"] = [{ path: "", folders: [""], inis: ["Skin.ini"], hotkeys: 2, hashes: ["7a1dc890"], guess, nested: false }];
    if (lower.includes("bennett")) {
      roots.push({ path: "TravelerHandySword", folders: ["TravelerHandySword"], inis: ["TravelerHandySword/SkywardBlade.ini"], hotkeys: 0, hashes: ["65914967"], guess: { entityId: "skyward-blade", name: "Skyward Blade", category: "weapon", confidence: 0.95, reason: "hash" }, nested: true });
    }
    const wrapper = fileName.replace(/\.(zip|rar|7z)$/i, "");
    const suggested = wrapper.replace(new RegExp(ent?.name ?? "^$", "i"), "").replace(/[_\-[\]]+/g, " ").trim() || "New skin";
    return {
      path,
      fileName,
      size: 48_213_000,
      fileCount: 31,
      iniCount: roots.length,
      images: ["preview1.png", "preview2.jpg"],
      entries: [
        { path: `${wrapper}/`, size: 0, isDir: true },
        { path: `${wrapper}/merged.ini`, size: 12000, isDir: false },
        { path: `${wrapper}/preview1.png`, size: 900000, isDir: false },
        { path: `${wrapper}/preview2.jpg`, size: 700000, isDir: false },
        { path: `${wrapper}/textures/`, size: 0, isDir: true },
      ],
      roots,
      skipped: ["desktop.ini"],
      suggestedName: suggested.replace(/\b\w/g, (c) => c.toUpperCase()),
      nsfwGuess: /nsfw|lewd|nude/.test(lower),
      wrapper: `${wrapper}/`,
    };
  },
  async addSkin(req, onProgress) {
    for (let i = 0; i <= 10; i++) {
      onProgress?.({ done: i, total: 10, label: "Extracting" });
      await wait(90);
    }
    const ids: string[] = [];
    const place = (t: AddTarget, nsfw: boolean) => {
      let entity = t.entityId ? world.library.entities.find((e) => e.id === t.entityId) : undefined;
      if (!entity && t.newEntity) {
        const id = t.newEntity.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        entity = world.library.entities.find((e) => e.id === id) ?? { id, name: t.newEntity.name, category: t.newEntity.category, parentId: t.newEntity.parentId, skinIds: [] };
        if (!world.library.entities.includes(entity)) world.library.entities.push(entity);
      }
      if (!entity) throw new ApiFailure("no_entity", "Pick a character, weapon or extra.");
      const id = `${entity.id}--${t.skinName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now() % 10000}`;
      const previews = req.previewSource === "archive" ? [1, 2].map((n) => {
        const file = `previews/${id}/${n}.svg`;
        world.images.set(file, coverArt(id, n));
        return { file, source: "archive" as const };
      }) : [];
      world.library.skins.push({ id, entityId: entity.id, name: t.skinName, folders: [`${entity.name}/${t.skinName}`], nsfw, previews, hotkeys: [], hashes: [], addedAt: new Date().toISOString(), gameBananaUrl: req.gameBananaUrl, sourceArchive: req.archivePath.split(/[\\/]/).pop() });
      entity.skinIds.push(id);
      ids.push(id);
      return entity.id;
    };
    for (const sp of req.splits) place(sp, false);
    const entityId = place(req.main, req.nsfw);
    if (req.makeActive) {
      for (const k of world.library.skins.filter((x) => x.entityId === entityId)) world.active.delete(k.id);
      world.active.add(ids[ids.length - 1]);
    }
    return { snapshot: snapshot(), skinIds: ids, warnings: [] };
  },
  async onFileDrop(handler) {
    dropHandlers.add(handler);
    // real browser file drags work too (names only)
    const name = (e: DragEvent) => [...(e.dataTransfer?.files ?? [])].map((f) => `C:\\Users\\you\\Downloads\\${f.name}`);
    const onEnter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      handler({ type: "enter", paths: name(e), x: e.clientX, y: e.clientY });
    };
    const onOver = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      handler({ type: "over", x: e.clientX, y: e.clientY });
    };
    const onDrop = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      handler({ type: "drop", paths: name(e), x: e.clientX, y: e.clientY });
    };
    const onLeave = (e: DragEvent) => {
      if (e.relatedTarget === null) handler({ type: "leave" });
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("drop", onDrop);
    window.addEventListener("dragleave", onLeave);
    return () => {
      dropHandlers.delete(handler);
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("dragleave", onLeave);
    };
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
