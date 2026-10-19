// Small form controls shared by Settings, Setup and dialogs.
import { AnimatePresence, motion } from "motion/react";
import { useId, useState, type ReactNode } from "react";
import { spring } from "../motion";
import "./controls.css";

/** Segmented control with a sliding selection pill (layoutId). */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  const id = useId();
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            className="segmented__opt"
            onClick={() => onChange(o.value)}
          >
            {on && (
              <motion.span layoutId={`seg-${id}`} layoutDependency={value} className="segmented__pill" transition={spring.snappy} />
            )}
            <span className="segmented__label">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** A radio option row: dot + label + optional hint. The dot pops when selected. */
export function RadioOption({
  checked,
  onSelect,
  label,
  hint,
  name,
  children,
}: {
  checked: boolean;
  onSelect: () => void;
  label: ReactNode;
  hint?: ReactNode;
  name: string;
  children?: ReactNode;
}) {
  return (
    <label className={`radio-opt ${checked ? "is-on" : ""}`}>
      <input type="radio" className="visually-hidden" name={name} checked={checked} onChange={onSelect} />
      <RadioDot checked={checked} />
      <span className="radio-opt__text">
        <span className="radio-opt__label">{label}</span>
        {hint && <span className="radio-opt__hint">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

/** Radio dot whose fill springs in when it becomes checked (not on first mount) and shrinks out when unchecked. */
export function RadioDot({ checked, pending }: { checked: boolean; pending?: boolean }) {
  return (
    <span className="radio" data-on={checked} data-pending={!!pending}>
      <AnimatePresence initial={false}>
        {checked && (
          <motion.span
            key="fill"
            className="radio__fill"
            initial={{ scale: 0 }}
            animate={{ scale: 1, transition: { type: "spring", stiffness: 600, damping: 22 } }}
            exit={{ scale: 0, transition: { duration: 0.12 } }}
          />
        )}
      </AnimatePresence>
    </span>
  );
}

/** Path text field + Browse. Commits on blur or Enter, so typing doesn't re-scan on every key. */
export function PathField({
  value,
  onCommit,
  onBrowse,
  placeholder,
  label,
  disabled,
}: {
  value: string;
  onCommit: (v: string) => void;
  onBrowse: () => void;
  placeholder?: string;
  label: string;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    // the saved value changed underneath us (Browse, re-scan): show it
    setSeen(value);
    setDraft(value);
  }
  const commit = () => {
    if (draft.trim() !== value.trim()) onCommit(draft.trim());
  };
  return (
    <div className="path-field">
      <input
        className="input input--mono"
        value={draft}
        placeholder={placeholder}
        aria-label={label}
        spellCheck={false}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setDraft(value);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      <button type="button" className="btn" onClick={onBrowse} disabled={disabled}>
        Browse…
      </button>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="field">
      <div className="field__label caps">{label}</div>
      {children}
      {hint && <div className="field__hint">{hint}</div>}
    </div>
  );
}
