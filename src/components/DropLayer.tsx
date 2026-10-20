import { AnimatePresence, motion, useMotionValue } from "motion/react";
import { useEffect } from "react";
import { api } from "../api";
import type { FileDropEvent } from "../api/types";
import { tween } from "../motion";
import { fileKind, useAdd, type DragState, type DropTarget } from "../store/add";
import { useApp } from "../store/app";
import { usePreviews } from "../store/previews";
import "./DropLayer.css";

function targetAt(x: number, y: number): { target: DropTarget; el: HTMLElement | null } {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop]") ?? null;
  const v = el?.dataset.drop ?? "";
  if (v.startsWith("entity:")) return { target: { kind: "entity", id: v.slice(7) }, el };
  if (v === "new:character") return { target: { kind: "new", category: "character" }, el };
  if (v === "new:other") return { target: { kind: "new", category: "other" }, el };
  if (v === "portrait") return { target: { kind: "portrait" }, el };
  if (v === "preview") return { target: { kind: "preview" }, el };
  if (v.startsWith("skin:")) return { target: { kind: "skin", id: v.slice(5) }, el };
  return { target: null, el: null };
}

/** The skin card or gallery an image is dragged over gets `data-drop-hover` (React doesn't own the attribute). */
let hovered: HTMLElement | null = null;
function markHover(el: HTMLElement | null) {
  if (el === hovered) return;
  hovered?.removeAttribute("data-drop-hover");
  hovered = el;
  hovered?.setAttribute("data-drop-hover", "");
}

/**
 * Listens to OS file drags (SPEC §13) and routes drops (SPEC §6): in Shelves an archive dropped on a card or a
 * "+ New" tile opens the C4 popover there; anywhere else (and always in Pages) it opens A4. Images dropped while a
 * flow is open become its portrait or preview; otherwise an image dropped on a skin card or gallery is added to that
 * skin's previews (SPEC §10).
 */
export function DropLayer() {
  const drag = useAdd((s) => s.drag);
  // the chip sits on the cursor; smoothing it only makes it lag behind the OS drag image
  const mx = useMotionValue(0);
  const my = useMotionValue(0);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let live = true;
    const handle = (e: FileDropEvent) => {
      const add = useAdd.getState();
      if (e.type === "leave") {
        markHover(null);
        add.resetDrag();
        return;
      }
      // only a skin card or gallery takes an image when no add flow is open
      const hover = (t: ReturnType<typeof targetAt>, kind: DragState["kind"]) =>
        markHover(kind === "image" && !add.flow && t.target?.kind === "skin" ? t.el : null);
      if (e.type === "enter") {
        const name = e.paths[0]?.split(/[\\/]/).pop() ?? "";
        const kind = fileKind(e.paths[0] ?? "");
        const at = targetAt(e.x, e.y);
        add.setDrag({ active: true, kind, name, paths: e.paths, x: e.x, y: e.y, over: at.target });
        hover(at, kind);
        mx.jump(e.x);
        my.jump(e.y);
        return;
      }
      if (e.type === "over") {
        mx.set(e.x);
        my.set(e.y);
        const at = targetAt(e.x, e.y);
        add.setDrag({ x: e.x, y: e.y, over: at.target });
        hover(at, add.drag.kind);
        return;
      }
      // drop
      markHover(null);
      const { target, el } = targetAt(e.x, e.y);
      const paths = e.paths.length ? e.paths : add.drag.paths;
      const path = paths[0];
      const kind = fileKind(path ?? "");
      add.resetDrag();
      if (!path) return;
      if (kind === "image") {
        if (add.flow) add.dropImage(path, target?.kind === "portrait" ? "portrait" : "preview");
        else if (target?.kind === "skin") void usePreviews.getState().addFiles(target.id, paths);
        else useApp.getState().toast({ kind: "info", text: "Drop the image on a skin's card or gallery to add it as a preview." });
        return;
      }
      if (kind !== "archive") {
        useApp.getState().toast({ kind: "info", text: "Drop a .zip, .rar or .7z mod archive." });
        return;
      }
      const app = useApp.getState();
      const layout = app.snapshot?.settings.layout;
      // an archive dropped on a skin card goes to that skin's character, like a drop on the A2 page
      const skinEntity = target?.kind === "skin" ? (app.snapshot?.library.skins.find((s) => s.id === target.id)?.entityId ?? null) : null;
      const routeEntity = app.route.name === "entity" ? app.route.entityId : skinEntity;
      if (add.flow?.kind === "a4") {
        void add.start(path, { kind: "a4", entityId: add.flow.entityId });
      } else if (layout === "shelves" && app.route.name === "home" && target?.kind === "entity") {
        void add.start(path, { kind: "c4", entityId: target.id, anchor: el?.getBoundingClientRect() ?? null });
      } else if (layout === "shelves" && app.route.name === "home" && target?.kind === "new") {
        void add.start(path, {
          kind: "c4",
          newCategory: target.category === "character" ? "character" : "weapon",
          anchor: el?.getBoundingClientRect() ?? null,
        });
      } else {
        void add.start(path, { kind: "a4", entityId: routeEntity });
      }
    };
    api.onFileDrop(handle).then((u) => {
      if (live) unlisten = u;
      else u();
    });
    return () => {
      live = false;
      unlisten?.();
    };
  }, [mx, my]);

  useEffect(() => {
    document.body.classList.toggle("dragging-archive", drag.active && drag.kind === "archive");
    document.body.classList.toggle("dragging-image", drag.active && drag.kind === "image");
  }, [drag.active, drag.kind]);

  return (
    <AnimatePresence>
      {drag.active && drag.kind !== "other" && (
        <motion.div
          className="drag-chip"
          style={{ x: mx, y: my }}
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1, transition: tween.small }}
          exit={{ opacity: 0, transition: tween.micro }}
        >
          <span className="drag-chip__name">{drag.name}</span>
          <span aria-hidden>⤓</span>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
