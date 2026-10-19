import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { api } from "../api";
import type { Skin } from "../api/types";
import { spring, tween } from "../motion";
import { Flip } from "./Flip";
import "./Gallery.css";

/** Preview gallery (SPEC §6 A3/C3, §10): main image, thumbnails, sources caption; ←/→ step with a direction-aware slide. */
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
  const [state, setState] = useState({ idx: 0, dir: 1, skin: skin.id });
  if (state.skin !== skin.id) setState({ idx: 0, dir: 1, skin: skin.id });
  const count = skin.previews.length;
  const idx = Math.min(state.idx, Math.max(0, count - 1));
  const go = (next: number) => {
    if (!count) return;
    const n = (next + count) % count;
    setState((s) => ({ ...s, idx: n, dir: next > s.idx ? 1 : -1 }));
  };

  useEffect(() => {
    if (!keyboard) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea") || e.defaultPrevented) return;
      if (e.key === "ArrowRight") setState((s) => (count ? { ...s, idx: (s.idx + 1) % count, dir: 1 } : s));
      if (e.key === "ArrowLeft") setState((s) => (count ? { ...s, idx: (s.idx - 1 + count) % count, dir: -1 } : s));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keyboard, count]);

  const sources = summarize(skin);
  const current = skin.previews[idx];
  const slide = reduced ? 0 : 40;

  return (
    <div className={`gallery ${compact ? "gallery--compact" : ""}`}>
      <Flip flipKey={flip ? `skin:${skin.id}` : `gallery:${skin.id}:static`} className="gallery__main" reduced={reduced || !flip} radius={14}>
        {hidden ? (
          <div className="gallery__empty">Hidden while 18+ skins are hidden</div>
        ) : !current ? (
          <div className="gallery__empty gallery__empty--add">
            <span className="gallery__plus">+</span>
            Add preview
            <span className="gallery__sub">Drop or paste an image</span>
          </div>
        ) : (
          <AnimatePresence initial={false} custom={state.dir} mode="popLayout">
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
          </AnimatePresence>
        )}
        {count > 0 && !hidden && (
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
        <div className="gallery__thumbs">
          {skin.previews.slice(0, compact ? 4 : 5).map((p, i) => (
            <button
              key={p.file}
              className={`gallery__thumb ${i === idx ? "is-on" : ""}`}
              aria-label={`Show image ${i + 1}`}
              onClick={() => go(i)}
            >
              <img src={api.assetUrl(p.file)} alt="" loading="lazy" decoding="async" draggable={false} />
            </button>
          ))}
          <div className="gallery__thumb gallery__thumb--drop">+ drop / paste</div>
        </div>
      )}
      {!compact && !hidden && <p className="gallery__caption">{sources}</p>}
    </div>
  );
}

function summarize(skin: Skin): string {
  const n = (src: string) => skin.previews.filter((p) => p.source === src).length;
  const parts = [
    n("gamebanana") && `${n("gamebanana")} from GameBanana`,
    n("archive") && `${n("archive")} found in archive`,
    n("user") && `${n("user")} added by you`,
  ].filter(Boolean);
  if (!parts.length) return "No previews yet · drop or paste an image";
  return `Sources: ${parts.join(" · ")} · first = card cover`;
}
