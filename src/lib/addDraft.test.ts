import { describe, expect, it } from "vitest";
import type { ArchiveSummary, Entity } from "../api/types";
import { applyGameBananaInfo, checkDraft, initialDraft, withRootIncluded } from "./addDraft";

const entities: Entity[] = [
  { id: "bennett", name: "Bennett", category: "character", skinIds: [], aliases: [] },
  { id: "mona", name: "Mona", category: "character", skinIds: [], aliases: [] },
  { id: "skyward-blade", name: "Skyward Blade", category: "weapon", skinIds: [], aliases: [] },
];

// Bennett's beach skin ships his sword as a nested mod (SPEC §5)
const bennett: ArchiveSummary = {
  path: "/dl/bennett_beach.zip",
  fileName: "bennett_beach.zip",
  size: 2860,
  fileCount: 6,
  iniCount: 2,
  images: ["preview.png"],
  entries: [],
  roots: [
    { path: "", folders: [""], inis: ["Bennett.ini"], hotkeys: 1, hashes: ["aa"], guess: { entityId: "bennett", name: "Bennett", category: "character", confidence: 1, reason: "hash" }, nested: false },
    { path: "Sword", folders: ["Sword"], inis: ["Sword/Sword.ini"], hotkeys: 0, hashes: ["bb"], guess: { entityId: "skyward-blade", name: "Skyward Blade", category: "weapon", confidence: 1, reason: "hash" }, nested: true },
  ],
  skipped: ["desktop.ini"],
  suggestedName: "Beach Day",
  nsfwGuess: false,
  wrapper: "bennett_beach/",
};

const opts = { entityId: null, newCategory: null, entities, makeActive: true };

describe("add draft (A4 / C4)", () => {
  it("guesses the entity, splits the nested sword out and names it after the main skin", () => {
    const d = initialDraft(bennett, opts);
    expect(d.entity).toEqual({ kind: "existing", id: "bennett" });
    expect(d.roots[1]).toMatchObject({ include: true, own: true, entity: { kind: "existing", id: "skyward-blade" } });
    expect(d.preview).toBe("archive");
    const { request, errors } = checkDraft(d, bennett, entities);
    expect(errors).toEqual({});
    expect(request).toMatchObject({
      archivePath: "/dl/bennett_beach.zip",
      main: { entityId: "bennett", skinName: "Beach Day" },
      splits: [{ rootPath: "Sword", entityId: "skyward-blade", skinName: "Bennett Beach Day" }],
      exclude: [],
      makeActive: true,
    });
  });

  it("keeps the card it was dropped on, and leaves out unticked roots", () => {
    const d = initialDraft(bennett, { ...opts, entityId: "mona" });
    expect(d.entity).toEqual({ kind: "existing", id: "mona" });
    d.roots[1].include = false;
    const { request } = checkDraft(d, bennett, entities);
    expect(request?.main.entityId).toBe("mona");
    expect(request?.splits).toEqual([]);
    expect(request?.exclude).toEqual(["Sword"]);
  });

  it("refuses an unnamed skin, a missing entity, a bad link and an own image without a file", () => {
    const d = initialDraft({ ...bennett, roots: [{ ...bennett.roots[0], guess: null }] }, opts);
    d.skinName = " ";
    d.gbUrl = "https://example.com/mods/1";
    d.preview = "user";
    const { request, errors } = checkDraft(d, bennett, entities);
    expect(request).toBeNull();
    expect(Object.keys(errors).sort()).toEqual(["entity", "gbUrl", "preview", "skinName"]);
  });

  it("creates a new entity from a drop on + New character", () => {
    const d = initialDraft(bennett, { ...opts, newCategory: "character" });
    expect(d.entity).toEqual({ kind: "new", name: "", category: "character" });
    expect(checkDraft(d, bennett, entities).errors.entity).toBe("Name the new entry.");
    d.entity = { kind: "new", name: "Lumine", category: "character", portraitPath: "/p.png" };
    expect(checkDraft(d, bennett, entities).request?.main).toEqual({
      newEntity: { name: "Lumine", category: "character", portraitPath: "/p.png" },
      skinName: "Beach Day",
    });
  });

  it("unticks nested roots with their parent and sends every folder of a multi-folder root", () => {
    const multi: ArchiveSummary = {
      ...bennett,
      roots: [
        bennett.roots[0],
        { ...bennett.roots[1], path: "Side/Face", folders: ["Side/Face", "Side/Outfit"], nested: false },
        { ...bennett.roots[1], path: "Side/Face/Glow", folders: ["Side/Face/Glow"], nested: true },
      ],
    };
    let d = initialDraft(multi, opts);
    d = withRootIncluded(d, multi, 1, false);
    expect(d.roots.map((r) => r.include)).toEqual([true, false, false]);
    expect(checkDraft(d, multi, entities).request?.exclude).toEqual(["Side/Face", "Side/Outfit", "Side/Face/Glow"]);
    d = withRootIncluded(d, multi, 1, true);
    expect(checkDraft(d, multi, entities).request?.splits[0]).toMatchObject({ rootPath: "Side/Face", folders: ["Side/Face", "Side/Outfit"] });
  });

  it("pre-fills name, author and NSFW from a GameBanana link without overwriting what the user typed", () => {
    const info = { name: "Bennett - Sunny Shore", author: "sora", nsfw: true, images: ["a", "b"] };
    const base = { ...initialDraft(bennett, opts), preview: "later" as const };
    const ctx = { suggestedName: "Beach Day", entityName: "Bennett", previous: null };
    const first = applyGameBananaInfo(base, info, ctx);
    expect(first.draft).toMatchObject({ skinName: "Sunny Shore", author: "sora", nsfw: true, preview: "gamebanana" });
    expect(checkDraft({ ...first.draft, gbUrl: "https://gamebanana.com/mods/1" }, bennett, entities).request).toMatchObject({ author: "sora", previewSource: "gamebanana" });

    // a second link replaces the first one's answers, but not a name the user typed, and never unticks NSFW
    const other = { name: "Night Swim", author: "kai", nsfw: false, images: [] };
    const again = applyGameBananaInfo(first.draft, other, { ...ctx, previous: first.prefill });
    expect(again.draft).toMatchObject({ skinName: "Night Swim", author: "kai", nsfw: true });
    const typed = applyGameBananaInfo({ ...first.draft, skinName: "Mine", author: "me" }, other, { ...ctx, previous: first.prefill });
    expect(typed.draft).toMatchObject({ skinName: "Mine", author: "me" });

    // archive previews stay the choice when the archive has some
    expect(applyGameBananaInfo(initialDraft(bennett, opts), info, ctx).draft.preview).toBe("archive");
    expect(checkDraft(initialDraft(bennett, opts), bennett, entities).request?.author).toBeUndefined();
  });
});
