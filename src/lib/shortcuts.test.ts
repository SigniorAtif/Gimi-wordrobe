import { describe, expect, it } from "vitest";
import { comboFromKey, formatCombo, matchesCombo, parseCombo, resolveShortcut, revealHotkeyProblem, sameCombo, type KeyLike } from "./shortcuts";

/** A key press: `press("h", { ctrl: true })`. Letters and digits get their physical `code`. */
function press(key: string, mods: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean } = {}, code?: string): KeyLike {
  const physical = /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : /^\d$/.test(key) ? `Digit${key}` : key;
  return { key, code: code ?? physical, ctrlKey: !!mods.ctrl, altKey: !!mods.alt, shiftKey: !!mods.shift, metaKey: !!mods.meta };
}

const ctx = { nsfwHotkey: "Ctrl+H", typing: false };

describe("key combos", () => {
  it("are written the way Settings stores them", () => {
    expect(comboFromKey(press("h", { ctrl: true }))).toBe("Ctrl+H");
    expect(comboFromKey(press("N", { alt: true, shift: true }))).toBe("Alt+Shift+N");
    // Shift+1 is the physical key, not "!"
    expect(comboFromKey(press("!", { ctrl: true, shift: true }, "Digit1"))).toBe("Ctrl+Shift+1");
    expect(comboFromKey(press("F5", { ctrl: true }))).toBe("Ctrl+F5");
    expect(comboFromKey(press("Control", { ctrl: true }, "ControlLeft"))).toBeNull();
  });

  it("parse and format canonically", () => {
    expect(parseCombo(" shift + ctrl + h ")).toEqual({ ctrl: true, alt: false, shift: true, key: "H" });
    expect(formatCombo(parseCombo("shift+alt+ctrl+f5")!)).toBe("Ctrl+Alt+Shift+f5");
    for (const bad of ["", "+", "Ctrl+", "Ctrl+Shift", "Win+H"]) expect(parseCombo(bad)).toBeNull();
  });

  it("match regardless of modifier order and case", () => {
    expect(sameCombo("Shift+Ctrl+h", "Ctrl+Shift+H")).toBe(true);
    expect(sameCombo("Ctrl+H", "Ctrl+Shift+H")).toBe(false);
    expect(matchesCombo(press("h", { ctrl: true }), "ctrl+h")).toBe(true);
    expect(matchesCombo(press("h", { ctrl: true, shift: true }), "Ctrl+H")).toBe(false);
    // the physical key decides, so a layout that types another letter there still matches
    expect(matchesCombo(press("ч", { ctrl: true }, "KeyH"), "Ctrl+H")).toBe(true);
  });
});

describe("reveal hotkey rules (mirror settings.rs)", () => {
  it("needs Ctrl or Alt plus one key", () => {
    for (const bad of ["H", "Shift+H", "Ctrl+", "Ctrl+Shift", "Win+H"]) expect(revealHotkeyProblem(bad)?.code).toBe("invalid_hotkey");
    for (const ok of ["Ctrl+H", "Alt+H", "Ctrl+Shift+S", "Alt+Shift+N", "Ctrl+F5"]) expect(revealHotkeyProblem(ok)).toBeNull();
  });

  it("may not shadow another app shortcut", () => {
    for (const r of ["Ctrl+S", "ctrl+z", "Ctrl+F", "Alt+F4", "Ctrl+V", "ctrl+c", "Ctrl+A", "Ctrl+X"]) expect(revealHotkeyProblem(r)?.code).toBe("reserved_hotkey");
    expect(revealHotkeyProblem("Ctrl+S")?.message).toBe("Ctrl+S applies your changes. Pick another reveal hotkey.");
  });
});

describe("SPEC §12 shortcuts", () => {
  it("map each table row to its action", () => {
    expect(resolveShortcut(press("f", { ctrl: true }), ctx)).toEqual({ type: "search" });
    expect(resolveShortcut(press("k"), ctx)).toEqual({ type: "search", text: "k" });
    expect(resolveShortcut(press("ArrowDown"), ctx)).toEqual({ type: "move", dir: "down" });
    expect(resolveShortcut(press("ArrowLeft"), ctx)).toEqual({ type: "move", dir: "left" });
    expect(resolveShortcut(press("Enter"), ctx)).toEqual({ type: "open" });
    expect(resolveShortcut(press(" ", {}, "Space"), ctx)).toEqual({ type: "pick" });
    expect(resolveShortcut(press("i"), ctx)).toEqual({ type: "peek" });
    expect(resolveShortcut(press("Escape"), ctx)).toEqual({ type: "back" });
    expect(resolveShortcut(press("Backspace"), ctx)).toEqual({ type: "back" });
    expect(resolveShortcut(press("s", { ctrl: true }), ctx)).toEqual({ type: "apply" });
    expect(resolveShortcut(press("z", { ctrl: true }), ctx)).toEqual({ type: "undo" });
    expect(resolveShortcut(press("h", { ctrl: true }), ctx)).toEqual({ type: "toggleNsfw" });
  });

  it("use the configured reveal hotkey instead of Ctrl+H", () => {
    const custom = { ...ctx, nsfwHotkey: "Alt+Shift+N" };
    expect(resolveShortcut(press("N", { alt: true, shift: true }), custom)).toEqual({ type: "toggleNsfw" });
    expect(resolveShortcut(press("h", { ctrl: true }), custom)).toBeNull();
  });

  it("leave plain keys and Ctrl+Z to a text field, but keep combos working there", () => {
    const typing = { ...ctx, typing: true };
    for (const k of ["k", "i", " ", "Enter", "Backspace", "Escape", "ArrowDown"]) expect(resolveShortcut(press(k), typing)).toBeNull();
    expect(resolveShortcut(press("z", { ctrl: true }), typing)).toBeNull();
    expect(resolveShortcut(press("s", { ctrl: true }), typing)).toEqual({ type: "apply" });
    expect(resolveShortcut(press("f", { ctrl: true }), typing)).toEqual({ type: "search" });
    expect(resolveShortcut(press("h", { ctrl: true }), typing)).toEqual({ type: "toggleNsfw" });
  });

  it("ignore keys with no shortcut", () => {
    for (const k of [press("Tab"), press("F5"), press("Dead"), press("a", { alt: true }), press("c", { ctrl: true }), press("ArrowUp", { shift: true })]) {
      expect(resolveShortcut(k, ctx)).toBeNull();
    }
    expect(resolveShortcut({ ...press("k"), isComposing: true }, ctx)).toBeNull();
  });

  it("leave the Windows key to the OS", () => {
    expect(resolveShortcut(press("s", { meta: true }), ctx)).toBeNull();
    expect(resolveShortcut(press("ArrowLeft", { meta: true }), ctx)).toBeNull();
    expect(resolveShortcut(press("h", { ctrl: true, meta: true }), ctx)).toBeNull();
  });

  it("use the physical key, so a non-Latin layout still works", () => {
    // Russian layout: the S key types "ы", F types "а", Z types "я"
    expect(resolveShortcut(press("ы", { ctrl: true }, "KeyS"), ctx)).toEqual({ type: "apply" });
    expect(resolveShortcut(press("а", { ctrl: true }, "KeyF"), ctx)).toEqual({ type: "search" });
    expect(resolveShortcut(press("я", { ctrl: true }, "KeyZ"), ctx)).toEqual({ type: "undo" });
  });
});
