// In-memory fixture backend for the browser test harness (SPEC §0). Enabled with VITE_MOCK=1, never in release builds.
// URL flags: ?firstrun=1 starts unconfigured; ?pages=1 starts in Pages layout; ?reduced=1 forces reduced motion;
// ?pin=2580 starts with that NSFW PIN set.
import { ApiFailure, type Api } from "./api";
import { buildMockWorld, coverArt, MOCK_LIBRARIES, MOCK_SETTINGS, type MockWorld } from "./mockData";
import type { AddTarget, ArchiveSummary, Category, DiskState, EntityGuess, FileDropEvent, ImportItem, ImportPlan, PinCheck, PreviewSource, Settings, Skin, Snapshot } from "./types";
import { revealHotkeyProblem } from "../lib/shortcuts";

const params = new URLSearchParams(typeof location !== "undefined" ? location.search : "");

const world: MockWorld = buildMockWorld();
let settings: Settings = structuredClone(MOCK_SETTINGS);
let configured = params.get("firstrun") !== "1";
let hashIndex = { date: "2026-08-03", entries: 3941 };
if (params.get("pages") === "1") settings.layout = "pages";
if (params.get("reduced") === "1") settings.reduceMotion = "on";
// the real backend keeps an Argon2 hash; the mock only needs to compare
let pin: string | null = params.get("pin");
const PIN_FREE_TRIES = 5;
const pinThrottle = { failures: 0, until: 0 };
function checkPin(guess: string): PinCheck {
  if (pin === null) return { ok: true, retryIn: 0, triesLeft: PIN_FREE_TRIES };
  const now = Date.now();
  if (pinThrottle.until > now) return { ok: false, retryIn: Math.max(1, Math.ceil((pinThrottle.until - now) / 1000)), triesLeft: 0 };
  if (guess === pin) {
    pinThrottle.failures = 0;
    pinThrottle.until = 0;
    return { ok: true, retryIn: 0, triesLeft: PIN_FREE_TRIES };
  }
  pinThrottle.failures++;
  if (pinThrottle.failures >= PIN_FREE_TRIES) {
    const lock = Math.min(30_000 * 2 ** Math.min(pinThrottle.failures - PIN_FREE_TRIES, 10), 600_000);
    pinThrottle.until = now + lock;
    return { ok: false, retryIn: lock / 1000, triesLeft: 0 };
  }
  return { ok: false, retryIn: 0, triesLeft: PIN_FREE_TRIES - pinThrottle.failures };
}
const minimizeHandlers = new Set<() => void>();

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
  /** Simulate minimizing the window (auto re-hide). */
  minimize() {
    minimizeHandlers.forEach((h) => h());
  },
  /** ms a GameBanana fetch takes (the card's "Fetching from GameBanana…" state). */
  gameBananaMs: 1400,
  /** Next GameBanana call fails like a dropped connection (empty state + Retry). */
  failNextGameBanana: false,
  /** GameBanana rates the mods 18+ (marks fetched skins NSFW). */
  gameBananaNsfw: false,
  world,
};
(globalThis as unknown as { __mock: typeof mockControls }).__mock = mockControls;

const wait = (ms = mockControls.latencyMs) => new Promise((r) => setTimeout(r, ms));

