import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { api } from "../api";
import type { Skin } from "../api/types";
import { hueFor } from "../lib/derive";
import { canRetry } from "../lib/previews";
import { useReduced } from "../lib/useReduced";
import { tween } from "../motion";
import { usePreviews, usePreviewStatus } from "../store/previews";
import { Flip } from "./Flip";
import "./Cover.css";
import "./Previews.css";

/**
 * A skin's 3:4 cover (SPEC §2, §10): the first preview, a neutral placeholder for NSFW while hidden, or the empty
 * "+ Add preview" state. While a GameBanana fetch runs it shimmers ("Fetching from GameBanana…"); after a failed
 * fetch the empty state offers "Retry".
 */
export function Cover({
  skin,
  hidden,
  label,
  className,
  flip,
  reduced = false,
}: {
  skin: Skin;
  hidden?: boolean;
  label?: boolean;
  className?: string;
  /** morphs to/from the A3 big preview (SPEC §7) */
  flip?: boolean;
  reduced?: boolean;
}) {
  const first = skin.previews[0];
  const { fetching, failed } = usePreviewStatus(skin.id);
  // a cover that changes after mount (a fetch, a drop, "Make cover") fades in instead of popping
  const [mountFile] = useState(first?.file);
  const fadeIn = !!first && first.file !== mountFile;
  if (hidden) {
    return (
      <div className={`cover cover--hidden ${className ?? ""}`}>
        <span className="cover__note">Hidden</span>
      </div>
    );
  }
  if (!first) {
    return (
      <div
        className={`cover cover--empty ${fetching ? "cover--fetching" : ""} ${className ?? ""}`}
        style={{ ["--hue" as string]: hueFor(skin.id) }}
        aria-busy={fetching || undefined}
      >
        <AnimatePresence initial={false}>
          {fetching ? (
            <CoverShimmer key="fetching" label="Fetching from GameBanana…" />
          ) : (
            <motion.span
              key="empty"
              className="cover__empty-body"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: tween.small }}
              exit={{ opacity: 0, transition: tween.micro }}
            >
              <span className="cover__note">+ Add preview</span>
              {canRetry(failed) && <RetryButton skinId={skin.id} />}
            </motion.span>
          )}
        </AnimatePresence>
        {label && <span className="cover__name">{skin.name}</span>}
      </div>
    );
  }
  return (
    <Flip flipKey={flip ? `skin:${skin.id}` : `cover:${skin.id}:static`} className={`cover ${className ?? ""}`} reduced={reduced || !flip} radius={10}>
      <motion.img
        key={first.file}
        src={api.assetUrl(first.file)}
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
        initial={fadeIn ? { opacity: 0 } : false}
        animate={{ opacity: 1, transition: tween.medium }}
      />
      <AnimatePresence>{fetching && <CoverShimmer key="fetching" overlay />}</AnimatePresence>
      {label && <span className="cover__name">{skin.name}</span>}
    </Flip>
  );
}

/**
 * The loading skeleton for previews (SPEC §7 "Loading states"): a light band sweeps across with transform only.
 * Reduced motion keeps a still surface that breathes in opacity. `overlay` lays a thin sweep over an existing image.
 */
export function CoverShimmer({ label, overlay }: { label?: string; overlay?: boolean }) {
  const reduced = useReduced();
  return (
    <motion.span
      className={`cover-shimmer ${overlay ? "cover-shimmer--overlay" : ""} ${reduced ? "cover-shimmer--still" : ""}`}
      role="status"
      aria-label={label ?? "Fetching from GameBanana"}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, transition: tween.small }}
      exit={{ opacity: 0, transition: tween.small }}
    >
      {label && <span className="cover-shimmer__label">{label}</span>}
    </motion.span>
  );
}

/** "Retry" after a failed GameBanana fetch. Sits above a card's click target, so it doesn't pick the skin. */
export function RetryButton({ skinId, label = "Retry" }: { skinId: string; label?: string }) {
  const fetchGameBanana = usePreviews((s) => s.fetchGameBanana);
  return (
    <button
      type="button"
      className="link cover__retry"
      onClick={(e) => {
        e.stopPropagation();
        void fetchGameBanana(skinId);
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {label}
    </button>
  );
}
