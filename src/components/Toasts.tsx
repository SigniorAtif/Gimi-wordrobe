import { AnimatePresence, motion, useAnimate } from "motion/react";
import { useEffect } from "react";
import { shake, spring, tween } from "../motion";
import { useReduced } from "../lib/useReduced";
import { useApp, type Toast } from "../store/app";
import "./Toasts.css";

/** Bottom-right toast stack (§6, §7 "Toasts / errors"). */
export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} />
        ))}
      </AnimatePresence>
    </div>
  );
}

function ToastItem({ toast }: { toast: Toast }) {
  const reduced = useReduced();
  const dismiss = useApp((s) => s.dismissToast);
  const [scope, animate] = useAnimate();

  useEffect(() => {
    if (toast.kind === "error" && !reduced && scope.current) {
      const t = setTimeout(() => animate(scope.current, shake), 180);
      return () => clearTimeout(t);
    }
  }, [toast.kind, reduced, animate, scope]);

  return (
    <motion.div
      layout
      className={`toast toast--${toast.kind}`}
      role={toast.kind === "error" ? "alert" : "status"}
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: 24, x: 12, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, x: 0, scale: 1, transition: { ...spring.snappy, opacity: tween.small } }}
      exit={{ opacity: 0, transition: tween.small }}
    >
      <div ref={scope} className="toast__body">
        <span className="toast__icon" aria-hidden>
          {toast.kind === "success" ? <Check /> : toast.kind === "error" ? "!" : "i"}
        </span>
        <div className="toast__text">
          <ToastText text={toast.text} />
          {toast.detail && <div className="toast__detail">{toast.detail}</div>}
        </div>
        <button className="toast__close" aria-label="Dismiss" onClick={() => dismiss(toast.id)}>
          ×
        </button>
      </div>
    </motion.div>
  );
}

/** Renders "F10" (or any [[key]]) as a keycap. */
function ToastText({ text }: { text: string }) {
  const parts = text.split(/(\[\[[^\]]+\]\])/g);
  return (
    <div className="toast__title">
      {parts.map((p, i) =>
        p.startsWith("[[") ? (
          <kbd key={i} className="kbd kbd--sm">
            {p.slice(2, -2)}
          </kbd>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </div>
  );
}

export function Check({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <motion.path
        d="M3.5 8.5l3 3 6-7"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1], delay: 0.08 }}
      />
    </svg>
  );
}
