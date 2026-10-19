import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { tween } from "../motion";

const MOD_KEYS = new Set(["Control", "Alt", "Shift", "Meta", "OS"]);

export function comboFromEvent(e: KeyboardEvent): string | null {
  if (MOD_KEYS.has(e.key)) return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  let key = e.code.startsWith("Key") ? e.code.slice(3) : e.code.startsWith("Digit") ? e.code.slice(5) : e.key;
  if (key.length === 1) key = key.toUpperCase();
  parts.push(key);
  return parts.join("+");
}

/** True when a keyboard event matches a stored combo like "Ctrl+H". */
export function matchesCombo(e: KeyboardEvent, combo: string): boolean {
  const c = comboFromEvent(e);
  return !!c && c.toLowerCase() === combo.toLowerCase();
}

export function KeyCombo({ combo, small }: { combo: string; small?: boolean }) {
  const parts = combo.split("+");
  return (
    <span className="key-combo">
      {parts.map((p, i) => (
        <span key={i}>
          {i > 0 && <span className="kbd-plus">+</span>}
          <kbd className={`kbd ${small ? "kbd--sm" : ""}`}>{p}</kbd>
        </span>
      ))}
    </span>
  );
}

/** Click-to-record hotkey field (Settings › NSFW). Needs Ctrl or Alt so typing-to-search keeps working. */
export function HotkeyRecorder({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [recording, setRecording] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(false);
        setHint(null);
        return;
      }
      const combo = comboFromEvent(e);
      if (!combo) return;
      if (!e.ctrlKey && !e.altKey) {
        setHint("Use Ctrl or Alt with a key, so typing still searches.");
        return;
      }
      setRecording(false);
      setHint(null);
      onChange(combo);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, onChange]);

  return (
    <div className="hotkey-rec">
      <div className="hotkey-rec__row">
        <AnimatePresence mode="wait" initial={false}>
          {recording ? (
            <motion.span key="rec" className="hotkey-rec__listening" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={tween.micro}>
              Press a key combination… <span className="hotkey-rec__esc">Esc to cancel</span>
            </motion.span>
          ) : (
            <motion.span key="val" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={tween.micro}>
              <KeyCombo combo={value} />
            </motion.span>
          )}
        </AnimatePresence>
        <button type="button" className="btn btn--sm" onClick={() => setRecording((r) => !r)} aria-pressed={recording}>
          {recording ? "Cancel" : "Change…"}
        </button>
      </div>
      {hint && <div className="field__hint hotkey-rec__hint">{hint}</div>}
    </div>
  );
}
