import { AnimatePresence, motion } from "motion/react";
import { useMemo, useState } from "react";
import { pendingItems } from "../lib/derive";
import { useReduced } from "../lib/useReduced";
import { spring, tween } from "../motion";
import { useApp } from "../store/app";
import { useHome, type ApplyState } from "../store/home";
import { AnimatedNumber } from "./AnimatedNumber";
import { Check } from "./Toasts";
import "./PendingBar.css";

/**
 * Global pending bar (SPEC §6, §7): slides up while there are pending picks, ticks the count, slides diff items in,
 * collapses them on Discard, and morphs Apply into progress then a check mark.
 */
export function PendingBar() {
  const snapshot = useApp((s) => s.snapshot);
  const picks = useHome((s) => s.picks);
  const nsfwVisible = useHome((s) => s.nsfwVisible);
  const applyState = useHome((s) => s.applyState);
  const apply = useHome((s) => s.apply);
  const discard = useHome((s) => s.discard);
  const reduced = useReduced();
  const live = useMemo(() => (snapshot ? pendingItems(snapshot, picks, nsfwVisible) : []), [snapshot, picks, nsfwVisible]);
  // freeze the diff while applying: the fresh snapshot lands before the picks clear
  const [frozen, setFrozen] = useState<typeof live | null>(null);
  const [phase, setPhase] = useState(applyState.phase);
  if (phase !== applyState.phase) {
    setPhase(applyState.phase);
    setFrozen(applyState.phase === "idle" ? null : (frozen ?? live));
  }
  const items = frozen ?? live;
  const visible = items.length > 0 || applyState.phase !== "idle";
  const busy = applyState.phase !== "idle";

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          className="pending"
          role="region"
          aria-label="Pending changes"
          initial={reduced ? { opacity: 0 } : { y: "110%", opacity: 0.6 }}
          animate={{ y: 0, opacity: 1, transition: { ...spring.smooth, opacity: tween.small } }}
          exit={reduced ? { opacity: 0, transition: tween.small } : { y: "110%", opacity: 0, transition: { ...spring.smooth, opacity: tween.small } }}
        >
          <span className="pending__count tag tag--pending">
            <AnimatedNumber value={items.length} /> pending
          </span>
          <ul className="pending__items">
            <AnimatePresence initial={false} mode="popLayout">
              {items.map((it) => (
                <motion.li
                  key={it.entityId}
                  layout="position"
                  className="pending__item"
                  initial={reduced ? { opacity: 0 } : { opacity: 0, x: 14 }}
                  animate={{ opacity: 1, x: 0, transition: spring.snappy }}
                  exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.9, transition: tween.small }}
                >
                  <span className="pending__entity">{it.entityName}:</span> {it.from} <span className="pending__arrow">→</span>{" "}
                  <span className="pending__to">{it.to}</span>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
          <div className="pending__actions">
            <button className="btn" onClick={discard} disabled={busy}>
              Discard
            </button>
            <ApplyButton state={applyState} reduced={reduced} onApply={() => void apply()} />
          </div>
          {applyState.phase === "running" && applyState.total > 0 && (
            <motion.span
              className="pending__progress"
              initial={{ scaleX: 0 }}
              animate={{ scaleX: Math.max(0.04, applyState.done / applyState.total), transition: spring.smooth }}
            />
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function ApplyButton({ state, reduced, onApply }: { state: ApplyState; reduced: boolean; onApply: () => void }) {
  const busy = state.phase !== "idle";
  const label =
    state.phase === "running"
      ? state.total > 0
        ? `Applying ${Math.min(state.done + 1, state.total)}/${state.total}`
        : "Applying…"
      : state.phase === "done"
        ? "Applied"
        : "Apply";
  return (
    <button
      className={`btn btn--primary pending__apply is-${state.phase}`}
      onClick={onApply}
      disabled={busy}
      aria-live="polite"
      title={state.phase === "running" ? state.label : "Apply (Ctrl+S)"}
    >
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={state.phase}
          className="pending__apply-inner"
          initial={{ opacity: 0, y: reduced ? 0 : 8 }}
          animate={{ opacity: 1, y: 0, transition: tween.small }}
          exit={{ opacity: 0, y: reduced ? 0 : -8, transition: tween.micro }}
        >
          {state.phase === "running" && <span className="spinner" aria-hidden />}
          {state.phase === "done" && <Check size={15} />}
          <span>{label}</span>
        </motion.span>
      </AnimatePresence>
    </button>
  );
}
