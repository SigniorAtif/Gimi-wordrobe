// App keyboard shortcuts (SPEC §12): key combos like "Ctrl+H", and which action a key press asks for. Pure, so it is
// testable without a DOM; the UI decides what each action means for the focused element and the layout.
import { ARROWS, type Direction } from "./spatial";

/** The fields of a KeyboardEvent this module reads. */
export interface KeyLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey?: boolean;
  isComposing?: boolean;
}

export interface Combo {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** "H", "F5", "ArrowUp": single characters upper-cased */
  key: string;
}

const MODIFIER_KEYS = new Set(["Control", "Alt", "AltGraph", "Shift", "Meta", "OS"]);
const MODIFIER_NAMES = new Set(["ctrl", "control", "alt", "shift", "meta"]);

/**
 * The combo a key press makes, written the way Settings stores it ("Ctrl+Shift+H"). Letters and digits come from the
 * physical key, so Shift+1 reads "Shift+1", not "Shift+!". null while only a modifier is down.
 */
export function comboFromKey(e: KeyLike): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  let key = e.code.startsWith("Key") ? e.code.slice(3) : e.code.startsWith("Digit") ? e.code.slice(5) : e.key;
  if (key.length === 1) key = key.toUpperCase();
  parts.push(key);
  return parts.join("+");
}

/** "shift + ctrl + h" -> { ctrl, shift, key: "H" }. null for an empty key, a modifier-only or an unknown modifier. */
export function parseCombo(text: string): Combo | null {
  const parts = text.split("+").map((p) => p.trim());
  const raw = parts.pop() ?? "";
  if (!raw || MODIFIER_NAMES.has(raw.toLowerCase())) return null;
  const combo: Combo = { ctrl: false, alt: false, shift: false, key: raw.length === 1 ? raw.toUpperCase() : raw };
  for (const m of parts.map((p) => p.toLowerCase())) {
    if (m === "ctrl" || m === "control") combo.ctrl = true;
    else if (m === "alt") combo.alt = true;
    else if (m === "shift") combo.shift = true;
    else return null;
  }
  return combo;
}

/** Canonical spelling: modifiers in Ctrl, Alt, Shift order. */
export function formatCombo(c: Combo): string {
  return [c.ctrl && "Ctrl", c.alt && "Alt", c.shift && "Shift", c.key].filter(Boolean).join("+");
}

/** Same keys, ignoring modifier order and case ("Shift+Ctrl+h" equals "Ctrl+Shift+H"). */
export function sameCombo(a: string, b: string): boolean {
  const x = parseCombo(a);
  const y = parseCombo(b);
  return !!x && !!y && x.ctrl === y.ctrl && x.alt === y.alt && x.shift === y.shift && x.key.toLowerCase() === y.key.toLowerCase();
}

/** True when a key press matches a stored combo like "Ctrl+H". */
export function matchesCombo(e: KeyLike, combo: string): boolean {
  const c = comboFromKey(e);
  return !!c && sameCombo(c, combo);
}

/** App shortcuts the reveal hotkey may not shadow (SPEC §12), text editing keys, and Alt+F4. Mirrors settings.rs. */
export const RESERVED_COMBOS: Record<string, string> = {
  "Ctrl+S": "Ctrl+S applies your changes",
  "Ctrl+Z": "Ctrl+Z undoes the last pick",
  "Ctrl+F": "Ctrl+F focuses search",
  "Ctrl+V": "Ctrl+V pastes a preview image",
  "Ctrl+A": "Ctrl+A selects text",
  "Ctrl+C": "Ctrl+C copies",
  "Ctrl+X": "Ctrl+X cuts",
  "Alt+F4": "Alt+F4 closes the window",
};

export interface HotkeyProblem {
  /** the backend's error code for the same refusal */
  code: "invalid_hotkey" | "reserved_hotkey";
  message: string;
}

/**
 * Why a combo can't be the NSFW reveal hotkey, or null when it can. It needs Ctrl or Alt, because plain typing focuses
 * search, and it may not be another app shortcut. The backend refuses the same combos (settings.rs check_hotkey).
 */
export function revealHotkeyProblem(combo: string): HotkeyProblem | null {
  const c = parseCombo(combo);
  if (!c || (!c.ctrl && !c.alt)) return { code: "invalid_hotkey", message: "The NSFW reveal hotkey needs Ctrl or Alt plus a key, e.g. Ctrl+H." };
  const reserved = Object.keys(RESERVED_COMBOS).find((r) => sameCombo(r, combo));
  return reserved ? { code: "reserved_hotkey", message: `${RESERVED_COMBOS[reserved]}. Pick another reveal hotkey.` } : null;
}

export type ShortcutAction =
  | { type: "toggleNsfw" }
  | { type: "apply" }
  | { type: "undo" }
  /** Ctrl+F, or plain typing (`text` is the typed character, to put in the search field) */
  | { type: "search"; text?: string }
  | { type: "move"; dir: Direction }
  /** Enter: Shelves opens the shelf, then A2; Pages opens A2 */
  | { type: "open" }
  /** Space: pick the focused skin */
  | { type: "pick" }
  /** I: quick peek (Shelves) / open A3 (Pages) */
  | { type: "peek" }
  /** Esc / Backspace: close the shelf or go back */
  | { type: "back" };

export interface ShortcutContext {
  /** Settings › NSFW reveal hotkey */
  nsfwHotkey: string;
  /** focus is in a text field, so plain keys belong to it */
  typing: boolean;
}

/**
 * The SPEC §12 action a key press asks for, or null to leave the key alone. Combos with Ctrl or Alt work while typing
 * (except Ctrl+Z, which undoes text there); plain keys don't. Only for the focused window: there is no global hook.
 */
export function resolveShortcut(e: KeyLike, ctx: ShortcutContext): ShortcutAction | null {
  if (e.isComposing) return null;
  if (matchesCombo(e, ctx.nsfwHotkey)) return { type: "toggleNsfw" };
  const ctrl = e.ctrlKey || !!e.metaKey;
  if (ctrl && !e.altKey && !e.shiftKey) {
    const k = e.key.toLowerCase();
    if (k === "s") return { type: "apply" };
    if (k === "f") return { type: "search" };
    if (k === "z") return ctx.typing ? null : { type: "undo" };
  }
  if (ctx.typing || ctrl || e.altKey) return null;
  if (e.key in ARROWS) return e.shiftKey ? null : { type: "move", dir: ARROWS[e.key] };
  switch (e.key) {
    case "Enter":
      return { type: "open" };
    case " ":
      return { type: "pick" };
    case "Escape":
    case "Backspace":
      return { type: "back" };
    case "i":
    case "I":
      return { type: "peek" };
  }
  // "just type": any other printable character starts a search with it
  return e.key.length === 1 ? { type: "search", text: e.key } : null;
}
