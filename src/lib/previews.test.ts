import { describe, expect, it } from "vitest";
import {
  canRetry,
  fetchResultToasts,
  gameBananaSkinName,
  isImagePath,
  moveItem,
  orderedPreviews,
  previewFailureToast,
  slotAt,
  sourceCaption,
} from "./previews";

describe("preview toasts (SPEC §10)", () => {
  it("gives friendly text for the backend's codes", () => {
    expect(previewFailureToast("duplicate", "That image is already one of this skin's previews.", "add")).toEqual({
      kind: "info",
      text: "That image is already one of this skin's previews.",
    });
    expect(previewFailureToast("not_an_image", "That image is over 25 MB.", "paste")).toMatchObject({ kind: "error", detail: "That image is over 25 MB." });
    expect(previewFailureToast("too_many", "This skin already has 30 previews. Remove one first.", "add").text).toBe("No room for more previews.");
    expect(previewFailureToast("link_changed", "", "fetch").text).toMatch(/link changed/);
    // a background fetch fails quietly (no error shake); a drop the user just made doesn't
    expect(previewFailureToast("network", "Couldn't reach GameBanana (timed out).", "fetch").kind).toBe("info");
    expect(previewFailureToast("gamebanana", "GameBanana says: This Mod doesn't exist", "fetch").detail).toBe("GameBanana says: This Mod doesn't exist");
    expect(previewFailureToast("weird", "disk on fire", "remove")).toEqual({ kind: "error", text: "Couldn't remove the image.", detail: "disk on fire" });
  });

  it("offers Retry only where retrying can help", () => {
    expect(canRetry("network")).toBe(true);
    expect(canRetry("link_changed")).toBe(true);
    expect(canRetry("too_many")).toBe(false);
    expect(canRetry("no_link")).toBe(false);
    expect(canRetry(undefined)).toBe(false);
  });

  it("speaks up after a fetch only when there is something to say", () => {
    const ctx = { name: "Remembrance", hiddenNow: false, hotkey: "Ctrl+H" };
    expect(fetchResultToasts({ added: 3, failed: 0, markedNsfw: false }, ctx)).toEqual([]);
    expect(fetchResultToasts({ added: 0, failed: 0, markedNsfw: false }, ctx)).toEqual([{ kind: "info", text: "GameBanana had no new previews for Remembrance." }]);
    const [nsfw, failed] = fetchResultToasts({ added: 2, failed: 1, markedNsfw: true }, { ...ctx, hiddenNow: true });
    expect(nsfw).toEqual({ kind: "info", text: "Marked 18+ because GameBanana rates it.", detail: "It's hidden now. Press Ctrl+H to show 18+ skins." });
    expect(failed).toEqual({ kind: "info", text: "1 GameBanana image couldn't be downloaded.", detail: "The other 2 images were added." });
    expect(fetchResultToasts({ added: 0, failed: 0, markedNsfw: true }, ctx)[0].detail).toBeUndefined();
  });
});

describe("gallery helpers", () => {
  it("captions the image sources", () => {
    const p = (source: "gamebanana" | "archive" | "user") => ({ source });
    expect(sourceCaption([p("gamebanana"), p("archive"), p("gamebanana"), p("gamebanana"), p("archive")])).toBe("3 from GameBanana · 2 from archive");
    expect(sourceCaption([p("user")])).toBe("1 added by you");
    expect(sourceCaption([])).toBe("");
  });

  it("moves items and keeps unknown files after a local order", () => {
    expect(moveItem(["a", "b", "c", "d"], 3, 0)).toEqual(["d", "a", "b", "c"]);
    expect(moveItem(["a", "b", "c"], 0, 9)).toEqual(["b", "c", "a"]);
    expect(moveItem(["a"], 5, 0)).toEqual(["a"]);
    const previews = [{ file: "1" }, { file: "2" }, { file: "3" }];
    expect(orderedPreviews(previews, null).map((p) => p.file)).toEqual(["1", "2", "3"]);
    // "2" was removed meanwhile and "4" arrived: drop the one, append the other
    expect(orderedPreviews([...previews.filter((p) => p.file !== "2"), { file: "4" }], ["3", "2", "1"]).map((p) => p.file)).toEqual(["3", "1", "4"]);
  });

  it("finds the grid slot under the pointer, or the nearest one", () => {
    const slots = [0, 1, 2, 3].map((i) => ({ x: (i % 2) * 110, y: Math.floor(i / 2) * 90, w: 100, h: 80 }));
    expect(slotAt(slots, 50, 40)).toBe(0);
    expect(slotAt(slots, 150, 130)).toBe(3);
    expect(slotAt(slots, 104, 10)).toBe(0); // the gap, closer to the left slot
    expect(slotAt(slots, 400, 400)).toBe(3);
    expect(slotAt([], 0, 0)).toBe(-1);
  });

  it("knows image paths", () => {
    expect(isImagePath("C:\\Pics\\shot.PNG")).toBe(true);
    expect(isImagePath("/tmp/a.jpeg")).toBe(true);
    expect(isImagePath("mod.zip")).toBe(false);
    expect(isImagePath("x.gif")).toBe(false);
  });

  it("turns a GameBanana title into a skin name without the character", () => {
    expect(gameBananaSkinName("Furina - Remembrance", "Furina")).toBe("Remembrance");
    expect(gameBananaSkinName("Furina's  Remembrance Outfit", "Furina")).toBe("Remembrance Outfit");
    expect(gameBananaSkinName("Raiden Shogun | Ei Kimono", "Raiden Shogun")).toBe("Ei Kimono");
    expect(gameBananaSkinName("Mock Mod 123", "Mona")).toBe("Mock Mod 123");
    // a name inside a longer word stays, and a title that is only the name is kept
    expect(gameBananaSkinName("Monastery Robes", "Mona")).toBe("Monastery Robes");
    expect(gameBananaSkinName("Furina", "Furina")).toBe("Furina");
  });
});
