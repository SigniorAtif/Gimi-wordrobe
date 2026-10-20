// NSFW helpers (SPEC §11): keep hidden skins out of free text, and the idle timer behind auto re-hide.
import type { Snapshot } from "../api/types";

/** Auto re-hide after this long without input (SPEC §6 Settings). */
export const IDLE_MS = 5 * 60_000;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Replace the names and folders of hidden NSFW skins in a message (toasts, errors from the backend), so an Apply
 * error like "Couldn't move Varesa\CowGirl" doesn't give a hidden skin away. Over-redacting is the safe direction.
 */
export function redactHidden(text: string, snap: Snapshot | null, nsfwVisible: boolean): string {
  if (nsfwVisible || !snap || !text) return text;
  const terms = new Set<string>();
  for (const k of snap.library.skins) {
    if (!k.nsfw) continue;
    if (k.name.trim().length >= 3) terms.add(k.name.trim());
    for (const f of k.folders) {
      const parts = f.split(/[\\/]/).filter(Boolean);
      if (!parts.length) continue;
      // both separators: Windows messages use backslashes, library paths use slashes
      terms.add(parts.join("/"));
      terms.add(parts.join("\\"));
      const last = parts[parts.length - 1].replace(/^DISABLED_?/i, "");
      if (last.length >= 3) terms.add(last);
    }
  }
  if (!terms.size) return text;
  const pattern = [...terms].sort((a, b) => b.length - a.length).map(escape).join("|");
  return text.replace(new RegExp(pattern, "gi"), "a hidden skin");
}

/** Calls `onIdle` once after `ms` without `bump()`; `stop()` cancels. Plain timers, so it's testable without React. */
export function createIdleTimer(onIdle: () => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | null = setTimeout(onIdle, ms);
  return {
    bump() {
      if (timer === null) return;
      clearTimeout(timer);
      timer = setTimeout(onIdle, ms);
    },
    stop() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
