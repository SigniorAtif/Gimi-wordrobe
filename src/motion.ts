// Motion tokens (SPEC §7). Every animation in the app pulls from here.
import type { TargetAndTransition, Transition, Variants } from "motion/react";

export const spring = {
  /** small UI: chips, dots, tags, buttons */
  snappy: { type: "spring", stiffness: 500, damping: 38, mass: 1 },
  /** layout and shelves */
  smooth: { type: "spring", stiffness: 260, damping: 30, mass: 1 },
  /** page-level moves and shared elements */
  gentle: { type: "spring", stiffness: 170, damping: 26, mass: 1 },
  /** radio fills: one small overshoot (damping ratio about 0.7), never a bounce */
  pop: { type: "spring", stiffness: 520, damping: 32, mass: 1 },
} as const satisfies Record<string, Transition>;

export const duration = {
  micro: 0.12,
  small: 0.2,
  medium: 0.32,
  page: 0.45,
} as const;

export const easeOut = [0.22, 1, 0.36, 1] as const;

export const tween = {
  micro: { duration: duration.micro, ease: easeOut },
  small: { duration: duration.small, ease: easeOut },
  medium: { duration: duration.medium, ease: easeOut },
  page: { duration: duration.page, ease: easeOut },
  /** ambient art glow crossfade (symmetric, so old and new colours overlap evenly) */
  glow: { duration: duration.page, ease: [0.65, 0, 0.35, 1] },
} as const satisfies Record<string, Transition>;

/** Per-item stagger: 25-35ms, capped so a whole grid finishes within 400ms. */
export function staggerFor(count: number, perItem = 0.03, cap = 0.4): number {
  if (count <= 1) return 0;
  return Math.min(perItem, cap / count);
}

/** Delay for item `i` of `count` when items animate individually (not via variants). */
export function staggerDelay(i: number, count: number, reduced: boolean, perItem = 0.03): number {
  if (reduced) return 0;
  return i * staggerFor(count, perItem);
}

/** Grid item entrance: fade + 8px rise + scale 0.98 -> 1. Reduced motion = fade only. */
export function riseIn(reduced: boolean): Variants {
  return reduced
    ? { hidden: { opacity: 0 }, show: { opacity: 1, transition: tween.small } }
    : {
        hidden: { opacity: 0, y: 8, scale: 0.98 },
        show: { opacity: 1, y: 0, scale: 1, transition: spring.smooth },
      };
}

export function staggerContainer(count: number, reduced: boolean, delayChildren = 0): Variants {
  return {
    hidden: {},
    show: {
      transition: {
        staggerChildren: reduced ? 0 : staggerFor(count),
        delayChildren: reduced ? 0 : delayChildren,
      },
    },
  };
}

/** Hover lift and press for cards (§7 "Hover / press"). */
export const cardHover = { y: -2, transition: tween.micro } as const;
export const cardPress = { scale: 0.98, transition: tween.micro } as const;

/** How long hiding 18+ skins takes (§7 "NSFW reveal": hide reverses quickly). */
export const NSFW_HIDE_S = 0.15;

/** Exit for an 18+ card when 18+ skins hide: the reveal in reverse, in 150ms. Reduced motion = fade only. */
export function nsfwHide(reduced: boolean): TargetAndTransition {
  const transition = { duration: NSFW_HIDE_S, ease: easeOut };
  return reduced ? { opacity: 0, transition } : { opacity: 0, filter: "blur(8px)", transition };
}

/**
 * NSFW reveal (§7): a revealed card fades in from blur(8px) -> 0, staggered by `i`, its index among the revealed
 * cards; hiding reverses quickly. Reduced motion = a crossfade with no stagger. Spread the result onto a motion element.
 */
export function nsfwReveal(reduced: boolean, i = 0): { initial: TargetAndTransition; animate: TargetAndTransition; exit: TargetAndTransition } {
  return reduced
    ? { initial: { opacity: 0 }, animate: { opacity: 1, transition: tween.small }, exit: nsfwHide(true) }
    : {
        initial: { opacity: 0, filter: "blur(8px)" },
        // no filter left behind once sharp, so the card renders exactly as before
        animate: { opacity: 1, filter: "blur(0px)", transition: { ...tween.medium, delay: Math.min(i * 0.035, 0.3) }, transitionEnd: { filter: "none" } },
        exit: nsfwHide(false),
      };
}

/** Error toasts and a wrong PIN shake once, small (4px). */
export const shake = {
  x: [0, -4, 4, -3, 3, 0],
  transition: { duration: 0.36, ease: "easeInOut" },
} as const;
