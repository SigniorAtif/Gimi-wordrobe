// Arrow-key focus movement across cards (SPEC §12). Works from on-screen geometry, so it needs no column counts
// and handles the shelf strip under a row of cards, A2's grid and both layouts alike.

export type Direction = "left" | "right" | "up" | "down";

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export const ARROWS: Record<string, Direction> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };

/** How far `p` lies outside the span [start, start + size] (0 inside it). */
const outside = (p: number, start: number, size: number) => Math.max(0, start - p, p - (start + size));

/**
 * Index of the box to move to from `from`, or -1. A candidate must lie in the arrow's direction; the nearest wins,
 * with sideways distance weighted so Down prefers the card straight below over a closer diagonal one. Sideways
 * distance is measured to the candidate's edge, not its centre, so a wide shelf strip under the row counts as below.
 */
export function nextBox(from: Box, boxes: Box[], dir: Direction): number {
  const cx = from.left + from.width / 2;
  const cy = from.top + from.height / 2;
  let best = -1;
  let bestScore = Infinity;
  boxes.forEach((b, i) => {
    const bx = b.left + b.width / 2;
    const by = b.top + b.height / 2;
    const dx = bx - cx;
    const dy = by - cy;
    const horizontal = dir === "left" || dir === "right";
    const along = dir === "right" ? dx : dir === "left" ? -dx : dir === "down" ? dy : -dy;
    const across = horizontal ? outside(cy, b.top, b.height) : outside(cx, b.left, b.width);
    // must actually move that way; a sideways neighbour in the same row isn't "down"
    if (along <= 1) return;
    if (horizontal && across > Math.max(from.height, b.height) / 2) return;
    const score = along + across * 3;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
}
