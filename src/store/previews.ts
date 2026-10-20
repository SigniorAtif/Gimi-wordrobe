// Preview actions (SPEC §10): GameBanana fetches tracked per skin (the covers' "Fetching from GameBanana…" state and
// "Retry"), images dropped or pasted onto a skin, reorder, remove and the mod-folder search. Disk truth stays in the
// app snapshot; this store only knows what is running and what last failed.
import { create } from "zustand";
import { api, toFailure } from "../api";
import { redactHidden } from "../lib/nsfw";
import { fetchResultToasts, isImagePath, previewFailureToast, type PreviewAction, type ToastSpec } from "../lib/previews";
import { useApp } from "./app";
import { useHome } from "./home";

interface PreviewsState {
  /** skin id -> token of its running GameBanana fetch (a newer fetch for the same skin replaces the token) */
  fetching: Record<string, number>;
  /** skin id -> error code of its last failed GameBanana fetch; cleared when the next one starts */
  failed: Record<string, string>;
  /** `${action}:${skinId}` -> calls running (buttons show a spinner) */
  running: Record<string, number>;

  /** Download the skin's GameBanana previews (its saved link). Resolves true when it worked. */
  fetchGameBanana(skinId: string): Promise<boolean>;
  /** Copy preview images from the skin's own folders (installed mods came without an archive). */
  findInFolder(skinId: string): Promise<void>;
  /** Image files dropped on a skin card or gallery, or picked. Non-images are skipped. */
  addFiles(skinId: string, paths: string[]): Promise<void>;
  /** Ctrl+V: the clipboard image's bytes. */
  paste(skinId: string, bytes: Uint8Array): Promise<void>;
  remove(skinId: string, file: string): Promise<boolean>;
  /** New order of `Preview.file`s; the first is the cover. */
  reorder(skinId: string, order: string[]): Promise<boolean>;
}

let fetchSeq = 0;

/** Toast with hidden NSFW names and folders taken out (SPEC §11): the snapshot may have just marked a skin 18+. */
function say(t: ToastSpec) {
  const app = useApp.getState();
  const visible = useHome.getState().nsfwVisible;
  app.toast({
    kind: t.kind,
    text: redactHidden(t.text, app.snapshot, visible),
    ...(t.detail ? { detail: redactHidden(t.detail, app.snapshot, visible) } : {}),
  });
}

function nameOf(skinId: string): string {
  return useApp.getState().snapshot?.library.skins.find((s) => s.id === skinId)?.name ?? "this skin";
}

function without<T>(rec: Record<string, T>, key: string): Record<string, T> {
  if (!(key in rec)) return rec;
  const next = { ...rec };
  delete next[key];
  return next;
}

export function isRunning(s: Pick<PreviewsState, "running">, action: PreviewAction, skinId: string): boolean {
  return (s.running[`${action}:${skinId}`] ?? 0) > 0;
}

