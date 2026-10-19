import { describe, expect, it } from "vitest";
import type { Entity, Hotkey, Skin } from "../api/types";
import { computeClashes, keycaps, keysOverlap, parseKey } from "./hotkeys";

const k = (s: string) => parseKey(s)!;

describe("parseKey (SPEC §8 key syntax)", () => {
  it("reads modifiers, no_ rules and VK names case-insensitively", () => {
    expect(k("no_modifiers 6")).toEqual({ vk: "6", required: [], forbidden: ["ctrl", "alt", "shift", "windows"], device: "keyboard" });
    expect(k("ALT 8")).toMatchObject({ vk: "8", required: ["alt"], forbidden: [] });
    expect(k("VK_F1").vk).toBe("F1");
    expect(k("f1").vk).toBe("F1");
    expect(k("ctrl no_shift x")).toMatchObject({ vk: "X", required: ["ctrl"], forbidden: ["shift"] });
    expect(k("XB_A").device).toBe("xinput");
    expect(parseKey("   ")).toBeNull();
  });

  it("renders keycaps", () => {
    expect(keycaps(k("alt 8"))).toEqual(["Alt", "8"]);
    expect(keycaps(k("VK_F10"))).toEqual(["F10"]);
  });
});

describe("keysOverlap", () => {
  it("follows 3DMigoto's don't-care modifier rule", () => {
    expect(keysOverlap(k("8"), k("alt 8"))).toBe(true);
    expect(keysOverlap(k("8"), k("no_modifiers 8"))).toBe(true);
    expect(keysOverlap(k("no_modifiers 8"), k("alt 8"))).toBe(false);
    expect(keysOverlap(k("9"), k("alt 9"))).toBe(true);
    expect(keysOverlap(k("8"), k("9"))).toBe(false);
    expect(keysOverlap(k("XB_A"), k("XB_A"))).toBe(false);
  });
});

function hk(keys: string, gated: boolean): Hotkey {
  return { keys, label: keys, kind: "toggle", gated, section: "Key", iniFile: "x.ini", parsed: [k(keys)] };
}
function skin(id: string, entityId: string, hotkeys: Hotkey[]): Skin {
  return { id, entityId, name: id, folders: [], nsfw: false, previews: [], hotkeys, hashes: [], addedAt: "" };
}
function ent(id: string, category: Entity["category"], parentId?: string): Entity {
  return { id, name: id, category, parentId, skinIds: [] };
}

describe("computeClashes severity", () => {
  const ents = new Map(
    [ent("paimon", "character"), ent("sandrone", "character"), ent("teaspoon", "weapon"), ent("fischl", "character"), ent("oz", "extra", "fischl")].map((e) => [e.id, e]),
  );

  it("gated keys on two characters are only an overlap note", () => {
    const c = computeClashes([skin("p", "paimon", [hk("8", true)]), skin("s", "sandrone", [hk("no_modifiers 8", true), hk("alt 8", true)])], ents);
    expect(c.filter((x) => x.skinId === "p").map((x) => x.severity)).toEqual(["overlap", "overlap"]);
  });

  it("a weapon with a character is a red conflict even when gated", () => {
    const c = computeClashes([skin("p", "paimon", [hk("9", true)]), skin("t", "teaspoon", [hk("alt 9", true)])], ents);
    expect(c.map((x) => x.severity)).toEqual(["conflict", "conflict"]);
  });

  it("an ungated key is a red conflict", () => {
    const c = computeClashes([skin("p", "paimon", [hk("6", false)]), skin("s", "sandrone", [hk("6", true)])], ents);
    expect(c.every((x) => x.severity === "conflict")).toBe(true);
  });

  it("an extra with its parent is a red conflict", () => {
    const c = computeClashes([skin("f", "fischl", [hk("5", true)]), skin("o", "oz", [hk("5", true)])], ents);
    expect(c.every((x) => x.severity === "conflict")).toBe(true);
  });
});
