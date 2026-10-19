import { motion } from "motion/react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { spring, tween } from "../motion";

/** Animates its height to fit its content whenever the content changes size (shelf <-> C3 peek, SPEC §7). */
export function AutoHeight({ children, reduced, className }: { children: ReactNode; reduced: boolean; className?: string }) {
  const inner = useRef<HTMLDivElement>(null);
  const [h, setH] = useState<number | "auto">("auto");
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setH(el.offsetHeight));
    ro.observe(el);
    setH(el.offsetHeight);
    return () => ro.disconnect();
  }, []);
  return (
    <motion.div
      className={className}
      style={{ overflow: "hidden" }}
      initial={false}
      animate={{ height: h }}
      transition={reduced ? { duration: 0 } : { ...spring.smooth, opacity: tween.small }}
    >
      <div ref={inner}>{children}</div>
    </motion.div>
  );
}
