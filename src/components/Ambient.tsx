import { AnimatePresence, motion } from "motion/react";
import { api } from "../api";
import type { Skin } from "../api/types";
import { useAmbient } from "../lib/ambient";
import { tween } from "../motion";
import "./Ambient.css";

/**
 * A soft glow in the active cover's colour, laid behind a surface (the open shelf, the A2 header, the A3 detail).
 * Crossfades when the colour changes; opacity only, so it works the same with reduced motion.
 */
export function Ambient({ url, variant }: { url?: string | null; variant: "shelf" | "header" | "detail" }) {
  const color = useAmbient(url);
  return (
    <div className={`ambient ambient--${variant}`} aria-hidden>
      <AnimatePresence initial={false}>
        {color && (
          <motion.div
            key={color}
            className="ambient__glow"
            style={{ ["--ambient" as string]: color }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: tween.glow }}
            exit={{ opacity: 0, transition: tween.glow }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

/** The cover URL a glow samples: the skin's first preview. Pass `hidden` for an 18+ skin while hidden: no glow. */
export function coverUrl(skin: Skin | null | undefined, hidden?: boolean): string | null {
  const first = skin?.previews[0];
  return first && !hidden ? api.assetUrl(first.file) : null;
}
