// Add-flow state (SPEC §6 A4 / C4): the OS file drag, the dialog or popover being filled, extraction progress.
import { create } from "zustand";
import { api, toFailure } from "../api";
import type { AddProgress, AddSkinRequest, ArchiveSummary, Category } from "../api/types";
import { useApp } from "./app";
import { useHome } from "./home";

export type DropTarget =
  | { kind: "entity"; id: string }
  | { kind: "new"; category: "character" | "other" }
  | { kind: "portrait" }
  | { kind: "preview" }
  | null;

/** An image dropped while a flow is open: a new entity's portrait, or the skin's own preview. */
export interface DroppedImage {
  path: string;
  target: "portrait" | "preview";
  /** bumps on every drop so dropping the same file twice still registers */
  seq: number;
}

export interface DragState {
  active: boolean;
  /** "archive" for .zip/.rar/.7z, "image" for portraits/previews */
  kind: "archive" | "image" | "other";
  name: string;
  paths: string[];
  x: number;
  y: number;
  over: DropTarget;
}

export interface AddFlow {
  kind: "a4" | "c4";
  archivePath: string;
  summary: ArchiveSummary | null;
  error: string | null;
  /** pre-selected entity (dropped on its card, or A2 open) */
  entityId: string | null;
  /** dropped on "+ New character" / "+ New weapon / extra" */
  newCategory: Category | null;
  /** C4: the card the popover is anchored to */
  anchor: DOMRect | null;
}

interface AddState {
  drag: DragState;
  flow: AddFlow | null;
  progress: AddProgress | null;
  busy: boolean;
  /** last image dropped onto a portrait or preview target while a flow is open */
  droppedImage: DroppedImage | null;
  setDrag(d: Partial<DragState>): void;
  resetDrag(): void;
  start(archivePath: string, opts: { kind: "a4" | "c4"; entityId?: string | null; newCategory?: Category | null; anchor?: DOMRect | null }): Promise<void>;
  /** Pick an archive with the system dialog, then open A4. */
  browse(entityId?: string | null): Promise<void>;
  close(): void;
  /** C4 -> A4 ("More options…"): same archive, the full dialog. */
  expand(): void;
  dropImage(path: string, target: DroppedImage["target"]): void;
  submit(req: AddSkinRequest, entityName: string): Promise<boolean>;
}

const IDLE_DRAG: DragState = { active: false, kind: "other", name: "", paths: [], x: 0, y: 0, over: null };

export function fileKind(path: string): DragState["kind"] {
  const l = path.toLowerCase();
  if (/\.(zip|rar|7z)$/.test(l)) return "archive";
  if (/\.(png|jpe?g|webp)$/.test(l)) return "image";
  return "other";
}

export const useAdd = create<AddState>((set, get) => ({
  drag: IDLE_DRAG,
  flow: null,
  progress: null,
  busy: false,
  droppedImage: null,

  setDrag(d) {
    set((s) => ({ drag: { ...s.drag, ...d } }));
  },

  resetDrag() {
    set({ drag: IDLE_DRAG });
  },

  async start(archivePath, opts) {
    set({
      flow: {
        kind: opts.kind,
        archivePath,
        summary: null,
        error: null,
        entityId: opts.entityId ?? null,
        newCategory: opts.newCategory ?? null,
        anchor: opts.anchor ?? null,
      },
      progress: null,
      droppedImage: null,
    });
    try {
      const summary = await api.analyzeArchive(archivePath);
      if (get().flow?.archivePath === archivePath) set((s) => ({ flow: s.flow && { ...s.flow, summary } }));
    } catch (e) {
      const f = toFailure(e);
      if (f.code === "unsafe_archive") {
        set({ flow: null });
        useApp.getState().toast({ kind: "error", text: "Archive rejected.", detail: f.message, ttl: 10000 });
      } else {
        set((s) => ({ flow: s.flow && { ...s.flow, error: f.message } }));
      }
    }
  },

  async browse(entityId = null) {
    const path = await api.pickArchive();
    if (path) await get().start(path, { kind: "a4", entityId });
  },

  close() {
    if (get().busy) return;
    set({ flow: null, progress: null, droppedImage: null });
  },

  expand() {
    set((s) => ({ flow: s.flow && { ...s.flow, kind: "a4", anchor: null } }));
  },

  dropImage(path, target) {
    set((s) => ({ droppedImage: { path, target, seq: (s.droppedImage?.seq ?? 0) + 1 } }));
  },

  async submit(req, entityName) {
    const app = useApp.getState();
    set({ busy: true, progress: { done: 0, total: 1, label: "Extracting" } });
    try {
      const r = await api.addSkin(req, (progress) => set({ progress }));
      app.setSnapshot(r.snapshot);
      set({ busy: false, flow: null, progress: null });
      app.toast({ kind: "success", text: `Added ${req.main.skinName} to ${entityName}.` });
      for (const w of r.warnings) app.toast({ kind: "info", text: w });
      // show where it went: the entity's shelf (Shelves) or its page (Pages)
      const main = r.snapshot.library.skins.find((s) => s.id === r.skinIds[r.skinIds.length - 1]);
      if (main) {
        if (r.snapshot.settings.layout === "shelves") {
          const home = useHome.getState();
          if (app.route.name !== "home") app.navigate({ name: "home" });
          if (home.openShelf !== main.entityId) home.toggleShelf(main.entityId);
        } else if (!(app.route.name === "entity" && app.route.entityId === main.entityId)) {
          app.navigate({ name: "entity", entityId: main.entityId });
        }
      }
      return true;
    } catch (e) {
      set({ busy: false, progress: null });
      app.toast({ kind: "error", text: "Couldn't add the skin.", detail: toFailure(e).message, ttl: 10000 });
      return false;
    }
  },
}));
