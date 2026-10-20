import { afterEach, describe, expect, it, vi } from "vitest";
import type { Entity, Hotkey, Skin, Snapshot } from "../api/types";
import { clashesFor } from "./conflicts";
import { entityView } from "./derive";
import { parseKey } from "./hotkeys";
import { createIdleTimer, IDLE_MS, redactHidden } from "./nsfw";

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
    disk: { modsPath: null, modsExists: true, skins: {}, active: { varesa: ["v-safe", "v-lewd"], furina: ["f-hat"] }, libraries: [], unknownRoots: [], archives: [] },
    changedOutside: false,
    recovered: null,
    hashIndex: {} as Snapshot["hashIndex"],
    configured: true,
    sameDrive: true,
    notice: null,
    pinSet: false,
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

describe("messages don't name hidden skins (SPEC §11)", () => {
  // the hidden skin has a real-looking name and two folders, one of them disabled
  function lewdWorld(): Snapshot {
    const s = world();
    const k = s.library.skins.find((x) => x.id === "v-lewd")!;
    k.name = "Cow Girl";
    k.folders = ["Varesa/CowGirl", "Varesa/DISABLED_CowGirlFace"];
    return s;
  }

  it("redacts names and folders, in either path style, while hidden", () => {
    const s = lewdWorld();
    expect(redactHidden("Couldn't move Varesa\\CowGirl: access denied", s, false)).toBe("Couldn't move a hidden skin: access denied");
    expect(redactHidden("Switched to cow girl", s, false)).toBe("Switched to a hidden skin");
    expect(redactHidden("Missing Varesa/DISABLED_CowGirlFace", s, false)).toBe("Missing a hidden skin");
    expect(redactHidden("CowGirlFace is gone", s, false)).toBe("a hidden skin is gone");
  });

  it("leaves visible skins and revealed messages alone", () => {
    const s = lewdWorld();
    expect(redactHidden("Switched Varesa to v-safe", s, false)).toBe("Switched Varesa to v-safe");
    expect(redactHidden("Couldn't move Varesa\\CowGirl", s, true)).toBe("Couldn't move Varesa\\CowGirl");
    expect(redactHidden("anything", null, false)).toBe("anything");
  });

  it("skips names too short to redact safely", () => {
    const s = lewdWorld();
    const k = s.library.skins.find((x) => x.id === "v-lewd")!;
    k.name = "XY";
    k.folders = ["Ab"];
    expect(redactHidden("XY moved Ab", s, false)).toBe("XY moved a hidden skin");
  });
});

describe("idle timer behind auto re-hide (SPEC §11)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires once after the idle time, and input pushes it back", () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();
    const t = createIdleTimer(onIdle, IDLE_MS);
    vi.advanceTimersByTime(IDLE_MS - 1000);
    t.bump();
    vi.advanceTimersByTime(IDLE_MS - 1000);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(onIdle).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(IDLE_MS * 3);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("does nothing once stopped, even when bumped", () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();
    const t = createIdleTimer(onIdle, 1000);
    t.stop();
    t.bump();
    vi.advanceTimersByTime(5000);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it("waits five minutes by default", () => {
    expect(IDLE_MS).toBe(5 * 60_000);
  });
});
