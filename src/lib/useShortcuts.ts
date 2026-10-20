import { useEffect } from "react";
import { rememberFlipKey } from "../components/Flip";
import { useApp } from "../store/app";
import { useHome } from "../store/home";
import { resolveShortcut, type ShortcutAction } from "./shortcuts";
import { nextBox, type Direction } from "./spatial";

/** Cards the arrow keys move between carry this attribute: entity cards, skin cards, the hidden stub, drop cards. */
export const NAV = "data-nav";

function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}

/** An open dialog or menu owns the keyboard while it is up. */
function overlayOpen(): boolean {
  return !!document.querySelector('[aria-modal="true"], .popover');
}

/** The current screen's root. While pages cross-fade the outgoing one is still mounted; the newest comes last. */
function currentPage(): HTMLElement | null {
  const pages = document.querySelectorAll<HTMLElement>(`[data-page="${useApp.getState().route.name}"]`);
  return pages[pages.length - 1] ?? null;
}

function navCards(page: HTMLElement): HTMLElement[] {
  return [...page.querySelectorAll<HTMLElement>(`[${NAV}]`)].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && !(el as HTMLButtonElement).disabled;
  });
}

function focusedCard(): HTMLElement | null {
  const el = document.activeElement as HTMLElement | null;
  return el?.closest<HTMLElement>(`[${NAV}]`) ?? null;
}

/** Settings › Reduce motion, else the system preference (the same rule as useReduced, outside React). */
function reducedMotion(): boolean {
  const pref = useApp.getState().snapshot?.settings.reduceMotion ?? "system";
  return pref === "on" || (pref === "system" && matchMedia("(prefers-reduced-motion: reduce)").matches);
}

/** Focus a card and glide it into view (a plain focus() would jump the scroll). */
function focusCard(el: HTMLElement) {
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
}

/** Focus what `selector` finds once it has mounted (after a shelf, peek or page change). */
function focusSoon(selector: string, tries = 20) {
  const el = currentPage()?.querySelector<HTMLElement>(selector);
  if (el) focusCard(el);
  else if (tries > 0) requestAnimationFrame(() => focusSoon(selector, tries - 1));
}

/** The skin a focused card stands for ("original" for the Original card), and the entity it belongs to. */
function skinOf(card: HTMLElement): { skinId: string; entityId: string | null } | null {
  const skinId = card.closest<HTMLElement>("[data-skin]")?.dataset.skin;
  if (!skinId) return null;
  const route = useApp.getState().route;
  const entityId = card.closest<HTMLElement>("[data-shelf]")?.dataset.shelf ?? (route.name === "entity" ? route.entityId : null);
  return { skinId, entityId };
}

function openEntityPage(entityId: string) {
  useHome.getState().setMorph({ entity: entityId });
  rememberFlipKey(`entity:${entityId}`);
  useApp.getState().navigate({ name: "entity", entityId });
}

function openSkinPage(skinId: string) {
  rememberFlipKey(`skin:${skinId}`);
  useApp.getState().navigate({ name: "skin", skinId });
}

/** The skin an entity shows now (the pending pick wins, even a pending Original); hidden 18+ skins never count. */
function shownSkin(entityId: string): string | null {
  const snap = useApp.getState().snapshot;
  const home = useHome.getState();
  if (!snap) return null;
  const id = entityId in home.picks ? home.picks[entityId] : (snap.disk.active[entityId]?.[0] ?? null);
  const skin = id ? snap.library.skins.find((k) => k.id === id) : undefined;
  return skin && (home.nsfwVisible || !skin.nsfw) ? skin.id : null;
}

/** Arrow keys: move focus to the nearest card that way, by on-screen geometry (spatial.ts). */
function move(dir: Direction): boolean {
  const page = currentPage();
  if (!page) return false;
  const cards = navCards(page);
  if (!cards.length) return false;
  const from = focusedCard();
  if (!from || !cards.includes(from)) {
    // nothing focused yet: start at the open shelf's selected skin, else the first card on screen
    const start =
      cards.find((c) => c.closest("[data-shelf]") && c.getAttribute("aria-checked") === "true") ??
      cards.find((c) => {
        const r = c.getBoundingClientRect();
        return r.bottom > 0 && r.top < window.innerHeight;
      }) ??
      cards[0];
    focusCard(start);
    return true;
  }
  const others = cards.filter((c) => c !== from);
  const i = nextBox(from.getBoundingClientRect(), others.map((c) => c.getBoundingClientRect()), dir);
  if (i >= 0) focusCard(others[i]);
  // at an edge the key still belongs to the grid, so the page doesn't scroll instead
  return true;
}

/** Enter: Shelves opens the focused card's shelf, then A2 on a second press; Pages opens A2; on A2 a skin opens A3. */
function open(): boolean {
  const card = focusedCard();
  if (!card) return false;
  const route = useApp.getState().route;
  const home = useHome.getState();
  const entityId = card.dataset.entity;
  if (route.name === "home" && entityId) {
    const shelves = useApp.getState().snapshot?.settings.layout !== "pages";
    if (shelves && home.openShelf !== entityId) home.toggleShelf(entityId);
    else openEntityPage(entityId);
    return true;
  }
  const skin = skinOf(card);
  if (!skin || skin.skinId === "original") return false; // the Original card, stubs and drop cards click as usual
  if (route.name === "home" && skin.entityId) openEntityPage(skin.entityId);
  else if (route.name === "entity") openSkinPage(skin.skinId);
  else return false;
  return true;
}

