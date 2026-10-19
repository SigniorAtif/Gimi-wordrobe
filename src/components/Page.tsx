import { motion, type Variants } from "motion/react";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { spring, tween } from "../motion";
import { useReduced } from "../lib/useReduced";
import { useApp } from "../store/app";

export type PageKind = "home" | "entity" | "skin" | "settings" | "setup";

/**
 * One routed screen. Pages overlap during transitions (AnimatePresence "sync" mode) so shared
 * layoutId elements can morph between them. Each page owns its scroll and restores it on return.
 */
export function Page({ id, kind, children }: { id: string; kind: PageKind; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useReduced();
  const dir = useApp((s) => s.navDir);
  const remember = useApp((s) => s.rememberScroll);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const top = useApp.getState().scrollMemory[id] ?? 0;
    el.scrollTop = top;
    return () => remember(id, el.scrollTop);
  }, [id, remember]);

  return (
    <motion.div
      ref={ref}
      layoutScroll
      className={`page page--${kind}`}
      data-page={kind}
      custom={{ dir, reduced }}
      variants={pageVariants(kind)}
      initial="enter"
      animate="center"
      exit="exit"
    >
      {children}
    </motion.div>
  );
}

type Custom = { dir: 1 | -1; reduced: boolean };

function pageVariants(kind: PageKind): Variants {
  // Home recedes slightly behind detail pages; detail pages fade in over it (§7 Home <-> A2).
  if (kind === "home") {
    return {
      enter: ({ reduced }: Custom) => (reduced ? { opacity: 0 } : { opacity: 0, scale: 0.985 }),
      center: { opacity: 1, scale: 1, transition: { ...spring.gentle, opacity: tween.medium } },
      exit: ({ reduced }: Custom) =>
        reduced ? { opacity: 0, transition: tween.small } : { opacity: 0, scale: 0.97, transition: tween.medium },
    };
  }
  if (kind === "settings" || kind === "setup") {
    return {
      enter: ({ reduced }: Custom) => (reduced ? { opacity: 0 } : { opacity: 0, y: 12 }),
      center: { opacity: 1, y: 0, transition: { ...spring.gentle, opacity: tween.medium } },
      exit: ({ reduced }: Custom) => (reduced ? { opacity: 0, transition: tween.small } : { opacity: 0, y: 8, transition: tween.small }),
    };
  }
  return {
    enter: ({ dir, reduced }: Custom) => (reduced ? { opacity: 0 } : { opacity: 0, x: dir * 16 }),
    center: { opacity: 1, x: 0, transition: { ...spring.gentle, opacity: tween.medium } },
    exit: ({ dir, reduced }: Custom) =>
      reduced ? { opacity: 0, transition: tween.small } : { opacity: 0, x: dir * -12, transition: tween.small },
  };
}
