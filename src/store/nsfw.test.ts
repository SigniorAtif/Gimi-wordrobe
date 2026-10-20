import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Entity, PinCheck, Skin, Snapshot } from "../api/types";

const verifyPin = vi.fn<(pin: string) => Promise<PinCheck>>();
vi.mock("../api", () => ({
  api: { verifyPin: (pin: string) => verifyPin(pin) },
  toFailure: (e: unknown) => e,
}));

const { useApp } = await import("./app");
const { useHome } = await import("./home");

const skin = (id: string, entityId: string, nsfw: boolean): Skin => ({
  id,
  entityId,
  name: id,
  folders: [id],
  nsfw,
  previews: [],
  hotkeys: [],
  hashes: [],
  addedAt: "2026-10-01T00:00:00Z",
});
const entity = (id: string, skinIds: string[]): Entity => ({ id, name: id, category: "character", skinIds, aliases: [] });

function world(pinSet: boolean): Snapshot {
  return {
    settings: { nsfw: { hotkey: "Ctrl+H", whenHidden: "stub", autoRehide: true } } as Snapshot["settings"],
    library: { version: 1, entities: [entity("varesa", ["v-safe", "v-lewd"])], skins: [skin("v-safe", "varesa", false), skin("v-lewd", "varesa", true)] },
    disk: { modsPath: null, modsExists: true, skins: {}, active: { varesa: ["v-safe"] }, libraries: [], unknownRoots: [], archives: [] },
    changedOutside: false,
    recovered: null,
    hashIndex: {} as Snapshot["hashIndex"],
    configured: true,
    sameDrive: true,
    notice: null,
    pinSet,
    modFixes: false,
  };
}

beforeEach(() => {
  verifyPin.mockReset();
  useApp.setState({ snapshot: world(false), route: { name: "home" }, history: [], navDir: 1 });
  useHome.setState({ nsfwVisible: false, nsfwEpoch: 0, pinPrompt: false, pinRetryAt: 0, peek: null, morphSkin: null, openShelf: null });
});

describe("revealing 18+ skins (SPEC §11)", () => {
  it("reveals straight away without a PIN", () => {
    useHome.getState().revealNsfw();
    expect(useHome.getState()).toMatchObject({ nsfwVisible: true, pinPrompt: false, nsfwEpoch: 1 });
  });

  it("asks for the PIN first when one is set, and shows nothing until it checks out", async () => {
    useApp.setState({ snapshot: world(true) });
    useHome.getState().toggleNsfw();
    expect(useHome.getState()).toMatchObject({ nsfwVisible: false, pinPrompt: true });

    verifyPin.mockResolvedValueOnce({ ok: false, retryIn: 0, triesLeft: 4 });
    await useHome.getState().submitPin("1111");
    expect(useHome.getState()).toMatchObject({ nsfwVisible: false, pinPrompt: true, pinRetryAt: 0 });

    verifyPin.mockResolvedValueOnce({ ok: true, retryIn: 0, triesLeft: 5 });
    await useHome.getState().submitPin("2580");
    expect(verifyPin).toHaveBeenLastCalledWith("2580");
    expect(useHome.getState()).toMatchObject({ nsfwVisible: true, pinPrompt: false });
  });

  it("remembers a lockout, so the prompt can count it down when it opens again", async () => {
    useApp.setState({ snapshot: world(true) });
    useHome.getState().revealNsfw();
    verifyPin.mockResolvedValueOnce({ ok: false, retryIn: 30, triesLeft: 0 });
    const before = Date.now();
    await useHome.getState().submitPin("0000");
    const { pinRetryAt, nsfwVisible } = useHome.getState();
    expect(nsfwVisible).toBe(false);
    expect(pinRetryAt).toBeGreaterThanOrEqual(before + 30_000);
    expect(pinRetryAt).toBeLessThan(before + 31_000);
  });

  it("doesn't reveal when the prompt was cancelled while the PIN was being checked", async () => {
    useApp.setState({ snapshot: world(true) });
    useHome.getState().revealNsfw();
    let answer!: (r: PinCheck) => void;
    verifyPin.mockReturnValueOnce(new Promise((r) => (answer = r)));
    const pending = useHome.getState().submitPin("2580");
    useHome.getState().closePinPrompt();
    answer({ ok: true, retryIn: 0, triesLeft: 5 });
    await pending;
    expect(useHome.getState().nsfwVisible).toBe(false);
  });
});

describe("hiding 18+ skins", () => {
  it("never needs the PIN", () => {
    useApp.setState({ snapshot: world(true) });
    useHome.setState({ nsfwVisible: true });
    useHome.getState().toggleNsfw();
    expect(useHome.getState()).toMatchObject({ nsfwVisible: false, pinPrompt: false });
    expect(verifyPin).not.toHaveBeenCalled();
  });

  it("closes a quick peek at a now-hidden skin, but not at a safe one", () => {
    useHome.setState({ nsfwVisible: true, openShelf: "varesa", peek: "v-lewd" });
    useHome.getState().hideNsfw();
    expect(useHome.getState().peek).toBeNull();

    useHome.setState({ nsfwVisible: true, peek: "v-safe" });
    useHome.getState().hideNsfw();
    expect(useHome.getState().peek).toBe("v-safe");
  });

  it("leaves the detail page of a now-hidden skin for its entity, and forgets it", () => {
    useHome.setState({ nsfwVisible: true });
    useApp.setState({ route: { name: "skin", skinId: "v-lewd" }, history: [{ name: "home" }, { name: "entity", entityId: "varesa" }] });
    useHome.getState().hideNsfw();
    expect(useApp.getState()).toMatchObject({ route: { name: "entity", entityId: "varesa" }, history: [{ name: "home" }], navDir: -1 });
  });

  it("drops hidden detail pages from the history behind Settings", () => {
    useHome.setState({ nsfwVisible: true });
    useApp.setState({ route: { name: "settings" }, history: [{ name: "home" }, { name: "skin", skinId: "v-lewd" }] });
    useHome.getState().hideNsfw();
    expect(useApp.getState()).toMatchObject({ route: { name: "settings" }, history: [{ name: "home" }] });
    useApp.getState().back();
    expect(useApp.getState().route).toEqual({ name: "home" });
  });

  it("closes an open PIN prompt too (auto re-hide while it asks)", () => {
    useApp.setState({ snapshot: world(true) });
    useHome.getState().revealNsfw();
    useHome.getState().hideNsfw();
    expect(useHome.getState().pinPrompt).toBe(false);
  });
});