/** Space: pick the focused skin card (a click does exactly that, and in C3 also shows it). */
function pick(): boolean {
  const card = focusedCard();
  if (!card || !skinOf(card)) return false;
  card.click();
  return true;
}

/** I: quick peek at the focused skin (Shelves, below 1100px A3), or A3 (Pages). Falls back to the shown skin. */
function peek(): boolean {
  const route = useApp.getState().route;
  const home = useHome.getState();
  const card = focusedCard();
  const skin = card ? skinOf(card) : null;
  const focused = skin && skin.skinId !== "original" ? skin.skinId : null;
  if (route.name === "home" && home.openShelf) {
    const target = focused ?? shownSkin(home.openShelf);
    if (!target) return false;
    if (home.peek === target) {
      home.setPeek(null);
      focusSoon(`[data-shelf] .skincard[data-skin="${CSS.escape(target)}"] [${NAV}]`);
    } else if (window.innerWidth < 1100) openSkinPage(target);
    else {
      home.setPeek(target);
      focusSoon(`[data-shelf] .peek [data-skin="${CSS.escape(target)}"]`);
    }
    return true;
  }
  if (route.name === "home") {
    // A1 (or a closed shelf): the focused card's current skin
    const entityId = card?.dataset.entity;
    const target = entityId ? shownSkin(entityId) : null;
    if (!target) return false;
    openSkinPage(target);
    return true;
  }
  if (route.name === "entity" && focused) {
    openSkinPage(focused);
    return true;
  }
  return false;
}

/** Esc / Backspace: close the peek, then the shelf; on other pages go back. */
function back(): boolean {
  const app = useApp.getState();
  const home = useHome.getState();
  const route = app.route;
  switch (route.name) {
    case "home": {
      if (home.peek) {
        const id = home.peek;
        home.setPeek(null);
        focusSoon(`[data-shelf] .skincard[data-skin="${CSS.escape(id)}"] [${NAV}]`);
        return true;
      }
      if (home.openShelf) {
        const id = home.openShelf;
        home.closeShelf();
        focusSoon(`[data-entity="${CSS.escape(id)}"]`);
        return true;
      }
      return false;
    }
    case "entity":
      // the header portrait morphs back into its card, and the card takes focus again
      rememberFlipKey(`entity:${route.entityId}`);
      app.back();
      if (useApp.getState().route.name === "home") focusSoon(`[data-entity="${CSS.escape(route.entityId)}"]`);
      return true;
    case "skin": {
      // the big preview morphs back into its card (A2 or an open shelf), and that card takes focus again
      rememberFlipKey(`skin:${route.skinId}`);
      app.back();
      const id = CSS.escape(route.skinId);
      focusSoon(`[data-skin="${id}"] [${NAV}], [data-skin="${id}"][${NAV}]`);
      return true;
    }
    case "settings":
      app.back();
      return true;
    default:
      return false;
  }
}

/** Ctrl+F, or plain typing on Home: focus search, with the typed character added. Ctrl+F on A2 / A3 goes Home first. */
function search(text: string | undefined): boolean {
  const route = useApp.getState().route;
  const input = () => currentPage()?.querySelector<HTMLInputElement>(".toolbar__input") ?? null;
  if (route.name === "home") {
    const el = input();
    if (!el) return false;
    if (text) {
      const home = useHome.getState();
      home.setQuery(home.query + text);
      el.focus();
      // after React has written the new value, put the caret at the end
      requestAnimationFrame(() => el.setSelectionRange(el.value.length, el.value.length));
    } else {
      el.focus();
      el.select();
    }
    return true;
  }
  if (text || (route.name !== "entity" && route.name !== "skin")) return false;
  useApp.getState().navigate({ name: "home" });
  const tryFocus = (tries: number) => {
    const el = input();
    if (el) {
      el.focus();
      el.select();
    } else if (tries > 0) requestAnimationFrame(() => tryFocus(tries - 1));
  };
  requestAnimationFrame(() => tryFocus(30));
  return true;
}

const ROUTES_WITH_PICKS = new Set(["home", "entity", "skin", "settings"]);
const REPEATABLE = new Set<ShortcutAction["type"]>(["move", "undo", "search"]);

function run(action: ShortcutAction, e: KeyboardEvent): boolean {
  const route = useApp.getState().route.name;
  const home = useHome.getState();
  // holding a key repeats it: fine for arrows, undo and typing, not for toggles, Apply and navigation
  if (e.repeat && !REPEATABLE.has(action.type)) return true;
  switch (action.type) {
    case "toggleNsfw":
      home.toggleNsfw();
      return true;
    case "apply":
      if (!ROUTES_WITH_PICKS.has(route)) return false;
      void home.apply();
      return true;
    case "undo":
      if (!ROUTES_WITH_PICKS.has(route)) return false;
      home.undo();
      return true;
    case "search":
      return search(action.text);
    case "move":
      // A3 keeps ←/→ for its images (Gallery); Settings is a form
      return route === "home" || route === "entity" ? move(action.dir) : false;
    case "open":
      return open();
    case "pick":
      return pick();
    case "peek":
      return peek();
    case "back":
      return back();
  }
}

/** App-wide keyboard shortcuts (SPEC §12). Only while the window is focused; there is no global hook. */
export function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || overlayOpen()) return;
      const snap = useApp.getState().snapshot;
      if (!snap || useApp.getState().route.name === "setup") return;
      const action = resolveShortcut(e, { nsfwHotkey: snap.settings.nsfw.hotkey, typing: isTyping(e.target) });
      if (action && run(action, e)) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
