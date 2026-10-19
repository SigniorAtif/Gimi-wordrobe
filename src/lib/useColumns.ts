import { useSyncExternalStore } from "react";

/** Grid column count for the home grids: wide windows get `wide`, ~1000px windows get `narrow` (SPEC §6). */
export function useColumns(wide: number, narrow: number, breakpoint = 1180): number {
  const query = `(max-width: ${breakpoint - 1}px)`;
  const isNarrow = useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(query);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia(query).matches,
  );
  return isNarrow ? narrow : wide;
}
