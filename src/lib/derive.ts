// Pure helpers that derive view data from the snapshot + pending picks.
import type { Category, Entity, Picks, Skin, Snapshot } from "../api/types";

export const CATEGORY_ORDER: Category[] = ["character", "weapon", "extra"];
export const CATEGORY_LABEL: Record<Category, string> = {
  character: "Characters",
  weapon: "Weapons",
  extra: "Extras",
};

export function skinMap(s: Snapshot): Map<string, Skin> {
  return new Map(s.library.skins.map((k) => [k.id, k]));
}

export function entityMap(s: Snapshot): Map<string, Entity> {
  return new Map(s.library.entities.map((e) => [e.id, e]));
}

/** Skin active on disk right now (first one if, unusually, several are). */
export function diskActive(s: Snapshot, entityId: string): string | null {
  return s.disk.active[entityId]?.[0] ?? null;
}

/** Effective pick: pending choice if any, else what is on disk. null = Original. */
export function effectiveActive(s: Snapshot, picks: Picks, entityId: string): string | null {
  return entityId in picks ? picks[entityId] : diskActive(s, entityId);
}

export function sortEntities(list: Entity[]): Entity[] {
  return [...list].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}
