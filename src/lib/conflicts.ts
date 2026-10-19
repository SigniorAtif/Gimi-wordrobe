// Hotkey clashes against the pending state (SPEC §8: conflicts show before Apply and disappear once resolved).
import { useMemo } from "react";
import type { Picks, Skin, Snapshot } from "../api/types";
import { useApp } from "../store/app";
import { useHome } from "../store/home";
import { computeClashes, type HotkeyClash } from "./hotkeys";

/** The skins that will be enabled after Apply: the pick per entity, else what's on disk now. */
export function effectiveSkins(s: Snapshot, picks: Picks, nsfwVisible = true): Skin[] {
  const out: Skin[] = [];
  for (const e of s.library.entities) {
    const ids = e.id in picks ? (picks[e.id] ? [picks[e.id] as string] : []) : (s.disk.active[e.id] ?? []);
    for (const id of ids) {
      const k = s.library.skins.find((x) => x.id === id);
      if (k && (nsfwVisible || !k.nsfw)) out.push(k);
    }
  }
  return out;
}

export interface Clashes {
  /** skinId -> clashes of that skin's keys */
  bySkin: Map<string, HotkeyClash[]>;
  /** entities with at least one red conflict */
  conflictEntities: Set<string>;
}

export function clashesFor(s: Snapshot, picks: Picks, nsfwVisible = true): Clashes {
  const skins = effectiveSkins(s, picks, nsfwVisible);
  const entities = new Map(s.library.entities.map((e) => [e.id, e]));
  const all = computeClashes(skins, entities);
  const bySkin = new Map<string, HotkeyClash[]>();
  const conflictEntities = new Set<string>();
  for (const c of all) {
    (bySkin.get(c.skinId) ?? bySkin.set(c.skinId, []).get(c.skinId)!).push(c);
    if (c.severity === "conflict") {
      const e = s.library.skins.find((k) => k.id === c.skinId)?.entityId;
      if (e) conflictEntities.add(e);
    }
  }
  return { bySkin, conflictEntities };
}

/** Clashes for a skin that isn't (or may not be) enabled yet: as if it were picked. */
export function clashesIfPicked(s: Snapshot, picks: Picks, skin: Skin, nsfwVisible = true): HotkeyClash[] {
  const next = { ...picks, [skin.entityId]: skin.id };
  return clashesFor(s, next, nsfwVisible).bySkin.get(skin.id) ?? [];
}

export function useClashes(): Clashes {
  const snapshot = useApp((st) => st.snapshot);
  const picks = useHome((st) => st.picks);
  const nsfwVisible = useHome((st) => st.nsfwVisible);
  return useMemo(
    () => (snapshot ? clashesFor(snapshot, picks, nsfwVisible) : { bySkin: new Map(), conflictEntities: new Set<string>() }),
    [snapshot, picks, nsfwVisible],
  );
}
