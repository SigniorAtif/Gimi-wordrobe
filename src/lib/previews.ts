// Preview helpers (SPEC §10): toast text for preview results and failures, the gallery caption, reordering and
// GameBanana names. Pure, so they're testable without a DOM.
import type { Preview, PreviewFetchResult } from "../api/types";

export interface ToastSpec {
  kind: "success" | "error" | "info";
  text: string;
  detail?: string;
}

export type PreviewAction = "fetch" | "add" | "paste" | "find" | "remove" | "reorder";

const ACTION_FAILED: Record<PreviewAction, string> = {
  fetch: "Couldn't get the previews from GameBanana.",
  add: "Couldn't add the image.",
  paste: "Couldn't paste the image.",
  find: "Couldn't look for previews in the mod folder.",
  remove: "Couldn't remove the image.",
  reorder: "Couldn't change the order.",
};

/** Error codes after which "Retry" can help (a full skin or a missing link can't be retried away). */
const RETRYABLE = new Set(["network", "gamebanana", "link_changed", "not_an_image", "error"]);

export function canRetry(code: string | undefined): boolean {
  return !!code && RETRYABLE.has(code);
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What to tell the user when a preview call fails. The backend's message becomes the detail where it adds something. */
export function previewFailureToast(code: string, message: string, action: PreviewAction): ToastSpec {
  const msg = message.trim();
  switch (code) {
    case "duplicate":
      return { kind: "info", text: "That image is already one of this skin's previews." };
    case "not_an_image":
      return {
        kind: "error",
        text: action === "fetch" ? ACTION_FAILED.fetch : "That isn't an image the app can use.",
        detail: msg || "Use a PNG, JPG or WebP image of up to 25 MB.",
      };
    case "too_many":
      return { kind: "info", text: "No room for more previews.", detail: msg || "A skin keeps up to 30 previews. Remove one first." };
    case "link_changed":
      return { kind: "info", text: "The GameBanana link changed during the download, so those images weren't kept.", detail: "Retry to get the images from the new link." };
    case "network":
      return { kind: action === "fetch" ? "info" : "error", text: "Couldn't reach GameBanana.", detail: "Check the connection, then retry." };
    case "gamebanana":
      return { kind: "info", text: "GameBanana didn't give the previews.", detail: msg || undefined };
    case "no_link":
      return { kind: "info", text: "Add the skin's GameBanana link first." };
    case "bad_link":
      return { kind: "info", text: "That isn't a GameBanana mod link (gamebanana.com/mods/…)." };
    case "unknown_preview":
      return { kind: "info", text: "That image was already removed." };
    case "unknown_skin":
      return { kind: "error", text: "That skin no longer exists." };
    default:
      return { kind: "error", text: ACTION_FAILED[action], detail: msg || undefined };
  }
}

/**
 * Toasts after a GameBanana fetch that worked. New images show up on the card by themselves, so plain success says
 * nothing; an 18+ rating, images that failed, or nothing new does.
 */
export function fetchResultToasts(
  r: Pick<PreviewFetchResult, "added" | "failed" | "markedNsfw">,
  ctx: { name: string; hiddenNow: boolean; hotkey: string },
): ToastSpec[] {
  const out: ToastSpec[] = [];
  if (r.markedNsfw) {
    out.push({
      kind: "info",
      text: "Marked 18+ because GameBanana rates it.",
      detail: ctx.hiddenNow ? `It's hidden now. Press ${ctx.hotkey} to show 18+ skins.` : undefined,
    });
  }
  if (r.failed > 0) {
    out.push({
      kind: "info",
      text: `${plural(r.failed, "GameBanana image")} couldn't be downloaded.`,
      detail: r.added > 0 ? `The other ${plural(r.added, "image")} ${r.added === 1 ? "was" : "were"} added.` : undefined,
    });
  } else if (r.added === 0) {
    out.push({ kind: "info", text: `GameBanana had no new previews for ${ctx.name}.` });
  }
  return out;
}

/** "3 from GameBanana · 2 from archive · 1 added by you"; "" when there are none. */
export function sourceCaption(previews: Pick<Preview, "source">[]): string {
  const n = (src: Preview["source"]) => previews.filter((p) => p.source === src).length;
  return [
    n("gamebanana") && `${n("gamebanana")} from GameBanana`,
    n("archive") && `${n("archive")} from archive`,
    n("user") && `${n("user")} added by you`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** `list` with the item at `from` moved to `to` (both clamped). */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list];
  if (from < 0 || from >= out.length) return out;
  const [item] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(to, out.length)), 0, item);
  return out;
}

export function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * The files in display order: a local order (mid-drag, or waiting for the backend) first, then any file it doesn't
 * know yet, so an image that arrives during a drag still shows.
 */
export function orderedPreviews<P extends Pick<Preview, "file">>(previews: readonly P[], local: readonly string[] | null): P[] {
  if (!local) return [...previews];
  const byFile = new Map(previews.map((p) => [p.file, p]));
  const known = local.flatMap((f) => byFile.get(f) ?? []);
  const seen = new Set(local);
  return [...known, ...previews.filter((p) => !seen.has(p.file))];
}

/** Grid slot under a point: the slot that contains it, else the nearest one (slots in layout coordinates). */
export function slotAt(slots: readonly { x: number; y: number; w: number; h: number }[], px: number, py: number): number {
  let best = -1;
  let bestD = Infinity;
  slots.forEach((s, i) => {
    const dx = px < s.x ? s.x - px : px > s.x + s.w ? px - s.x - s.w : 0;
    const dy = py < s.y ? s.y - py : py > s.y + s.h ? py - s.y - s.h : 0;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      best = i;
      bestD = d;
    }
  });
  return best;
}

export function isImagePath(path: string): boolean {
  return /\.(png|jpe?g|webp)$/i.test(path.trim());
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A skin name from a GameBanana mod title: the entity's name and the separators around it are dropped
 * ("Furina - Remembrance" -> "Remembrance"), unless nothing would be left.
 */
export function gameBananaSkinName(title: string, entityName: string): string {
  const clean = title.replace(/\s+/g, " ").trim();
  const who = entityName.trim();
  if (!who) return clean;
  const stripped = clean
    .replace(new RegExp(`(^|[^\\p{L}\\p{N}])${escape(who)}(?:['’]s)?(?![\\p{L}\\p{N}])`, "iu"), "$1")
    .replace(/^[\s\-–|:_,]+|[\s\-–|:_,]+$/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  return stripped || clean;
}
