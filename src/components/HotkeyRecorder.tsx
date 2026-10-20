import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { comboFromKey, revealHotkeyProblem } from "../lib/shortcuts";
import { tween } from "../motion";

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

/**
 * Click-to-record hotkey field (Settings › NSFW reveal hotkey). It needs Ctrl or Alt, so typing still searches, and
 * may not take another app shortcut (Ctrl+S, Ctrl+Z…); a refused combo shows why and keeps listening.
 */
export function HotkeyRecorder({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [recording, setRecording] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!recording) return;
    const stop = () => {
      setRecording(false);
      setHint(null);
    };
    // clicking elsewhere or leaving the window cancels, so keys are never trapped
    const onDown = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) stop();
    };
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(false);
        setHint(null);
        return;
      }
      const combo = comboFromKey(e);
      if (!combo) return;
      const problem = revealHotkeyProblem(combo);
      if (problem) {
        setHint(problem.message);
        return;
      }
      setRecording(false);
      setHint(null);
      onChange(combo);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("blur", stop);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("blur", stop);
    };
  }, [recording, onChange]);

  return (
    <div className="hotkey-rec" ref={box}>
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
      <AnimatePresence initial={false} mode="wait">
        {hint && (
          <motion.div
            key={hint}
            className="field__hint hotkey-rec__hint"
            role="alert"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: tween.small }}
            exit={{ opacity: 0, transition: tween.micro }}
          >
            {hint}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
