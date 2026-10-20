// App state (Zustand). Disk truth lives in `snapshot` (always from the backend); everything else is UI state.
import { create } from "zustand";
import { api, toFailure, type Settings, type Snapshot } from "../api";

export type Route =
  | { name: "home" }
  | { name: "entity"; entityId: string }
  | { name: "skin"; skinId: string }
  | { name: "settings" }
  | { name: "setup" }
  /** first-run import / Re-scan review (SPEC §5) */
  | { name: "import" };

/** First run: an empty library but mods or archives in the Mods folder, so the import review comes first. */
export function wantsImport(s: Snapshot): boolean {
  return s.configured && s.library.skins.length === 0 && (s.disk.unknownRoots.length > 0 || s.disk.archives.length > 0);
}

export function routeKey(r: Route): string {
  switch (r.name) {
    case "entity":
      return `entity:${r.entityId}`;
    case "skin":
      return `skin:${r.skinId}`;
    default:
      return r.name;
  }
}

export interface Toast {
  id: number;
  kind: "success" | "error" | "info";
  text: string;
  detail?: string;
  /** ms; 0 = sticky until dismissed */
  ttl: number;
}

interface AppState {
  snapshot: Snapshot | null;
  booting: boolean;
  bootError: string | null;
  route: Route;
  history: Route[];
  /** +1 forward, -1 back: drives direction-aware page transitions */
  navDir: 1 | -1;
  scrollMemory: Record<string, number>;
  toasts: Toast[];

  boot(): Promise<void>;
  setSnapshot(s: Snapshot): void;
  navigate(r: Route): void;
  replace(r: Route, dir?: 1 | -1): void;
  back(): void;
  /** Leave and forget every route `drop` matches: the history loses them, and the current one goes back. */
  leaveRoutes(drop: (r: Route) => boolean): void;
  rememberScroll(key: string, top: number): void;
  saveSettings(patch: Partial<Settings>): Promise<void>;
  toast(t: Omit<Toast, "id" | "ttl"> & { ttl?: number }): void;
  dismissToast(id: number): void;
}

let toastSeq = 1;
let settingsSeq = 0;
/** Last settings the backend confirmed; a failed save falls back to these. */
let confirmedSettings: Settings | null = null;

export const useApp = create<AppState>((set, get) => ({
  snapshot: null,
  booting: true,
  bootError: null,
  route: { name: "home" },
  history: [],
  navDir: 1,
  scrollMemory: {},
  toasts: [],

  async boot() {
    set({ booting: true, bootError: null });
    try {
      const snapshot = await api.load();
      confirmedSettings = snapshot.settings;
      const route: Route = !snapshot.configured ? { name: "setup" } : wantsImport(snapshot) ? { name: "import" } : { name: "home" };
      set({ snapshot, booting: false, route, history: [] });
      if (snapshot.recovered) {
        get().toast({ kind: "info", text: snapshot.recovered.message, ttl: 0 });
      }
      if (snapshot.notice) {
        get().toast({ kind: "error", text: snapshot.notice, ttl: 0 });
      }
    } catch (e) {
      set({ booting: false, bootError: toFailure(e).message });
    }
  },

  setSnapshot(snapshot) {
    confirmedSettings = snapshot.settings;
    set({ snapshot });
  },

  navigate(r) {
    const { route, history } = get();
    if (routeKey(r) === routeKey(route)) return;
    set({ route: r, history: [...history, route], navDir: 1 });
  },

  replace(r, dir = 1) {
    set({ route: r, navDir: dir });
  },

  back() {
    const { history } = get();
    if (!history.length) {
      set({ route: { name: "home" }, navDir: -1 });
      return;
    }
    const prev = history[history.length - 1];
    set({ route: prev, history: history.slice(0, -1), navDir: -1 });
  },

  leaveRoutes(drop) {
    const { route, history } = get();
    const kept = history.filter((r) => !drop(r));
    if (!drop(route)) {
      if (kept.length !== history.length) set({ history: kept });
      return;
    }
    set({ route: kept[kept.length - 1] ?? { name: "home" }, history: kept.slice(0, -1), navDir: -1 });
  },

  rememberScroll(key, top) {
    set((s) => ({ scrollMemory: { ...s.scrollMemory, [key]: top } }));
  },

  async saveSettings(patch) {
    const snap = get().snapshot;
    if (!snap) return;
    const seq = ++settingsSeq;
    const next: Settings = { ...snap.settings, ...patch };
    // optimistic: settings save instantly (§6), the backend may re-scan and return a fresh snapshot
    set({ snapshot: { ...snap, settings: next } });
    try {
      const fresh = await api.saveSettings(next);
      confirmedSettings = fresh.settings;
      // a newer save already went out with this patch included; only the latest response wins
      if (seq === settingsSeq) set({ snapshot: fresh });
    } catch (e) {
      if (seq === settingsSeq) {
        // fall back to what the backend last confirmed, not just this call's keys
        const cur = get().snapshot ?? snap;
        set({ snapshot: { ...cur, settings: confirmedSettings ?? snap.settings } });
      }
      get().toast({ kind: "error", text: toFailure(e).message });
    }
  },

  toast(t) {
    const id = toastSeq++;
    const ttl = t.ttl ?? (t.kind === "error" ? 8000 : 6000);
    set((s) => ({ toasts: [...s.toasts.slice(-3), { ...t, id, ttl }] }));
    if (ttl > 0) setTimeout(() => get().dismissToast(id), ttl);
  },

  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));