// ----- ?import=1: an empty library and a first-run review that mirrors the real cases (SPEC §5) -----
const g = (name: string, category: Category, reason: EntityGuess["reason"] = "hash", parentName?: string): EntityGuess => ({
  entityId: null,
  name,
  category,
  confidence: reason === "hash" ? 1 : reason === "name" ? 0.7 : 0.3,
  reason,
  ...(parentName ? { parentName } : {}),
});
const inst = (folders: string[], guess: EntityGuess, skinName: string, hotkeys = 1, nsfw = false): ImportItem => ({
  key: `mods:${folders.join("|")}`,
  source: { kind: "installed", folders },
  guess,
  skinName,
  nsfw,
  hotkeys,
  images: 0,
  own: false,
});
const arch = (archive: string, root: string, guess: EntityGuess, skinName: string, o: Partial<ImportItem> & { main?: boolean; nested?: boolean; folders?: string[] } = {}): ImportItem => ({
  key: `archive:${archive}#${root}`,
  source: { kind: "archive", archive, root, folders: o.folders ?? [root], main: o.main ?? false, nested: o.nested ?? false },
  guess,
  skinName,
  nsfw: o.nsfw ?? false,
  hotkeys: o.hotkeys ?? 1,
  images: o.images ?? 0,
  parent: o.main ? null : `archive:${archive}#`,
  own: o.own ?? false,
});
const LIB = "Charecters and wepon";
const IMPORT_PLAN: ImportPlan = {
  items: [
    inst(["Furina/Remembrance"], g("Furina", "character"), "Remembrance", 2),
    inst(["Furina/Casual"], g("Furina", "character"), "Casual"),
    inst(["paimon_cc116"], g("Paimon", "character"), "CC116", 3),
    inst(["sandrone_marionette_by_neyori/Face", "sandrone_marionette_by_neyori/outfit"], g("Sandrone", "character"), "Marionette", 5),
    inst(["sandrone_marionette_by_neyori/A Teaspoon of Transcendence"], g("A Teaspoon of Transcendence", "weapon", "folder"), "Marionette"),
    inst(["Kazuha/Multi"], g("Kazuha", "character", "name"), "Multi", 3),
    inst(["Odette"], g("Odette", "character", "folder"), "Black Swan", 0),
    arch(`${LIB}/Benny/bennettbeachday.zip`, "", g("Bennett", "character"), "Beach Day", { main: true, images: 2 }),
    arch(`${LIB}/Benny/bennettbeachday.zip`, "TravelerHandySword", g("Skyward Blade", "weapon"), "Bennett Beach Day", { nested: true, own: true, hotkeys: 0 }),
    arch(`${LIB}/Fischl/fischlhexenzirkel.zip`, "", g("Fischl", "character"), "Hexenzirkel", { main: true, images: 3 }),
    arch(`${LIB}/Fischl/fischlhexenzirkel.zip`, "OzMod", g("Oz", "extra", "hash", "Fischl"), "Fischl Hexenzirkel", { nested: true, own: true }),
    arch(`${LIB}/Neuvilette/neuvilletteweddingrelease.zip`, "NeuvilletteWedding", g("Neuvillette", "character"), "Wedding", { main: true, images: 1 }),
    arch(`${LIB}/Neuvilette/neuvilletteweddingrelease.zip`, "TomeOfTheEternalFlowGoldRecolor", g("Tome of the Eternal Flow", "weapon"), "Neuvillette Wedding", { own: true, hotkeys: 0 }),
    arch(`${LIB}/Veresa/sfw/varesa_by_neyori_e0d4f.zip`, "", g("Varesa", "character"), "By Neyori", { main: true, folders: ["Face", "Outfit"], images: 2, hotkeys: 2 }),
    arch(`${LIB}/Veresa/nsfw/weebovz_-_cow_girl_og_varesa_toggle.rar`, "", g("Varesa", "character", "name"), "Cow Girl", { main: true, nsfw: true, images: 1 }),
    arch(`${LIB}/Diluc/dilucinwhitebetterhair.rar`, "", g("Diluc", "character"), "In White Better Hair", { main: true, images: 6 }),
  ],
  archives: [
    ...[
      "Benny/bennettbeachday.zip",
      "Fischl/fischlhexenzirkel.zip",
      "Neuvilette/neuvilletteweddingrelease.zip",
      "Veresa/sfw/varesa_by_neyori_e0d4f.zip",
      "Veresa/nsfw/weebovz_-_cow_girl_og_varesa_toggle.rar",
      "Diluc/dilucinwhitebetterhair.rar",
    ].map((p) => ({ path: `${LIB}/${p}`, size: 48_000_000, error: null })),
    { path: `${LIB}/Charlotte/bearcharlotte_part.zip`, size: 1_200_000, error: "This archive can't be read: Truncated input file (needed 1048576 bytes, only 0 available)" },
  ],
  stray: ["paimon_cc116.zip", "sandrone_marionette_by_neyori.zip"],
};
// a split's parent is the main root of the same archive, whatever its folder is called
for (const it of IMPORT_PLAN.items) {
  if (it.source.kind !== "archive" || it.source.main) continue;
  const archive = it.source.archive;
  it.parent = IMPORT_PLAN.items.find((m) => m.source.kind === "archive" && m.source.main && m.source.archive === archive)?.key ?? null;
}
let importPending = params.get("import") === "1";
if (importPending) {
  world.library = { version: 1, entities: [], skins: [] };
  world.active.clear();
}

