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

/** Skins shown for an entity: NSFW ones only while revealed (SPEC §11). */
export function visibleSkins(s: Snapshot, entity: Entity, nsfwVisible: boolean): Skin[] {
  const ids = new Set(entity.skinIds);
  return s.library.skins.filter((k) => ids.has(k.id) && (nsfwVisible || !k.nsfw));
}

export interface EntityView {
  entity: Entity;
  /** visible skins, in library order */
  skins: Skin[];
  /** NSFW skins hidden right now */
  hidden: number;
  /** skins enabled on disk (more than one = the user must pick) */
  onDisk: string[];
  /** pending pick if any, else what is on disk; null = Original */
  effective: string | null;
  pending: boolean;
  effectiveSkin: Skin | null;
  /** effective skin is NSFW while hidden: show "Modded (hidden)" and a generic cover */
  effectiveHidden: boolean;
  subtitle: string;
}

export function entityView(s: Snapshot, picks: Picks, nsfwVisible: boolean, entity: Entity): EntityView {
  const all = s.library.skins.filter((k) => k.entityId === entity.id);
  const skins = all.filter((k) => nsfwVisible || !k.nsfw);
  const onDisk = s.disk.active[entity.id] ?? [];
  const pending = entity.id in picks;
  const effective = pending ? picks[entity.id] : (onDisk[0] ?? null);
  const effectiveSkin = effective ? (all.find((k) => k.id === effective) ?? null) : null;
  const effectiveHidden = !!effectiveSkin?.nsfw && !nsfwVisible;
  const subtitle = !all.length
    ? "Original · no skins yet"
    : !effectiveSkin
      ? "Original"
      : effectiveHidden
        ? "Modded (hidden)"
        : effectiveSkin.name;
  return {
    entity,
    skins,
    hidden: all.length - skins.length,
    onDisk,
    effective,
    pending,
    effectiveSkin,
    effectiveHidden,
    subtitle,
  };
}

export function fold(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Search across entity names, aliases, visible skin names and authors (SPEC §6, hidden NSFW never matches). */
export function matchesQuery(v: EntityView, query: string): boolean {
  const q = fold(query.trim());
  if (!q) return true;
  const hay = [v.entity.name, ...(v.entity.aliases ?? []), ...v.skins.flatMap((k) => [k.name, k.author ?? ""])];
  return hay.some((h) => fold(h).includes(q));
}

export type ChipFilter = "all" | Category | "modded";

export function matchesChip(v: EntityView, chip: ChipFilter): boolean {
  if (chip === "all") return true;
  if (chip === "modded") return v.effective !== null;
  return v.entity.category === chip;
}

export interface PendingItem {
  entityId: string;
  entityName: string;
  from: string;
  to: string;
}

/** "Arlecchino: Elegant → Magical" items for the pending bar. */
export function pendingItems(s: Snapshot, picks: Picks, nsfwVisible: boolean): PendingItem[] {
  const skins = skinMap(s);
  const label = (id: string | null) => {
    if (!id) return "Original";
    const k = skins.get(id);
    if (!k) return "?";
    return k.nsfw && !nsfwVisible ? "Modded (hidden)" : k.name;
  };
  return Object.entries(picks).map(([entityId, to]) => {
    const e = s.library.entities.find((x) => x.id === entityId);
    const onDisk = s.disk.active[entityId] ?? [];
    const from = onDisk.length > 1 ? `${onDisk.length} skins on` : label(onDisk[0] ?? null);
    return { entityId, entityName: e?.name ?? entityId, from, to: label(to) };
  });
}

/** Deterministic hue for monogram portraits. */
export function hueFor(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h % 360;
}

export function initials(name: string): string {
  const words = name.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w[0] ?? ""));
  const pick = words.length > 1 ? words.filter((w) => w[0] === w[0].toUpperCase()).slice(0, 2) : words;
  return (pick.length ? pick : words).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
}
