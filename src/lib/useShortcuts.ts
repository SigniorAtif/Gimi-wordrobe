import { useEffect } from "react";
import { rememberFlipKey } from "../components/Flip";
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
        const active = document.activeElement as HTMLElement | null;
        const focused = active?.closest<HTMLElement>("[data-skin]")?.dataset.skin;
        const snap = useApp.getState().snapshot;
        const navigate = useApp.getState().navigate;
        if (!snap) return;
        const openSkin = (id: string) => {
          rememberFlipKey(`skin:${id}`);
          navigate({ name: "skin", skinId: id });
        };
        // the pending pick wins, even a pending Original (null); hidden NSFW skins never open
        const effectiveVisible = (entityId: string): string | null => {
          const id = entityId in home.picks ? home.picks[entityId] : (snap.disk.active[entityId]?.[0] ?? null);
          const skin = id ? snap.library.skins.find((k) => k.id === id) : undefined;
          return skin && (home.nsfwVisible || !skin.nsfw) ? skin.id : null;
        };
        if (route.name === "home" && home.openShelf) {
          const target = focused && focused !== "original" ? focused : effectiveVisible(home.openShelf);
          if (!target) return;
          e.preventDefault();
          if (home.peek === target) home.setPeek(null);
          else if (window.innerWidth < 1100) openSkin(target);
          else home.setPeek(target);
        } else if (route.name === "home" && snap.settings.layout === "pages") {
          // A1: the focused character card opens its current skin's detail page
          const entityId = active?.closest<HTMLElement>("[data-entity]")?.dataset.entity;
          const target = entityId ? effectiveVisible(entityId) : null;
          if (!target) return;
          e.preventDefault();
          openSkin(target);
        } else if (route.name === "entity" && focused && focused !== "original") {
          e.preventDefault();
          openSkin(focused);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
