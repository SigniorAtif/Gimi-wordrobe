import { useEffect } from "react";
import { useApp } from "../store/app";
import { useHome } from "../store/home";

function typing(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
}

/** App-wide keyboard shortcuts (SPEC §12). Only while the window is focused; there is no global hook. */
export function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const home = useHome.getState();
      const route = useApp.getState().route;
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void home.apply();
        return;
      }
      if (ctrl && e.key.toLowerCase() === "z" && !typing(e.target)) {
        e.preventDefault();
        home.undo();
        return;
      }
      if (e.key === "Escape" && route.name === "home" && home.openShelf && !typing(e.target)) {
        e.preventDefault();
        if (home.peek) home.setPeek(null);
        else home.closeShelf();
        return;
      }
      if (e.key.toLowerCase() === "i" && !ctrl && !e.altKey && !typing(e.target)) {
        // quick peek (Shelves) / open A3 (Pages): the focused skin card, else the shelf's active skin
        const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-skin]")?.dataset.skin;
        const snap = useApp.getState().snapshot;
        const navigate = useApp.getState().navigate;
        if (route.name === "home" && home.openShelf && snap) {
          const fallback = home.picks[home.openShelf] ?? snap.disk.active[home.openShelf]?.[0] ?? null;
          const target = focused && focused !== "original" ? focused : fallback;
          if (!target) return;
          e.preventDefault();
          if (home.peek === target) home.setPeek(null);
          else if (window.innerWidth < 1100) {
            home.setMorph({ skin: target });
            navigate({ name: "skin", skinId: target });
          } else home.setPeek(target);
        } else if (route.name === "entity" && focused && focused !== "original") {
          e.preventDefault();
          home.setMorph({ skin: focused });
          navigate({ name: "skin", skinId: focused });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
