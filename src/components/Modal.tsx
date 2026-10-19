import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { spring, tween } from "../motion";
import { useReduced } from "../lib/useReduced";
import "./Modal.css";

/** Modal dialog (SPEC §7): backdrop fades and blurs in, the dialog scales 0.96 -> 1; exit reverses. */
export function Modal({
  open,
  onClose,
  children,
  label,
  width = 440,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  label: string;
  width?: number;
}) {
  const reduced = useReduced();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const t = setTimeout(() => ref.current?.querySelector<HTMLElement>("[data-autofocus], button")?.focus(), 30);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      clearTimeout(t);
      window.removeEventListener("keydown", onKey, true);
      prev?.focus?.();
    };
  }, [open, onClose]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div className="modal" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: tween.small }} exit={{ opacity: 0, transition: tween.small }}>
          <motion.div
            className="modal__backdrop"
            onPointerDown={onClose}
            initial={reduced ? { opacity: 0 } : { opacity: 0, backdropFilter: "blur(0px)" }}
            animate={reduced ? { opacity: 1 } : { opacity: 1, backdropFilter: "blur(6px)", transition: tween.medium }}
            exit={{ opacity: 0, transition: tween.small }}
          />
          <motion.div
            ref={ref}
            role="dialog"
            aria-modal="true"
            aria-label={label}
            className="modal__dialog"
            style={{ width }}
            initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 6 }}
            animate={{ opacity: 1, scale: 1, y: 0, transition: { ...spring.snappy, opacity: tween.small } }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.97, transition: tween.small }}
          >
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  danger,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal open={open} onClose={onCancel} label={title}>
      <div className="confirm">
        <h2 className="confirm__title">{title}</h2>
        <div className="confirm__body">{body}</div>
        <div className="confirm__actions">
          <button className="btn" onClick={onCancel} data-autofocus>
            Cancel
          </button>
          <button className={`btn ${danger ? "btn--danger" : "btn--primary"}`} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