// ----- previews, with the Rust side's rules (core/previews.rs) -----
const MAX_PREVIEWS = 30;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
/** skinId -> what its previews were made from (a path, the bytes' hash, a GameBanana image), to skip duplicates */
const previewSources = new Map<string, Set<string>>();

function findSkin(skinId: string): Skin {
  const s = world.library.skins.find((k) => k.id === skinId);
  if (!s) throw new ApiFailure("unknown_skin", "That skin no longer exists.");
  return s;
}

function imageType(bytes: Uint8Array): "png" | "jpg" | "webp" | null {
  const at = (i: number, ...b: number[]) => b.every((v, j) => bytes[i + j] === v);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "png";
  if (at(0, 0xff, 0xd8, 0xff)) return "jpg";
  if (bytes.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "webp";
  return null;
}

function bytesKey(bytes: Uint8Array): string {
  let h = 2166136261;
  for (const b of bytes) h = Math.imul(h ^ b, 16777619);
  return `bytes:${bytes.length}:${h >>> 0}`;
}

function gameBananaId(url: string): number | null {
  const m = /^https?:\/\/(?:www\.)?gamebanana\.com\/mods\/(\d{1,12})/i.exec(url.trim());
  const id = m ? Number(m[1]) : 0;
  return id > 0 ? id : null;
}

/** Append a preview numbered after the skin's others (`previews/<id>/07.png`); false when it's a duplicate. */
function storePreview(s: Skin, key: string, ext: string, url: string, source: PreviewSource): boolean {
  const seen = previewSources.get(s.id) ?? new Set<string>();
  previewSources.set(s.id, seen);
  if (seen.has(key)) return false;
  if (s.previews.length >= MAX_PREVIEWS) throw new ApiFailure("too_many", `This skin already has ${MAX_PREVIEWS} previews. Remove one first.`);
  const next = Math.max(0, ...s.previews.map((p) => parseInt(p.file.split("/").pop() ?? "", 10) || 0)) + 1;
  const file = `previews/${s.id}/${String(next).padStart(2, "0")}.${ext}`;
  world.images.set(file, url);
  s.previews.push({ file, source });
  seen.add(key);
  return true;
}

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
    unknownRoots: importPending ? IMPORT_PLAN.items.flatMap((i) => (i.source.kind === "installed" ? [i.source.folders[0]] : [])) : [],
    archives: importPending ? [...IMPORT_PLAN.archives.map((a) => a.path), ...IMPORT_PLAN.stray] : [],
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
    pinSet: pin !== null,
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
    const hotkey = revealHotkeyProblem(next.nsfw.hotkey);
    if (hotkey) throw new ApiFailure(hotkey.code, hotkey.message);
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
    for (const p of s.previews) world.images.delete(p.file);
    previewSources.delete(skinId);
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
    const place = (t: AddTarget, nsfw: boolean, main = false) => {
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
      world.library.skins.push({ id, entityId: entity.id, name: t.skinName, folders: [`${entity.name}/${t.skinName}`], nsfw, previews, hotkeys: [], hashes: [], addedAt: new Date().toISOString(), gameBananaUrl: req.gameBananaUrl, author: main ? req.author?.trim() || undefined : undefined, sourceArchive: req.archivePath.split(/[\\/]/).pop() });
      entity.skinIds.push(id);
      ids.push(id);
      return entity.id;
    };
    for (const sp of req.splits) place(sp, false);
    const entityId = place(req.main, req.nsfw, true);
    if (req.makeActive) {
      for (const k of world.library.skins.filter((x) => x.entityId === entityId)) world.active.delete(k.id);
      world.active.add(ids[ids.length - 1]);
    }
    return { snapshot: snapshot(), skinIds: ids, warnings: [] };
  },
  async planImport(onProgress) {
    const archives = importPending ? IMPORT_PLAN.archives : [];
    for (let i = 0; i < archives.length; i++) {
      onProgress?.({ done: i, total: archives.length, label: archives[i].path });
      await wait(220);
    }
    await wait(120);
    return importPending ? structuredClone(IMPORT_PLAN) : { items: [], archives: [], stray: [] };
  },
  async applyImport(req, onProgress) {
    const entityFor = (t: AddTarget): string => {
      if (t.entityId && world.library.entities.some((e) => e.id === t.entityId)) return t.entityId;
      const ne = t.newEntity;
      if (!ne) throw new ApiFailure("no_entity", "Pick a character, weapon or extra.");
      const ensure = (name: string, category: Category, parentId?: string) => {
        const found = world.library.entities.find((e) => e.name.toLowerCase() === name.toLowerCase());
        if (found) return found.id;
        const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        world.library.entities.push({ id, name, category, parentId, skinIds: [], aliases: [] });
        return id;
      };
      const parent = ne.parentId ?? (ne.parentName ? ensure(ne.parentName, "character") : undefined);
      return ensure(ne.name, ne.category, parent);
    };
    const keyToSkin = new Map<string, string>();
    const add = (key: string, t: AddTarget, folders: string[], nsfw: boolean, on: boolean, images: number) => {
      const entityId = entityFor(t);
      const id = `${entityId}--${t.skinName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
      const previews = Array.from({ length: Math.min(images, 3) }, (_, n) => {
        const file = `previews/${id}/${n + 1}.svg`;
        world.images.set(file, coverArt(id, n));
        return { file, source: "archive" as const };
      });
      world.library.skins.push({ id, entityId, name: t.skinName, folders, nsfw, previews, hotkeys: [], hashes: [], addedAt: new Date().toISOString() });
      world.library.entities.find((e) => e.id === entityId)!.skinIds.push(id);
      if (on) world.active.add(id);
      keyToSkin.set(key, id);
    };
    const chosen = req.choices.filter((c) => c.include);
    for (let i = 0; i < chosen.length; i++) {
      const c = chosen[i];
      const item = IMPORT_PLAN.items.find((it) => it.key === c.key);
      if (!item) continue;
      onProgress?.({ done: i, total: chosen.length, label: `Adding ${i + 1} of ${chosen.length}` });
      await wait(90);
      if (item.source.kind === "installed") add(c.key, c, item.source.folders, c.nsfw, true, 0);
      else if (item.source.main || c.own) {
        const parent = item.parent ? req.choices.find((p) => p.key === item.parent) : null;
        if (parent && !parent.include) continue;
        add(c.key, c, [`${c.skinName}`], item.source.main ? c.nsfw : (parent?.nsfw ?? c.nsfw), false, item.images);
      }
    }
    for (const k of req.keepActive) {
      const id = keyToSkin.get(k) ?? k;
      const skin = world.library.skins.find((s) => s.id === id);
      if (!skin) continue;
      for (const s of world.library.skins.filter((x) => x.entityId === skin.entityId && x.id !== id)) world.active.delete(s.id);
    }
    importPending = false;
    return { snapshot: snapshot(), added: keyToSkin.size, warnings: [] };
  },
  async gameBananaInfo(url) {
    await wait(Math.round(mockControls.gameBananaMs / 2));
    const id = gameBananaId(url);
    if (!id) throw new ApiFailure("bad_link", "That isn't a GameBanana mod link (gamebanana.com/mods/…).");
    if (mockControls.failNextGameBanana) {
      mockControls.failNextGameBanana = false;
      throw new ApiFailure("network", "Couldn't reach GameBanana (timed out). Check the connection and retry.");
    }
    if (id === 404) throw new ApiFailure("gamebanana", "GameBanana says: This Mod doesn't exist");
    const images = [1, 2, 3].map((n) => `https://images.gamebanana.com/img/ss/mods/mock-${id}-${n}.jpg`);
    return { modId: id, name: `Mock Mod ${id}`, author: "mockauthor", version: "1.0", nsfw: mockControls.gameBananaNsfw, images };
  },
  async fetchGameBananaPreviews(skinId) {
    const s = findSkin(skinId);
    const id = gameBananaId(s.gameBananaUrl ?? "");
    if (!id) throw new ApiFailure("no_link", "Add the skin's GameBanana link first.");
    await wait(mockControls.gameBananaMs);
    if (mockControls.failNextGameBanana) {
      mockControls.failNextGameBanana = false;
      throw new ApiFailure("network", "Couldn't download the previews from GameBanana. Retry in a moment.");
    }
    if (id === 404) throw new ApiFailure("gamebanana", "GameBanana says: This Mod doesn't exist");
    let added = 0;
    for (const n of [1, 2, 3]) {
      if (s.previews.length >= MAX_PREVIEWS) break;
      if (storePreview(s, `gb:${id}:${n}`, "jpg", coverArt(`gb-${id}`, n), "gamebanana")) added++;
    }
    s.author ??= "mockauthor";
    s.version ??= "1.0";
    const markedNsfw = mockControls.gameBananaNsfw && !s.nsfw;
    if (markedNsfw) s.nsfw = true;
    return { snapshot: snapshot(), added, failed: 0, markedNsfw };
  },
  async findFolderPreviews(skinId) {
    await wait();
    const s = findSkin(skinId);
    const added = s.previews.length < MAX_PREVIEWS && storePreview(s, `folder:${skinId}`, "png", coverArt(`folder-${skinId}`), "archive") ? 1 : 0;
    return { snapshot: snapshot(), added };
  },
  async addPreview(skinId, path) {
    await wait(80);
    const s = findSkin(skinId);
    // a browser can't read the dropped file: go by its name and draw generated art
    const ext = /\.(png|jpe?g|webp)$/i.exec(path)?.[1].toLowerCase().replace("jpeg", "jpg");
    if (!ext) throw new ApiFailure("not_an_image", "That isn't a PNG, JPG or WebP image (or it's over 25 MB).");
    if (!storePreview(s, `path:${path.toLowerCase()}`, ext, coverArt(path), "user")) {
      throw new ApiFailure("duplicate", "That image is already one of this skin's previews.");
    }
    return snapshot();
  },
  async pastePreview(skinId, bytes) {
    await wait(80);
    const s = findSkin(skinId);
    const ext = imageType(bytes);
    if (!ext || bytes.length > MAX_IMAGE_BYTES) throw new ApiFailure("not_an_image", "That isn't a PNG, JPG or WebP image (or it's over 25 MB).");
    const url = URL.createObjectURL(new Blob([bytes.slice()], { type: `image/${ext === "jpg" ? "jpeg" : ext}` }));
    if (!storePreview(s, bytesKey(bytes), ext, url, "user")) {
      URL.revokeObjectURL(url);
      throw new ApiFailure("duplicate", "That image is already one of this skin's previews.");
    }
    return snapshot();
  },
  async removePreview(skinId, file) {
    await wait(60);
    const s = findSkin(skinId);
    if (!s.previews.some((p) => p.file === file)) throw new ApiFailure("unknown_preview", "That image is no longer one of this skin's previews.");
    s.previews = s.previews.filter((p) => p.file !== file);
    const url = world.images.get(file);
    if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
    world.images.delete(file);
    return snapshot();
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
  async verifyPin(guess) {
    await wait(220);
    return checkPin(guess);
  },
  async setPin(current, next) {
    await wait(220);
    if (pin !== null) {
      const c = checkPin(current ?? "");
      if (!c.ok) throw c.retryIn ? new ApiFailure("pin_locked", `Too many wrong PINs. Try again in ${c.retryIn} s.`) : new ApiFailure("pin_wrong", "That's not the current PIN.");
    }
    if (next !== null && !/^\d{4,6}$/.test(next)) throw new ApiFailure("pin_invalid", "Use 4 to 6 digits for the PIN.");
    pin = next;
    return snapshot();
  },
  async onMinimize(handler) {
    minimizeHandlers.add(handler);
    // a browser tab going to the background is the closest thing to minimizing
    const onVis = () => document.visibilityState === "hidden" && handler();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      minimizeHandlers.delete(handler);
      document.removeEventListener("visibilitychange", onVis);
    };
  },
  async setWindowTitle(title) {
    document.title = title;
  },
  assetUrl(relPath) {
    return world.images.get(relPath) ?? "";
  },
};
