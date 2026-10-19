import { motion } from "motion/react";
import { spring } from "../motion";

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className="switch"
      onClick={() => onChange(!checked)}
    >
      <motion.span className="switch__knob" animate={{ x: checked ? 16 : 0 }} transition={spring.snappy} />
    </button>
  );
}
