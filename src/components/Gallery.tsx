import { AnimatePresence, motion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../api";
import type { Skin } from "../api/types";
import { isGameBananaUrl } from "../lib/addDraft";
import { canRetry, moveItem, orderedPreviews, sameOrder, slotAt, sourceCaption } from "../lib/previews";
import { spring, tween } from "../motion";
import { isRunning, usePreviews, usePreviewStatus } from "../store/previews";
import { CoverShimmer, RetryButton } from "./Cover";
import { Flip } from "./Flip";
import { ConfirmDialog } from "./Modal";
import "./Gallery.css";
import "./Previews.css";

type Slot = { x: number; y: number; w: number; h: number };

/**
 * Preview gallery (SPEC §6 A3/C3, §10): main image, thumbnails, sources caption; ←/→ step with a direction-aware
 * slide. Images dropped or pasted onto it join the skin's previews. On A3 (not compact) the thumbnails drag to reorder
 * (the first is the cover), and the current image can become the cover or go to the Recycle Bin.
 */
export function Gallery({
  skin,
  hidden,
  reduced,
  keyboard,
  compact,
  flip,
}: {
  skin: Skin;
  hidden?: boolean;
  reduced: boolean;
  /** listen for ←/→ on the window (A3 page) */
  keyboard?: boolean;
  compact?: boolean;
  /** morph to/from the skin cards (A3) */
  flip?: boolean;
}) {
  const { fetching, failed } = usePreviewStatus(skin.id);
  const finding = usePreviews((s) => isRunning(s, "find", skin.id));
  const { reorder, remove, addFiles, findInFolder, fetchGameBanana } = usePreviews.getState();
  const manage = !compact && !hidden;
  // a local order while a thumbnail is dragged, kept until the backend has the new one
  const [local, setLocal] = useState<string[] | null>(null);
  const previews = orderedPreviews(skin.previews, local);
  // the image shown is followed by file, so reordering doesn't swap it; idx is the fallback once it's removed
  const [state, setState] = useState({ idx: 0, dir: 1, skin: skin.id, file: null as string | null });
  if (state.skin !== skin.id) {
    setState({ idx: 0, dir: 1, skin: skin.id, file: null });
    setLocal(null);
  }
  const count = previews.length;
  const byFile = state.file ? previews.findIndex((p) => p.file === state.file) : -1;
  const idx = byFile >= 0 ? byFile : Math.min(state.idx, Math.max(0, count - 1));
  const current = hidden ? undefined : previews[idx];
  const show = (n: number, dir: number) => setState((s) => ({ ...s, idx: n, file: previews[n]?.file ?? null, dir }));
  const go = (next: number) => {
    if (!count) return;
    show((next + count) % count, next > idx ? 1 : -1);
  };

  // the window listener reads the latest list without re-subscribing on every render
  const live = useRef({ previews, idx });
  useLayoutEffect(() => {
    live.current = { previews, idx };
  });
  useEffect(() => {
    if (!keyboard) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea") || e.defaultPrevented || e.altKey || e.ctrlKey) return;
      const { previews: list, idx: at } = live.current;
      if (!list.length || (e.key !== "ArrowRight" && e.key !== "ArrowLeft")) return;
      const d = e.key === "ArrowRight" ? 1 : -1;
      const n = (at + d + list.length) % list.length;
      setState((s) => ({ ...s, idx: n, file: list[n].file, dir: d }));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keyboard]);

  /** Show `order` now and save it; the backend's answer (or a failure) ends the local order. */
  const commit = async (order: string[]) => {
    if (sameOrder(order, skin.previews.map((p) => p.file))) {
      setLocal(null);
      return;
    }
    setLocal(order);
    await reorder(skin.id, order);
    setLocal(null);
  };

  // ----- drag to reorder (pointer events: Tauri's file drop handling turns HTML5 drag and drop off on Windows) -----
  const thumbsRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ file: string; slots: Slot[]; order: string[] } | null>(null);
  const justDragged = useRef(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const refocus = useRef<string | null>(null);
  useEffect(() => {
    // a thumbnail moved with Alt+arrow keeps the focus
    if (!refocus.current) return;
    thumbsRef.current?.querySelector<HTMLElement>(`[data-thumb="${CSS.escape(refocus.current)}"]`)?.focus();
    refocus.current = null;
  });
  const onDragStart = (file: string) => {
    const box = thumbsRef.current;
    if (!box) return;
    // slot positions in layout coordinates (offsets ignore the transforms of thumbnails gliding around)
    const slots = [...box.querySelectorAll<HTMLElement>("[data-thumb]")].map((el) => ({ x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight }));
    drag.current = { file, slots, order: previews.map((p) => p.file) };
    setDragging(file);
    setState((s) => ({ ...s, idx, file: current?.file ?? null }));
    setLocal(drag.current.order);
  };
  const onDrag = (e: MouseEvent | TouchEvent | PointerEvent) => {
    const d = drag.current;
    const box = thumbsRef.current;
    if (!d || !box || !("clientX" in e)) return;
    const r = box.getBoundingClientRect();
    const slot = slotAt(d.slots, e.clientX - r.left, e.clientY - r.top);
    const from = d.order.indexOf(d.file);
    if (slot < 0 || from < 0 || slot === from) return;
    d.order = moveItem(d.order, from, Math.min(slot, d.order.length - 1));
    setLocal(d.order);
  };
  const onDragEnd = () => {
    const d = drag.current;
    drag.current = null;
    setDragging(null);
    justDragged.current = true;
    setTimeout(() => (justDragged.current = false), 0);
    if (d) void commit(d.order);
  };

  const [confirm, setConfirm] = useState<string | null>(null);
  const browse = async () => {
    const p = await api.pickImage();
    if (p) void addFiles(skin.id, [p]);
  };
  const hasLink = isGameBananaUrl(skin.gameBananaUrl ?? "");
  const slide = reduced ? 0 : 40;
  const caption = sourceCaption(previews);

  return (
    <div className={`gallery ${compact ? "gallery--compact" : ""}`} data-drop={hidden ? undefined : `skin:${skin.id}`}>
      <Flip flipKey={flip ? `skin:${skin.id}` : `gallery:${skin.id}:static`} className="gallery__main" reduced={reduced || !flip} radius={14}>
        {hidden && <div className="gallery__empty">Hidden while 18+ skins are hidden</div>}
        <AnimatePresence initial={false} custom={state.dir} mode="popLayout">
          {current && (
            <motion.img
              key={current.file}
              src={api.assetUrl(current.file)}
              alt={`${skin.name} preview ${idx + 1}`}
              decoding="async"
              draggable={false}
              custom={state.dir}
              variants={{
                enter: (d: number) => ({ opacity: 0, x: d * slide }),
                center: { opacity: 1, x: 0, transition: { ...spring.smooth, opacity: tween.small } },
                exit: (d: number) => ({ opacity: 0, x: d * -slide, transition: tween.small }),
              }}
              initial="enter"
              animate="center"
              exit="exit"
            />
          )}
        </AnimatePresence>
        <AnimatePresence initial={false}>
          {!hidden && !current && fetching && <CoverShimmer key="fetching" label="Fetching from GameBanana…" />}
          {!hidden && !current && !fetching && (
            <motion.div
              key="empty"
              className="gallery__empty gallery__empty--add"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: tween.small }}
              exit={{ opacity: 0, transition: tween.micro }}
            >
              <span className="gallery__plus">+</span>
              Add preview
              <span className="gallery__sub">Drop or paste an image</span>
              {manage ? (
                <span className="gallery__empty-actions">
                  <button type="button" className="btn btn--sm" onClick={() => void browse()}>
                    Browse…
                  </button>
                  <button type="button" className="btn btn--sm" onClick={() => void findInFolder(skin.id)} disabled={finding}>
                    {finding && <span className="spinner" aria-hidden />}
                    Find in mod folder
                  </button>
                  {canRetry(failed) && hasLink && (
                    <button type="button" className="btn btn--sm" onClick={() => void fetchGameBanana(skin.id)}>
                      Retry GameBanana
                    </button>
                  )}
                </span>
              ) : (
                canRetry(failed) && <RetryButton skinId={skin.id} label="Retry GameBanana" />
              )}
            </motion.div>
          )}
          {current && fetching && <CoverShimmer key="overlay" overlay />}
        </AnimatePresence>
        {current && (
          <span className="gallery__count num">
            Image {idx + 1} / {count}
          </span>
        )}
        {count > 1 && !hidden && (
          <>
            <button className="gallery__nav gallery__nav--prev" aria-label="Previous image" onClick={() => go(idx - 1)}>
              ‹
            </button>
            <button className="gallery__nav gallery__nav--next" aria-label="Next image" onClick={() => go(idx + 1)}>
              ›
            </button>
          </>
        )}
      </Flip>
      {!hidden && (
        <div ref={thumbsRef} className={`gallery__thumbs ${manage ? "gallery__thumbs--manage" : ""}`}>
          {(manage ? previews : previews.slice(0, compact ? 4 : 5)).map((p, i) => (
            <motion.button
              key={p.file}
              type="button"
              data-thumb={p.file}
              className={`gallery__thumb ${i === idx ? "is-on" : ""} ${dragging === p.file ? "gallery__thumb--dragging" : ""}`}
              aria-label={`Show image ${i + 1}${i === 0 ? " (cover)" : ""}`}
              title={manage && count > 1 ? "Drag to reorder · Alt+arrow keys move it" : undefined}
              layout={manage}
              transition={spring.smooth}
              drag={manage && count > 1}
              dragSnapToOrigin
              dragMomentum={false}
              whileDrag={reduced ? undefined : { scale: 1.06 }}
              onDragStart={() => onDragStart(p.file)}
              onDrag={onDrag}
              onDragEnd={onDragEnd}
              onClick={() => {
                if (!justDragged.current) go(i);
              }}
              onKeyDown={(e) => {
                if (!manage || !e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
                e.preventDefault();
                const to = i + (e.key === "ArrowLeft" ? -1 : 1);
                if (to < 0 || to >= count) return;
                refocus.current = p.file;
                setState((s) => ({ ...s, idx, file: current?.file ?? null }));
                void commit(moveItem(previews.map((x) => x.file), i, to));
              }}
            >
              <img src={api.assetUrl(p.file)} alt="" loading="lazy" decoding="async" draggable={false} />
              {manage && i === 0 && count > 1 && <span className="tag tag--muted gallery__thumb-cover">Cover</span>}
            </motion.button>
          ))}
          <button type="button" className="gallery__thumb gallery__thumb--drop" onClick={() => void browse()} title="Drop an image here, paste one with Ctrl+V, or click to browse">
            + drop / paste
          </button>
        </div>
      )}
      {!compact && !hidden && (
        <p className="gallery__caption">{caption ? `${caption} · the first is the card cover` : "No previews yet · drop or paste an image"}</p>
      )}
      {manage && (
        <div className="gallery__tools">
          {current && (
            <>
              <button type="button" className="btn btn--sm" onClick={() => void commit([current.file])} disabled={idx === 0}>
                Make cover
              </button>
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => setConfirm(current.file)}>
                Remove…
              </button>
            </>
          )}
          <span className="gallery__tools-spacer" />
          {current && (
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => void findInFolder(skin.id)} disabled={finding}>
              {finding && <span className="spinner" aria-hidden />}
              Find in mod folder
            </button>
          )}
          {hasLink && (current || !canRetry(failed)) && (
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => void fetchGameBanana(skin.id)} disabled={fetching}>
              {fetching && <span className="spinner" aria-hidden />}
              {fetching ? "Fetching from GameBanana" : "Get GameBanana images"}
            </button>
          )}
        </div>
      )}
      <ConfirmDialog
        open={!!confirm}
        title="Remove this preview?"
        body={<>The image file goes to the Recycle Bin.{confirm === previews[0]?.file && count > 1 ? " The next image becomes the card cover." : ""}</>}
        confirmLabel="Move to Recycle Bin"
        danger
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const file = confirm;
          setConfirm(null);
          if (!file) return;
          // the image that takes its place slides in from the right
          const at = previews.findIndex((p) => p.file === file);
          setState((s) => ({ ...s, idx: Math.max(0, at), file: null, dir: 1 }));
          void remove(skin.id, file);
        }}
      />
    </div>
  );
}
