import { animate, useMotionValue, useTransform, motion } from "motion/react";
import { useEffect } from "react";
import { useReduced } from "../lib/useReduced";

/** Number tween for counts (§7 pending count, section header counts). */
export function AnimatedNumber({ value, className }: { value: number; className?: string }) {
  const reduced = useReduced();
  const mv = useMotionValue(value);
  const text = useTransform(mv, (v) => String(Math.round(v)));
  useEffect(() => {
    if (reduced) {
      mv.set(value);
      return;
    }
    const c = animate(mv, value, { type: "spring", stiffness: 260, damping: 30 });
    return () => c.stop();
  }, [value, reduced, mv]);
  return <motion.span className={`num ${className ?? ""}`}>{text}</motion.span>;
}
