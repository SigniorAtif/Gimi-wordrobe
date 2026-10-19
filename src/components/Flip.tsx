import { animate, motion } from "motion/react";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { spring } from "../motion";

// Shared-element morphs across page transitions (SPEC §7: card -> A2 portrait, card cover -> A3 preview).
// The source records its rect just before navigating; the target animates from that rect on mount.
const rects = new Map<string, { rect: DOMRect; radius: number; at: number }>();

/** Remember where a shared element is right now (call right before navigating). */
export function rememberFlip(key: string, el: Element | null) {
  if (!el) return;
  const radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
  rects.set(key, { rect: el.getBoundingClientRect(), radius, at: performance.now() });
}

/** Remember the element currently carrying this flip key (the source page's copy). */
export function rememberFlipKey(key: string) {
  rememberFlip(key, document.querySelector(`[data-flip="${CSS.escape(key)}"]`));
}

export function Flip({
  flipKey,
  children,
  className,
  reduced,
  radius,
}: {
  flipKey: string;
  children: ReactNode;
  className?: string;
  reduced: boolean;
  /** this element's own corner radius, so the corners morph too */
  radius?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const src = rects.get(flipKey);
    const el = ref.current;
    if (!src || !el || reduced || performance.now() - src.at > 1500) return;
    // consume the rect shortly after (StrictMode runs this effect twice in development)
    setTimeout(() => rects.get(flipKey) === src && rects.delete(flipKey), 120);
    const dst = el.getBoundingClientRect();
    if (!dst.width || !dst.height) return;
    const sx = src.rect.width / dst.width;
    const sy = src.rect.height / dst.height;
    const x = src.rect.left - dst.left;
    const y = src.rect.top - dst.top;
    const r = radius ?? 0;
    const controls = animate(
      el,
      {
        x: [x, 0],
        y: [y, 0],
        scaleX: [sx, 1],
        scaleY: [sy, 1],
        // counter-scale the radius so corners look right while the box is stretched
        borderRadius: [`${src.radius / sx}px / ${src.radius / sy}px`, `${r}px`],
      },
      spring.gentle,
    );
    return () => controls.stop();
  }, [flipKey, reduced, radius]);
  return (
    <motion.div ref={ref} className={className} style={{ borderRadius: radius, transformOrigin: "0 0" }} data-flip={flipKey}>
      {children}
    </motion.div>
  );
}
