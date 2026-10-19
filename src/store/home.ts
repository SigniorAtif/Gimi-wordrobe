// Home screen state: pending picks, the open shelf, search/filter, NSFW visibility and the Apply flow.
import { create } from "zustand";
import { api, toFailure } from "../api";
import type { Picks, Snapshot } from "../api/types";
import { useApp } from "./app";

export type Chip = "all" | "character" | "weapon" | "extra" | "modded";

export interface ApplyState {
  phase: "idle" | "running" | "done";
  done: number;
  total: number;
  label: string;
}

interface HomeState {
  picks: Picks;
  /** previous picks, newest last (Ctrl+Z) */
  history: Picks[];
  openShelf: string | null;
  query: string;
  chip: Chip;
  nsfwVisible: boolean;
  applyState: ApplyState;

  pick(entityId: string, skinId: string | null): void;
  undo(): void;
  discard(): void;
  toggleShelf(entityId: string): void;
  closeShelf(): void;
  setQuery(q: string): void;
  setChip(c: Chip): void;
  setNsfwVisible(v: boolean): void;
  apply(): Promise<void>;
  removeSkin(skinId: string): Promise<void>;
}

const IDLE: ApplyState = { phase: "idle", done: 0, total: 0, label: "" };
const TITLE = "Skin Switcher";
let titleTimer: ReturnType<typeof setTimeout> | null = null;

/** Keep only picks that still mean something after the disk changed. */
export function prunePicks(picks: Picks, snap: Snapshot): Picks {
  const out: Picks = {};
  for (const [entityId, skinId] of Object.entries(picks)) {
    const entity = snap.library.entities.find((e) => e.id === entityId);
    if (!entity) continue;
    if (skinId && !snap.library.skins.some((s) => s.id === skinId && s.entityId === entityId)) continue;
    const onDisk = snap.disk.active[entityId] ?? [];
    // already the state on disk (exactly one active, or none for Original)
    const same = skinId === null ? onDisk.length === 0 : onDisk.length === 1 && onDisk[0] === skinId;
    if (!same) out[entityId] = skinId;
  }
  return out;
}

function samePicks(a: Picks, b: Picks): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => k in b && a[k] === b[k]);
}

export const useHome = create<HomeState>((set, get) => ({
  picks: {},
  history: [],
  openShelf: null,
  query: "",
  chip: "all",
  nsfwVisible: false,
  applyState: IDLE,

  pick(entityId, skinId) {
    const snap = useApp.getState().snapshot;
    if (!snap || get().applyState.phase !== "idle") return;
    const { picks, history } = get();
    const next = prunePicks({ ...picks, [entityId]: skinId }, snap);
    if (samePicks(next, picks)) return;
    set({ picks: next, history: [...history.slice(-49), picks] });
  },

  undo() {
    const { history } = get();
    if (!history.length || get().applyState.phase !== "idle") return;
    set({ picks: history[history.length - 1], history: history.slice(0, -1) });
  },

  discard() {
    if (get().applyState.phase !== "idle") return;
    const { picks, history } = get();
    if (!Object.keys(picks).length) return;
    set({ picks: {}, history: [...history.slice(-49), picks] });
  },

  toggleShelf(entityId) {
    set((s) => ({ openShelf: s.openShelf === entityId ? null : entityId }));
  },

  closeShelf() {
    set({ openShelf: null });
  },

  setQuery(query) {
    set({ query });
  },

  setChip(chip) {
    set({ chip });
  },

  setNsfwVisible(nsfwVisible) {
    set({ nsfwVisible });
  },

  async apply() {
    const { picks, applyState } = get();
    if (!Object.keys(picks).length || applyState.phase !== "idle") return;
    const app = useApp.getState();
    set({ applyState: { phase: "running", done: 0, total: Object.keys(picks).length, label: "Checking the Mods folder" } });
    try {
      const r = await api.apply(picks, (p) => set({ applyState: { phase: "running", ...p } }));
      app.setSnapshot(r.snapshot);
      if (r.changedOutside) {
        set({ picks: prunePicks(picks, r.snapshot), applyState: IDLE });
        app.toast({ kind: "info", text: "Mods folder changed outside the app — re-scanned. Check your picks and Apply again." });
        return;
      }
      set({ applyState: { ...get().applyState, phase: "done" } });
      app.toast({ kind: "success", text: "Applied. Press [[F10]] in game to reload." });
      for (const w of r.warnings) app.toast({ kind: "info", text: w });
      // the title shows in the taskbar while the game has focus (SPEC §6)
      void api.setWindowTitle("Applied — press F10");
      if (titleTimer) clearTimeout(titleTimer);
      titleTimer = setTimeout(() => void api.setWindowTitle(TITLE), 6000);
      // let the check mark land, then the bar slides away
      setTimeout(() => set({ picks: {}, history: [], applyState: IDLE }), 750);
    } catch (e) {
      set({ applyState: IDLE });
      const f = toFailure(e);
      app.toast({ kind: "error", text: "Apply failed.", detail: f.message, ttl: 10000 });
      try {
        app.setSnapshot(await api.rescan());
      } catch {
        /* keep the old snapshot */
      }
    }
  },

  async removeSkin(skinId) {
    const app = useApp.getState();
    try {
      const snap = await api.removeSkin(skinId);
      app.setSnapshot(snap);
      set((s) => ({ picks: prunePicks(s.picks, snap) }));
      app.toast({ kind: "info", text: "Moved to the Recycle Bin." });
    } catch (e) {
      app.toast({ kind: "error", text: "Couldn't remove the skin.", detail: toFailure(e).message });
    }
  },
}));
