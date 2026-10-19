import { describe, expect, it } from "vitest";
import type { Entity, Hotkey, Skin, Snapshot } from "../api/types";
import { clashesFor } from "./conflicts";
import { entityView } from "./derive";
import { parseKey } from "./hotkeys";

const hk = (keys: string): Hotkey => ({ keys, label: "Toggle", kind: "toggle", gated: false, section: "KeyToggle", iniFile: "a.ini", parsed: [parseKey(keys)!] });
const skin = (id: string, entityId: string, nsfw: boolean, keys: string[] = []): Skin => ({
  id,
  entityId,
  name: id,
  folders: [id],
  nsfw,
  previews: [],
  hotkeys: keys.map(hk),
  hashes: [],
  addedAt: "2026-10-01T00:00:00Z",
});
const entity = (id: string, skinIds: string[]): Entity => ({ id, name: id, category: "character", skinIds, aliases: [] });

// Varesa has a safe skin and a hidden one; both are on disk. Furina's active skin shares key 6 with the hidden one.
function world(): Snapshot {
  const skins = [skin("v-safe", "varesa", false), skin("v-lewd", "varesa", true, ["6"]), skin("f-hat", "furina", false, ["6"])];
  return {
    settings: {} as Snapshot["settings"],
    library: { version: 1, entities: [entity("varesa", ["v-safe", "v-lewd"]), entity("furina", ["f-hat"])], skins },
    disk: { modsPath: null, modsExists: true, skins: {}, active: { varesa: ["v-safe", "v-lewd"], furina: ["f-hat"] }, libraries: [], unknownRoots: [] },
    changedOutside: false,
    recovered: null,
    hashIndex: {} as Snapshot["hashIndex"],
    configured: true,
    sameDrive: true,
    notice: null,
  };
}

describe("hidden NSFW skins leave no trace (SPEC §11)", () => {
  it("don't count as on disk while hidden", () => {
    const s = world();
    const varesa = s.library.entities[0];
    expect(entityView(s, {}, false, varesa).onDisk).toEqual(["v-safe"]);
    expect(entityView(s, {}, true, varesa).onDisk).toEqual(["v-safe", "v-lewd"]);
  });

  it("don't raise hotkey clashes while hidden", () => {
    const s = world();
    const hidden = clashesFor(s, {}, false);
    expect(hidden.bySkin.get("f-hat")).toBeUndefined();
    expect(hidden.conflictEntities.size).toBe(0);
    const shown = clashesFor(s, {}, true);
    expect(shown.bySkin.get("f-hat")?.[0].otherSkinId).toBe("v-lewd");
    expect(shown.conflictEntities).toEqual(new Set(["furina", "varesa"]));
  });
});