export const usePreviews = create<PreviewsState>((set, get) => {
  /** Count a call as running for its button while it lasts. */
  const track = async <T>(action: PreviewAction, skinId: string, run: () => Promise<T>): Promise<T> => {
    const key = `${action}:${skinId}`;
    set((s) => ({ running: { ...s.running, [key]: (s.running[key] ?? 0) + 1 } }));
    try {
      return await run();
    } finally {
      set((s) => {
        const n = (s.running[key] ?? 1) - 1;
        return { running: n > 0 ? { ...s.running, [key]: n } : without(s.running, key) };
      });
    }
  };

  return {
    fetching: {},
    failed: {},
    running: {},

    async fetchGameBanana(skinId) {
      const token = ++fetchSeq;
      set((s) => ({ fetching: { ...s.fetching, [skinId]: token }, failed: without(s.failed, skinId) }));
      const current = () => get().fetching[skinId] === token;
      try {
        const r = await api.fetchGameBananaPreviews(skinId);
        useApp.getState().setSnapshot(r.snapshot);
        if (current()) set((s) => ({ fetching: without(s.fetching, skinId) }));
        const app = useApp.getState();
        const skin = r.snapshot.library.skins.find((s) => s.id === skinId);
        const toasts = fetchResultToasts(r, {
          name: skin?.name ?? "this skin",
          hiddenNow: !!skin?.nsfw && !useHome.getState().nsfwVisible,
          hotkey: app.snapshot?.settings.nsfw.hotkey ?? "Ctrl+H",
        });
        toasts.forEach(say);
        return true;
      } catch (e) {
        // a newer fetch for this skin (its link was saved again) owns the state now; this one's link_changed is moot
        if (!current()) return false;
        const f = toFailure(e);
        set((s) => ({ fetching: without(s.fetching, skinId), failed: { ...s.failed, [skinId]: f.code } }));
        say(previewFailureToast(f.code, f.message, "fetch"));
        return false;
      }
    },

    async findInFolder(skinId) {
      await track("find", skinId, async () => {
        try {
          const r = await api.findFolderPreviews(skinId);
          useApp.getState().setSnapshot(r.snapshot);
          say(
            r.added > 0
              ? { kind: "success", text: `Found ${r.added} preview${r.added === 1 ? "" : "s"} in the mod folder.` }
              : { kind: "info", text: "No preview images in the mod folder.", detail: "Textures and UI images are skipped." },
          );
        } catch (e) {
          const f = toFailure(e);
          say(previewFailureToast(f.code, f.message, "find"));
        }
      });
    },

    async addFiles(skinId, paths) {
      const images = paths.filter(isImagePath);
      if (!images.length) {
        say({ kind: "info", text: "Drop a PNG, JPG or WebP image to add a preview." });
        return;
      }
      await track("add", skinId, async () => {
        let added = 0;
        const failures = new Map<string, string>();
        for (const path of images) {
          try {
            useApp.getState().setSnapshot(await api.addPreview(skinId, path));
            added++;
          } catch (e) {
            const f = toFailure(e);
            if (!failures.has(f.code)) failures.set(f.code, f.message);
            // the rest won't fit either
            if (f.code === "too_many" || f.code === "unknown_skin") break;
          }
        }
        if (added > 0) {
          const what = added === 1 ? "the image" : `${added} images`;
          say({ kind: "success", text: `Added ${what} to ${nameOf(skinId)}'s previews.` });
        }
        for (const [code, message] of failures) say(previewFailureToast(code, message, "add"));
      });
    },

    async paste(skinId, bytes) {
      await track("paste", skinId, async () => {
        try {
          useApp.getState().setSnapshot(await api.pastePreview(skinId, bytes));
          say({ kind: "success", text: `Pasted the image into ${nameOf(skinId)}'s previews.` });
        } catch (e) {
          const f = toFailure(e);
          say(previewFailureToast(f.code, f.message, "paste"));
        }
      });
    },

    async remove(skinId, file) {
      return track("remove", skinId, async () => {
        try {
          useApp.getState().setSnapshot(await api.removePreview(skinId, file));
          say({ kind: "info", text: "Moved the image to the Recycle Bin." });
          return true;
        } catch (e) {
          const f = toFailure(e);
          say(previewFailureToast(f.code, f.message, "remove"));
          return false;
        }
      });
    },

    async reorder(skinId, order) {
      return track("reorder", skinId, async () => {
        try {
          useApp.getState().setSnapshot(await api.updateSkin(skinId, { previewOrder: order }));
          return true;
        } catch (e) {
          const f = toFailure(e);
          say(previewFailureToast(f.code, f.message, "reorder"));
          return false;
        }
      });
    },
  };
});

/** The cover state for a skin: a GameBanana fetch running, and the code of its last failed fetch. */
export function usePreviewStatus(skinId: string): { fetching: boolean; failed: string | undefined } {
  const fetching = usePreviews((s) => skinId in s.fetching);
  const failed = usePreviews((s) => s.failed[skinId]);
  return { fetching, failed };
}
