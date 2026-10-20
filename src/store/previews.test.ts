import { beforeEach, describe, expect, it, vi } from "vitest";

// the browser harness's mock backend instead of Tauri
vi.mock("@api-impl", async () => await import("../api/mock"));

const { api, mockControls } = await import("../api/mock");
const { useApp } = await import("./app");
const { useHome } = await import("./home");
const { usePreviews, isRunning } = await import("./previews");

const skinOf = (id: string) => useApp.getState().snapshot!.library.skins.find((s) => s.id === id)!;
const texts = () => useApp.getState().toasts.map((t) => t.text);

describe("previews store (SPEC §10)", () => {
  beforeEach(async () => {
    mockControls.latencyMs = 0;
    mockControls.gameBananaMs = 0;
    mockControls.failNextGameBanana = false;
    mockControls.gameBananaNsfw = false;
    useApp.setState({ snapshot: await api.load(), toasts: [] });
    useHome.setState({ nsfwVisible: false });
  });

  it("tracks a fetch per skin, keeps the failure for Retry, and clears it on the next try", async () => {
    const id = mockControls.world.library.skins[4].id;
    useApp.getState().setSnapshot(await api.updateSkin(id, { gameBananaUrl: "https://gamebanana.com/mods/77" }));
    const before = skinOf(id).previews.length;

    mockControls.failNextGameBanana = true;
    const failing = usePreviews.getState().fetchGameBanana(id);
    expect(usePreviews.getState().fetching[id]).toBeDefined();
    expect(await failing).toBe(false);
    expect(usePreviews.getState().fetching[id]).toBeUndefined();
    expect(usePreviews.getState().failed[id]).toBe("network");
    expect(texts()).toContain("Couldn't reach GameBanana.");

    const retry = usePreviews.getState().fetchGameBanana(id);
    expect(usePreviews.getState().failed[id]).toBeUndefined();
    expect(await retry).toBe(true);
    expect(skinOf(id).previews.length).toBe(before + 3);
  });

  it("says 18+ without naming a skin that is hidden now", async () => {
    const id = mockControls.world.library.skins[5].id;
    useApp.getState().setSnapshot(await api.updateSkin(id, { gameBananaUrl: "https://gamebanana.com/mods/78" }));
    mockControls.gameBananaNsfw = true;
    await usePreviews.getState().fetchGameBanana(id);
    expect(skinOf(id).nsfw).toBe(true);
    const toast = useApp.getState().toasts.find((t) => t.text.startsWith("Marked 18+"));
    expect(toast?.detail).toBe("It's hidden now. Press Ctrl+H to show 18+ skins.");
    // fetching again finds nothing new; the toast names it only as "a hidden skin"
    await usePreviews.getState().fetchGameBanana(id);
    expect(texts().at(-1)).toBe("GameBanana had no new previews for a hidden skin.");
  });

  it("lets a newer fetch own the state when the link changes mid-download", async () => {
    const id = mockControls.world.library.skins[6].id;
    useApp.getState().setSnapshot(await api.updateSkin(id, { gameBananaUrl: "https://gamebanana.com/mods/79" }));
    mockControls.gameBananaMs = 30;
    mockControls.failNextGameBanana = true;
    const first = usePreviews.getState().fetchGameBanana(id);
    const second = usePreviews.getState().fetchGameBanana(id);
    // the mock fails whichever download finishes first; that one is the superseded fetch
    expect(await first).toBe(false);
    expect(usePreviews.getState().failed[id]).toBeUndefined();
    expect(usePreviews.getState().fetching[id]).toBeDefined();
    expect(await second).toBe(true);
    expect(usePreviews.getState().fetching[id]).toBeUndefined();
  });

  it("adds dropped images, pastes, reorders, removes and searches the mod folder", async () => {
    const id = mockControls.world.library.skins[7].id;
    const n = skinOf(id).previews.length;
    await usePreviews.getState().addFiles(id, ["C:\\a\\one.png", "C:\\a\\notes.txt", "C:\\a\\two.jpg"]);
    expect(skinOf(id).previews.length).toBe(n + 2);
    expect(texts().at(-1)).toMatch(/^Added 2 images to .+'s previews\.$/);
    await usePreviews.getState().addFiles(id, ["C:\\a\\one.png"]);
    expect(texts().at(-1)).toBe("That image is already one of this skin's previews.");

    await usePreviews.getState().paste(id, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]));
    const files = skinOf(id).previews.map((p) => p.file);
    expect(files).toHaveLength(n + 3);

    const pending = usePreviews.getState().reorder(id, [files.at(-1)!]);
    expect(isRunning(usePreviews.getState(), "reorder", id)).toBe(true);
    expect(await pending).toBe(true);
    expect(isRunning(usePreviews.getState(), "reorder", id)).toBe(false);
    expect(skinOf(id).previews[0].file).toBe(files.at(-1));

    expect(await usePreviews.getState().remove(id, files[0])).toBe(true);
    expect(skinOf(id).previews.some((p) => p.file === files[0])).toBe(false);
    expect(await usePreviews.getState().remove(id, files[0])).toBe(false);
    expect(texts().at(-1)).toBe("That image was already removed.");

    await usePreviews.getState().findInFolder(id);
    expect(texts().at(-1)).toBe("Found 1 preview in the mod folder.");
    await usePreviews.getState().findInFolder(id);
    expect(texts().at(-1)).toBe("No preview images in the mod folder.");
  });
});
