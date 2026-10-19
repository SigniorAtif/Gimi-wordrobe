// Draft state behind the add dialogs (A4 modal, C4 popover) and the request it turns into (SPEC §6, §9).
import type { AddSkinRequest, AddTarget, ArchiveRoot, ArchiveSummary, Category, Entity, PreviewChoice } from "../api/types";

export type EntityChoice =
  | { kind: "existing"; id: string }
  | { kind: "new"; name: string; category: Category; portraitPath?: string }
  | { kind: "none" };

export interface RootDraft {
  /** unticked roots are left out of the add entirely */
  include: boolean;
  /** split out as its own skin (its own entity), instead of staying inside the main skin */
  own: boolean;
  entity: EntityChoice;
  /** empty = the default split name */
  skinName: string;
}

export interface AddDraft {
  entity: EntityChoice;
  skinName: string;
  gbUrl: string;
  nsfw: boolean;
  preview: PreviewChoice;
  userImage: string | null;
  makeActive: boolean;
  /** one per archive root; [0] is the main skin and always included */
  roots: RootDraft[];
}

export const GB_URL = /^https?:\/\/(www\.)?gamebanana\.com\/mods\/(\d+)/i;

export function isGameBananaUrl(url: string): boolean {
  return GB_URL.test(url.trim());
}

/** The detected entity of a root, matched to the library when possible. */
export function guessChoice(root: ArchiveRoot | undefined, entities: Entity[]): EntityChoice {
  const g = root?.guess;
  if (!g) return { kind: "none" };
  if (g.entityId && entities.some((e) => e.id === g.entityId)) return { kind: "existing", id: g.entityId };
  const byName = entities.find((e) => e.name.toLowerCase() === g.name.toLowerCase());
  if (byName) return { kind: "existing", id: byName.id };
  return { kind: "new", name: g.name, category: g.category };
}

export function sameChoice(a: EntityChoice, b: EntityChoice): boolean {
  if (a.kind === "existing" && b.kind === "existing") return a.id === b.id;
  if (a.kind === "new" && b.kind === "new") return a.name.trim().toLowerCase() === b.name.trim().toLowerCase();
  return a.kind === "none" && b.kind === "none";
}

export function choiceName(c: EntityChoice, entities: Entity[]): string {
  if (c.kind === "existing") return entities.find((e) => e.id === c.id)?.name ?? "?";
  if (c.kind === "new") return c.name.trim();
  return "";
}

/** "Archive root" for the top level, else the root's folder inside the archive. */
export function rootLabel(root: ArchiveRoot, summary: ArchiveSummary): string {
  return root.path || summary.wrapper?.replace(/\/$/, "") || "Archive root";
}

export function initialDraft(
  summary: ArchiveSummary,
  opts: { entityId: string | null; newCategory: Category | null; entities: Entity[]; makeActive: boolean },
): AddDraft {
  const { entities } = opts;
  const detected = guessChoice(summary.roots[0], entities);
  // a card the archive was dropped on (or the open A2 page) wins over detection
  const entity: EntityChoice =
    opts.entityId && entities.some((e) => e.id === opts.entityId)
      ? { kind: "existing", id: opts.entityId }
      : opts.newCategory
        ? { kind: "new", name: detected.kind === "new" ? detected.name : "", category: opts.newCategory }
        : detected;
  const roots = summary.roots.map((r, i): RootDraft => {
    if (i === 0) return { include: true, own: false, entity, skinName: "" };
    const g = guessChoice(r, entities);
    // nested mods (Bennett's sword, Oz) and mods for another entity become their own skins by default
    const own = r.nested || (g.kind !== "none" && !sameChoice(g, detected));
    return { include: true, own, entity: g, skinName: "" };
  });
  return {
    entity,
    skinName: summary.suggestedName,
    gbUrl: "",
    nsfw: summary.nsfwGuess,
    preview: summary.images.length ? "archive" : "later",
    userImage: null,
    makeActive: opts.makeActive,
    roots,
  };
}

/** Default name for a split-out skin: "Bennett Beach Day" for the sword out of Bennett's "Beach Day". */
export function defaultSplitName(draft: AddDraft, entities: Entity[]): string {
  return [choiceName(draft.entity, entities), draft.skinName.trim()].filter(Boolean).join(" ") || "Skin";
}

function target(c: EntityChoice, skinName: string): AddTarget | null {
  if (c.kind === "existing") return { entityId: c.id, skinName };
  if (c.kind === "new" && c.name.trim()) {
    return { newEntity: { name: c.name.trim(), category: c.category, portraitPath: c.portraitPath }, skinName };
  }
  return null;
}

export interface DraftCheck {
  request: AddSkinRequest | null;
  /** first problem per field, shown inline and as the Add button's tooltip */
  errors: Partial<Record<"archive" | "entity" | "skinName" | "gbUrl" | "preview" | "roots", string>>;
}

export function checkDraft(draft: AddDraft, summary: ArchiveSummary, entities: Entity[]): DraftCheck {
  const errors: DraftCheck["errors"] = {};
  if (!summary.roots.length) errors.archive = "No mod (.ini file) in this archive.";
  const skinName = draft.skinName.trim();
  if (!skinName) errors.skinName = "Give the skin a name.";
  const main = target(draft.entity, skinName);
  if (!main) errors.entity = draft.entity.kind === "new" ? "Name the new entry." : "Pick a character, weapon or extra.";
  const gb = draft.gbUrl.trim();
  if (gb && !isGameBananaUrl(gb)) errors.gbUrl = "That isn't a GameBanana mod link (gamebanana.com/mods/…).";
  if (draft.preview === "user" && !draft.userImage) errors.preview = "Choose an image, or pick another preview source.";
  if (draft.preview === "gamebanana" && !isGameBananaUrl(gb)) errors.preview = "Paste a GameBanana link first.";
  const splitName = defaultSplitName(draft, entities);
  const splits: AddSkinRequest["splits"] = [];
  draft.roots.forEach((r, i) => {
    const root = summary.roots[i];
    if (i === 0 || !root || !r.include || !r.own) return;
    const t = target(r.entity, r.skinName.trim() || splitName);
    if (!t) errors.roots ??= `Pick where ${rootLabel(root, summary)} goes.`;
    else splits.push({ ...t, rootPath: root.path });
  });
  const exclude = draft.roots.flatMap((r, i) => (i > 0 && !r.include && summary.roots[i] ? [summary.roots[i].path] : []));
  if (Object.keys(errors).length || !main) return { request: null, errors };
  return {
    errors,
    request: {
      archivePath: summary.path,
      main,
      splits,
      exclude,
      nsfw: draft.nsfw,
      gameBananaUrl: gb || undefined,
      previewSource: draft.preview,
      userImagePath: draft.preview === "user" ? (draft.userImage ?? undefined) : undefined,
      makeActive: draft.makeActive,
    },
  };
}
