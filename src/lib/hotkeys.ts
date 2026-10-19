// Hotkey parsing, overlap and conflict rules (SPEC §8).
// The Rust core (src-tauri/src/core/hotkeys.rs) is the canonical parser that fills Hotkey.parsed;
// this file mirrors it for the mock backend and computes conflicts against the pending state in the UI.
import type { Category, Entity, Hotkey, Modifier, ParsedKey, Skin } from "../api/types";

const MODS: Modifier[] = ["ctrl", "alt", "shift", "windows"];

const VK_ALIASES: Record<string, string> = {
  CONTROL: "CTRL",
  RETURN: "ENTER",
  ESC: "ESCAPE",
  PRIOR: "PAGEUP",
  NEXT: "PAGEDOWN",
  BACK: "BACKSPACE",
};

/** Parse one 3DMigoto key binding ("no_modifiers 6", "alt 8", "VK_F1", "ctrl shift x"). */
export function parseKey(raw: string): ParsedKey | null {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  const required = new Set<Modifier>();
  const forbidden = new Set<Modifier>();
  let vk: string | null = null;
  for (const t of tokens) {
    const low = t.toLowerCase();
    if (low === "no_modifiers") {
      MODS.forEach((m) => forbidden.add(m));
      continue;
    }
    if (low.startsWith("no_")) {
      const m = normMod(low.slice(3));
      if (m) {
        forbidden.add(m);
        continue;
      }
    }
    const m = normMod(low);
    if (m) {
      required.add(m);
      continue;
    }
    vk = normVk(t);
  }
  if (!vk) return null;
  // A modifier that is both required and forbidden can never fire; keep "required" (matches 3DMigoto's later check order).
  required.forEach((m) => forbidden.delete(m));
  const device: ParsedKey["device"] = vk.startsWith("XB_")
    ? "xinput"
    : /^(LBUTTON|RBUTTON|MBUTTON|XBUTTON1|XBUTTON2)$/.test(vk)
      ? "mouse"
      : "keyboard";
  return { vk, required: MODS.filter((x) => required.has(x)), forbidden: MODS.filter((x) => forbidden.has(x)), device };
}

function normMod(s: string): Modifier | null {
  if (s === "ctrl" || s === "control") return "ctrl";
  if (s === "alt" || s === "menu") return "alt";
  if (s === "shift") return "shift";
  if (s === "windows" || s === "win") return "windows";
  return null;
}

function normVk(t: string): string {
  let u = t.toUpperCase();
  if (u.length === 1) return u;
  if (/^0X[0-9A-F]+$/.test(u)) return u;
  if (u.startsWith("VK_")) u = u.slice(3);
  return VK_ALIASES[u] ?? u;
}

/** Two keys overlap when some real key press fires both. */
export function keysOverlap(a: ParsedKey, b: ParsedKey): boolean {
  if (a.device !== "keyboard" || b.device !== "keyboard") return false;
  if (a.vk !== b.vk) return false;
  const clash = (x: ParsedKey, y: ParsedKey) => x.required.some((m) => y.forbidden.includes(m));
  return !clash(a, b) && !clash(b, a);
}

export function hotkeysOverlap(a: Hotkey, b: Hotkey): boolean {
  return a.parsed.some((pa) => b.parsed.some((pb) => keysOverlap(pa, pb)));
}

/** Keycap labels for display: ["Alt", "8"]. */
export function keycaps(p: ParsedKey): string[] {
  const nice: Record<Modifier, string> = { ctrl: "Ctrl", alt: "Alt", shift: "Shift", windows: "Win" };
  const vk = p.vk.length === 1 ? p.vk : p.vk.charAt(0) + p.vk.slice(1).toLowerCase().replace(/_/g, " ");
  return [...p.required.map((m) => nice[m]), /^F\d+$/i.test(p.vk) ? p.vk.toUpperCase() : vk];
}

export function onlyWithoutModifiers(p: ParsedKey): boolean {
  return p.required.length === 0 && p.forbidden.length === 4;
}

export type ConflictSeverity = "conflict" | "overlap";

export interface HotkeyClash {
  severity: ConflictSeverity;
  skinId: string;
  hotkey: Hotkey;
  otherSkinId: string;
  otherEntityId: string;
  otherHotkey: Hotkey;
}

/** Entities that appear on screen together: a weapon with any character, an extra with its parent. */
export function appearTogether(a: Entity, b: Entity): boolean {
  const cats: Category[] = [a.category, b.category];
  if (cats.includes("weapon") && cats.includes("character")) return true;
  if (a.category === "extra" && a.parentId === b.id) return true;
  if (b.category === "extra" && b.parentId === a.id) return true;
  return false;
}

/**
 * All hotkey clashes between the given active skins (one per entity; pass the pending state).
 * Conflict = either key ungated, or the two entities appear together. Overlap note = both gated, different characters.
 */
export function computeClashes(activeSkins: Skin[], entities: Map<string, Entity>): HotkeyClash[] {
  const out: HotkeyClash[] = [];
  for (let i = 0; i < activeSkins.length; i++) {
    for (let j = 0; j < activeSkins.length; j++) {
      if (i === j) continue;
      const a = activeSkins[i];
      const b = activeSkins[j];
      if (a.entityId === b.entityId) continue;
      const ea = entities.get(a.entityId);
      const eb = entities.get(b.entityId);
      if (!ea || !eb) continue;
      for (const ha of a.hotkeys) {
        for (const hb of b.hotkeys) {
          if (!hotkeysOverlap(ha, hb)) continue;
          const severity: ConflictSeverity =
            !ha.gated || !hb.gated || appearTogether(ea, eb) ? "conflict" : "overlap";
          out.push({ severity, skinId: a.id, hotkey: ha, otherSkinId: b.id, otherEntityId: b.entityId, otherHotkey: hb });
        }
      }
    }
  }
  return out;
}
