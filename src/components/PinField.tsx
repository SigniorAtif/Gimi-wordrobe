import { AnimatePresence, motion } from "motion/react";
import { forwardRef, useCallback, useSyncExternalStore } from "react";
import { PIN_MAX, PIN_MIN, pinDigits } from "../lib/pin";
import { useReduced } from "../lib/useReduced";
import { spring, tween } from "../motion";
import "./PinField.css";

/**
 * 4-6 digit PIN field drawn as six slots (the last two dashed, since they are optional). The real input lies on top,
 * invisible, so typing, paste and screen readers work as usual.
 */
export const PinInput = forwardRef<
  HTMLInputElement,
  {
    value: string;
    onChange: (v: string) => void;
    onSubmit?: () => void;
    label: string;
    disabled?: boolean;
    invalid?: boolean;
    autoFocus?: boolean;
  }
>(function PinInput({ value, onChange, onSubmit, label, disabled, invalid, autoFocus }, ref) {
  return (
    <label className={`pin ${invalid ? "is-invalid" : ""} ${disabled ? "is-disabled" : ""}`}>
      <input
        ref={ref}
        className="pin__input"
        type="password"
        inputMode="numeric"
        autoComplete="off"
        maxLength={PIN_MAX}
        aria-label={label}
        aria-invalid={invalid || undefined}
        value={value}
        disabled={disabled}
        data-autofocus={autoFocus || undefined}
        onChange={(e) => onChange(pinDigits(e.target.value))}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onSubmit?.();
          }
        }}
      />
      <span className="pin__slots" aria-hidden>
        {Array.from({ length: PIN_MAX }, (_, i) => (
          <span
            key={i}
            className={`pin__slot ${i >= PIN_MIN ? "is-optional" : ""} ${i === Math.min(value.length, PIN_MAX - 1) ? "is-next" : ""}`}
          >
            <AnimatePresence initial={false}>
              {i < value.length && (
                <motion.span
                  className="pin__dot"
                  initial={{ scale: 0.3, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1, transition: spring.snappy }}
                  exit={{ scale: 0.3, opacity: 0, transition: tween.micro }}
                />
              )}
            </AnimatePresence>
          </span>
        ))}
      </span>
    </label>
  );
});

/**
 * One line under a PIN field. `id` keys the crossfade, so a ticking countdown updates in place instead of fading on
 * every second.
 */
export function PinMessage({ id, text, kind = "error" }: { id?: string; text: string | null; kind?: "error" | "info" }) {
  const reduced = useReduced();
  return (
    <div className="pin-msg" aria-live="polite">
      <AnimatePresence mode="wait" initial={false}>
        {text && (
          <motion.span
            key={id ?? text}
            className={`pin-msg__text pin-msg__text--${kind}`}
            role={kind === "error" ? "alert" : undefined}
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0, transition: tween.small }}
            exit={{ opacity: 0, transition: tween.micro }}
          >
            {text}
          </motion.span>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Whole seconds until `until` (ms since epoch), ticking while it counts down; 0 once it has passed. */
export function useSecondsLeft(until: number): number {
  const subscribe = useCallback(
    (tick: () => void) => {
      if (until <= Date.now()) return () => {};
      const t = setInterval(() => {
        tick();
        if (Date.now() >= until) clearInterval(t);
      }, 250);
      return () => clearInterval(t);
    },
    [until],
  );
  // a number, so React re-renders only when the whole seconds change
  return useSyncExternalStore(subscribe, () => Math.max(0, Math.ceil((until - Date.now()) / 1000)));
}
