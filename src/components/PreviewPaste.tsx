import { useEffect } from "react";
import { useAdd } from "../store/add";
import { useApp } from "../store/app";
import { useHome } from "../store/home";
import { usePreviews } from "../store/previews";

function editable(el: Element | null): boolean {
  const h = el as HTMLElement | null;
  return !!h && (h.tagName === "INPUT" || h.tagName === "TEXTAREA" || h.tagName === "SELECT" || h.isContentEditable);
}

/** The first image on the clipboard, if any (a copied file or a screenshot). */
function clipboardImage(data: DataTransfer | null): File | null {
  for (const item of data?.items ?? []) {
    if (item.kind === "file" && item.type.startsWith("image/")) return item.getAsFile();
  }
  for (const f of data?.files ?? []) if (f.type.startsWith("image/")) return f;
  return null;
}

/** The skin a paste is for: the focused skin card or gallery, else the skin whose A3 page is open. */
function pasteTarget(active: HTMLElement | null): string | null {
  const drop = active?.closest<HTMLElement>('[data-drop^="skin:"]')?.dataset.drop;
  if (drop) return drop.slice(5);
  const card = active?.closest<HTMLElement>("[data-skin]")?.dataset.skin;
  if (card && card !== "original") return card;
  const route = useApp.getState().route;
  if (route.name !== "skin") return null;
  // a hidden 18+ skin's page shows nothing to paste into
  const skin = useApp.getState().snapshot?.library.skins.find((s) => s.id === route.skinId);
  return skin && (!skin.nsfw || useHome.getState().nsfwVisible) ? skin.id : null;
}

/**
 * Ctrl+V on a focused skin card, a gallery, or anywhere on the A3 page outside a text field adds the clipboard image
 * to that skin's previews (SPEC §10 state 3). Text fields and open dialogs keep their own paste.
 */
export function PreviewPaste() {
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const active = document.activeElement as HTMLElement | null;
      if (editable(active) || editable(e.target as Element | null)) return;
      if (useAdd.getState().flow || document.querySelector('[aria-modal="true"]')) return;
      const image = clipboardImage(e.clipboardData);
      if (!image) return;
      e.preventDefault();
      const skinId = pasteTarget(active);
      if (!skinId) {
        useApp.getState().toast({ kind: "info", text: "Select a skin card, or open its page, then paste to add a preview." });
        return;
      }
      void image.arrayBuffer().then((buf) => usePreviews.getState().paste(skinId, new Uint8Array(buf)));
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);
  return null;
}
