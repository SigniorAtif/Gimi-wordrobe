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
        home.closeShelf();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
