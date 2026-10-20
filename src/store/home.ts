// Home screen state: pending picks, the open shelf, search/filter, NSFW visibility and the Apply flow.
import { create } from "zustand";
import { api, toFailure } from "../api";
import type { PinCheck, Picks, Snapshot } from "../api/types";
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
  /** bumped on every reveal or hide, so cards mounting after it know they are being revealed (SPEC §7) */
  nsfwEpoch: number;
  /** asking for the PIN before revealing NSFW skins */
  pinPrompt: boolean;
  /** when the PIN lockout ends (ms since epoch), 0 when not locked */
  pinRetryAt: number;
  applyState: ApplyState;
  /** C3 quick peek: the skin shown in the open shelf's 3-column view */
  peek: string | null;
  /** shared-element targets: the card that morphs into the next page's hero (SPEC §7) */
  morphSkin: string | null;
  morphEntity: string | null;
  /** entity the user is "in" (open shelf or A2), kept across layout switches */
  contextEntity: string | null;

  pick(entityId: string, skinId: string | null): void;
  undo(): void;
  discard(): void;
  toggleShelf(entityId: string): void;
  closeShelf(): void;
  setQuery(q: string): void;
  setChip(c: Chip): void;
  /** The reveal hotkey and the 18+ chip: hide, or reveal (asking for the PIN first when one is set). */
  toggleNsfw(): void;
  /** Show 18+ skins, or open the PIN prompt when a PIN is set. Nothing shows until the PIN checks out. */
  revealNsfw(): void;
  /** Hide 18+ skins (never needs a PIN), and leave any peek or detail page that shows one. */
  hideNsfw(): void;
  /** Check a PIN from the prompt; a right one reveals. Throws when the backend fails. */
  submitPin(pin: string): Promise<PinCheck>;
  closePinPrompt(): void;
  setPeek(skinId: string | null): void;
  setMorph(m: { skin?: string | null; entity?: string | null }): void;
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
  nsfwEpoch: 0,
  pinPrompt: false,
  pinRetryAt: 0,
  applyState: IDLE,
  peek: null,
  morphSkin: null,
  morphEntity: null,
  contextEntity: null,

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
    set((s) => {
      const open = s.openShelf === entityId ? null : entityId;
      return { openShelf: open, peek: null, contextEntity: open };
    });
  },

  closeShelf() {
    set({ openShelf: null, peek: null, contextEntity: null });
  },

  setPeek(peek) {
    set({ peek });
  },

  setMorph(m) {
    set((s) => ({
      morphSkin: m.skin !== undefined ? m.skin : s.morphSkin,
      morphEntity: m.entity !== undefined ? m.entity : s.morphEntity,
      contextEntity: m.entity ? m.entity : s.contextEntity,
    }));
  },

  setQuery(query) {
    set({ query });
  },

  setChip(chip) {
    set({ chip });
  },

  toggleNsfw() {
    if (get().nsfwVisible) get().hideNsfw();
    else get().revealNsfw();
  },

  revealNsfw() {
    if (get().nsfwVisible) return;
    if (useApp.getState().snapshot?.pinSet) set({ pinPrompt: true });
    else set((s) => ({ nsfwVisible: true, nsfwEpoch: s.nsfwEpoch + 1 }));
  },

  hideNsfw() {
    if (!get().nsfwVisible) {
      if (get().pinPrompt) set({ pinPrompt: false });
      return;
    }
    const app = useApp.getState();
    const skins = app.snapshot?.library.skins ?? [];
    const hidden = (id: string | null) => !!id && !!skins.find((k) => k.id === id)?.nsfw;
    set((s) => ({
      nsfwVisible: false,
      nsfwEpoch: s.nsfwEpoch + 1,
      pinPrompt: false,
      peek: hidden(s.peek) ? null : s.peek,
      morphSkin: hidden(s.morphSkin) ? null : s.morphSkin,
    }));
    // a detail page of a skin that just went hidden goes back to its entity or home, and leaves the history too
    app.leaveRoutes((r) => r.name === "skin" && hidden(r.skinId));
  },

  async submitPin(pin) {
    const r = await api.verifyPin(pin);
    if (r.ok) {
      // the prompt was cancelled while the check ran: the user no longer asked to reveal
      if (get().pinPrompt) set((s) => ({ nsfwVisible: true, nsfwEpoch: s.nsfwEpoch + 1, pinPrompt: false, pinRetryAt: 0 }));
      else set({ pinRetryAt: 0 });
    } else {
      set({ pinRetryAt: r.retryIn > 0 ? Date.now() + r.retryIn * 1000 : 0 });
    }
    return r;
  },

  closePinPrompt() {
    set({ pinPrompt: false });
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
