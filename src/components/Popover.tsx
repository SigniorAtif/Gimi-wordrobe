import { AnimatePresence, motion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { spring, tween } from "../motion";
import { useReduced } from "../lib/useReduced";
import "./Popover.css";

export type Anchor = { x: number; y: number } | DOMRect;

function anchorPoint(a: Anchor): { x: number; y: number; w: number; h: number } {
  return "width" in a ? { x: a.left, y: a.top, w: a.width, h: a.height } : { x: a.x, y: a.y, w: 0, h: 0 };
}

/**
 * Floating panel anchored to an element or the cursor. Scales in from the anchor (transform-origin at the trigger,
 * SPEC §7) and closes on outside click, Esc, scroll or resize.
 */
export function Popover({
  open,
  anchor,
  onClose,
  children,
  align = "start",
  className,
  label,
}: {
  open: boolean;
  anchor: Anchor | null;
  onClose: () => void;
  children: ReactNode;
  align?: "start" | "end";
  className?: string;
  label?: string;
}) {
  const reduced = useReduced();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; origin: string } | null>(null);

  useLayoutEffect(() => {
    if (!open || !anchor || !ref.current) return;
    const a = anchorPoint(anchor);
    const box = ref.current.getBoundingClientRect();
    const margin = 8;
    let left = align === "end" ? a.x + a.w - box.width : a.x;
    left = Math.max(margin, Math.min(left, window.innerWidth - box.width - margin));
    let top = a.y + a.h + 6;
    let below = true;
    if (top + box.height > window.innerHeight - margin) {
      top = Math.max(margin, a.y - box.height - 6);
      below = false;
    }
    const ox = Math.max(0, Math.min(box.width, a.x + a.w / 2 - left));
    setPos({ left, top, origin: `${ox}px ${below ? 0 : box.height}px` });
  }, [open, anchor, align]);

  useEffect(() => {
    if (!open) return;
    // keyboard users land on the first item and get it back to the trigger on close
    const trigger = document.activeElement as HTMLElement | null;
    const items = () => [...(ref.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)') ?? [])];
    const focusT = setTimeout(() => items()[0]?.focus(), 20);
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        trigger?.focus?.();
        return;
      }
      if (e.key === "Tab") {
        onClose();
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
        const list = items();
        if (!list.length) return;
        e.preventDefault();
        e.stopPropagation();
        const i = list.indexOf(document.activeElement as HTMLElement);
        const next =
          e.key === "Home" ? 0 : e.key === "End" ? list.length - 1 : e.key === "ArrowDown" ? (i + 1) % list.length : (i - 1 + list.length) % list.length;
        list[next]?.focus();
      }
    };
    const onScroll = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onClose);
    return () => {
      clearTimeout(focusT);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onClose);
    };
  }, [open, onClose]);

  return createPortal(
    <AnimatePresence>
      {open && anchor && (
        <motion.div
          ref={ref}
          role="menu"
          aria-label={label}
          className={`popover ${className ?? ""}`}
          style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, transformOrigin: pos?.origin ?? "0 0" }}
          initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.92 }}
          animate={{ opacity: 1, scale: 1, transition: { ...spring.snappy, opacity: tween.micro } }}
          exit={{ opacity: 0, scale: reduced ? 1 : 0.96, transition: tween.micro }}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

export function MenuItem({
  children,
  onSelect,
  danger,
  disabled,
  checked,
}: {
  children: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  checked?: boolean;
}) {
  return (
    <button
      type="button"
      role={checked === undefined ? "menuitem" : "menuitemradio"}
      aria-checked={checked}
      className={`menu-item ${danger ? "menu-item--danger" : ""}`}
      disabled={disabled}
      onClick={onSelect}
    >
      {checked !== undefined && <span className={`menu-item__dot ${checked ? "is-on" : ""}`} aria-hidden />}
      <span className="menu-item__label">{children}</span>
    </button>
  );
}

export function MenuSeparator() {
  return <div className="menu-sep" role="separator" />;
}
