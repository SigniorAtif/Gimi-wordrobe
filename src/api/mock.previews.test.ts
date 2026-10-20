import { beforeEach, describe, expect, it } from "vitest";
import type { ApiFailure } from "./api";
import { api, mockControls } from "./mock";

const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as ApiFailure).code;
  }
  return "resolved";
}

const skinOf = async (id: string) => (await api.load()).library.skins.find((s) => s.id === id)!;

describe("mock previews (VITE_MOCK=1 mirrors core/previews.rs)", () => {
  beforeEach(() => {
    mockControls.latencyMs = 0;
    mockControls.gameBananaMs = 0;
    mockControls.failNextGameBanana = false;
    mockControls.gameBananaNsfw = false;
  });

  it("adds dropped and pasted images, skips duplicates and non-images, reorders and removes", async () => {
    const id = mockControls.world.library.skins[0].id;
    const before = (await skinOf(id)).previews.length;
    let snap = await api.addPreview(id, "C:\\Users\\you\\Pictures\\shot.PNG");
    let skin = snap.library.skins.find((s) => s.id === id)!;
    const dropped = skin.previews.at(-1)!;
    expect(dropped.source).toBe("user");
    expect(dropped.file).toMatch(new RegExp(`^previews/${id}/\\d{2}\\.png$`));
    expect(api.assetUrl(dropped.file)).not.toBe("");
    expect(await code(api.addPreview(id, "C:\\Users\\you\\Pictures\\shot.png"))).toBe("duplicate");
    expect(await code(api.addPreview(id, "C:\\notes.txt"))).toBe("not_an_image");

    snap = await api.pastePreview(id, JPG);
    skin = snap.library.skins.find((s) => s.id === id)!;
    const pasted = skin.previews.at(-1)!;
    expect(pasted.file.endsWith(".jpg")).toBe(true);
    expect(await code(api.pastePreview(id, JPG))).toBe("duplicate");
    expect(await code(api.pastePreview(id, new TextEncoder().encode("<svg/>")))).toBe("not_an_image");
    expect(skin.previews).toHaveLength(before + 2);

    // the pasted image becomes the cover, the rest keep their order
    snap = await api.updateSkin(id, { previewOrder: [pasted.file] });
    skin = snap.library.skins.find((s) => s.id === id)!;
    expect(skin.previews[0].file).toBe(pasted.file);
    expect(skin.previews.at(-1)!.file).toBe(dropped.file);

    snap = await api.removePreview(id, pasted.file);
    skin = snap.library.skins.find((s) => s.id === id)!;
    expect(skin.previews.some((p) => p.file === pasted.file)).toBe(false);
    expect(api.assetUrl(pasted.file)).toBe("");
    expect(await code(api.removePreview(id, pasted.file))).toBe("unknown_preview");
    expect(await code(api.addPreview("nope", "a.png"))).toBe("unknown_skin");
  });

  it("fetches GameBanana previews once, fails quietly, and reads links", async () => {
    const id = mockControls.world.library.skins[1].id;
    await api.updateSkin(id, { gameBananaUrl: "" });
    expect(await code(api.fetchGameBananaPreviews(id))).toBe("no_link");
    await api.updateSkin(id, { gameBananaUrl: "https://gamebanana.com/mods/123" });
    const before = (await skinOf(id)).previews.length;

    mockControls.failNextGameBanana = true;
    expect(await code(api.fetchGameBananaPreviews(id))).toBe("network");
    expect((await skinOf(id)).previews).toHaveLength(before);

    mockControls.gameBananaNsfw = true;
    const first = await api.fetchGameBananaPreviews(id);
    expect(first.added).toBe(3);
    expect(first.markedNsfw).toBe(true);
    const skin = first.snapshot.library.skins.find((s) => s.id === id)!;
    expect(skin.nsfw).toBe(true);
    expect(skin.previews.slice(-3).every((p) => p.source === "gamebanana")).toBe(true);
    expect((await api.fetchGameBananaPreviews(id)).added).toBe(0);

    const info = await api.gameBananaInfo("https://gamebanana.com/mods/123");
    expect(info.modId).toBe(123);
    expect(info.images.every((u) => u.startsWith("https://images.gamebanana.com/"))).toBe(true);
    expect(await code(api.gameBananaInfo("https://example.com/mods/1"))).toBe("bad_link");
    expect(await code(api.gameBananaInfo("https://gamebanana.com/mods/404"))).toBe("gamebanana");
  });

  it("finds previews in a skin's folder once", async () => {
    const id = mockControls.world.library.skins[2].id;
    expect((await api.findFolderPreviews(id)).added).toBe(1);
    expect((await api.findFolderPreviews(id)).added).toBe(0);
  });

  it("refuses a full skin with too_many, like Rust", async () => {
    const id = mockControls.world.library.skins[3].id;
    await api.updateSkin(id, { gameBananaUrl: "https://gamebanana.com/mods/321" });
    // one slot left: GameBanana fills just that one
    for (let n = (await skinOf(id)).previews.length; n < 29; n++) {
      await api.pastePreview(id, new Uint8Array([...JPG, n & 0xff, n >> 8]));
    }
    expect((await api.fetchGameBananaPreviews(id)).added).toBe(1);
    expect((await skinOf(id)).previews).toHaveLength(30);
    let failure: ApiFailure | undefined;
    try {
      await api.fetchGameBananaPreviews(id);
    } catch (e) {
      failure = e as ApiFailure;
    }
    expect(failure?.code).toBe("too_many");
    expect(failure?.message).toBe("This skin already has 30 previews. Remove one first.");
    expect(await code(api.findFolderPreviews(id))).toBe("too_many");
    expect(await code(api.pastePreview(id, new Uint8Array([...JPG, 0xee])))).toBe("too_many");
    expect((await skinOf(id)).previews).toHaveLength(30);
  });
});
