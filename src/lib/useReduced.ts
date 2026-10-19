import { useReducedMotion } from "motion/react";
import { useApp } from "../store/app";

/** Reduced motion = system preference, overridden by Settings › Appearance (§7). */
export function useReduced(): boolean {
  const system = useReducedMotion();
  const pref = useApp((s) => s.snapshot?.settings.reduceMotion ?? "system");
  if (pref === "on") return true;
  if (pref === "off") return false;
  return !!system;
}

/** MotionConfig value: "always" strips transform/layout animation but keeps opacity (crossfades only). */
export function useMotionConfigMode(): "always" | "never" | "user" {
  const pref = useApp((s) => s.snapshot?.settings.reduceMotion ?? "system");
  return pref === "on" ? "always" : pref === "off" ? "never" : "user";
}
