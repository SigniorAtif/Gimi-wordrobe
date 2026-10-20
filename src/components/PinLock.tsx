import { AnimatePresence, motion, useAnimate } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { api, toFailure } from "../api";
import { isValidPin, lockoutText, PIN_MAX, PIN_MIN, retryFromMessage, setPinErrorText } from "../lib/pin";
import { useRedact } from "../lib/useRedact";
import { useReduced } from "../lib/useReduced";
import { shake, tween } from "../motion";
import { useApp } from "../store/app";
import { useHome } from "../store/home";
import { AutoHeight } from "./AutoHeight";
import { PinInput, PinMessage, useSecondsLeft } from "./PinField";
import { Switch } from "./Switch";
import "./PinLock.css";

type Mode = "idle" | "set" | "change" | "remove";

/** Settings › PIN lock (SPEC §6): set, change or remove a 4-6 digit PIN. Changing or removing asks for the current one. */
export function PinLock() {
  const pinSet = useApp((s) => s.snapshot?.pinSet ?? false);
  const hotkey = useApp((s) => s.snapshot?.settings.nsfw.hotkey ?? "Ctrl+H");
  const reduced = useReduced();
  const [mode, setMode] = useState<Mode>("idle");
  return (
    <div className="pin-lock">
      <div className="setting-row">
        <span className="setting-row__label">Require a PIN</span>
        <div className="setting-row__inline">
          <Switch
            label="Require a PIN to show 18+ skins"
            checked={mode === "set" || (pinSet && mode !== "remove")}
            onChange={(on) => setMode(on ? (pinSet ? "idle" : "set") : pinSet ? "remove" : "idle")}
          />
          <span className="field__hint">{pinSet ? `${hotkey} asks for it` : "to show 18+ skins; a soft lock, not encryption"}</span>
          <AnimatePresence initial={false}>
            {pinSet && mode === "idle" && (
              <motion.button
                key="change"
                type="button"
                className="btn btn--sm pin-lock__change"
                onClick={() => setMode("change")}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1, transition: tween.small }}
                exit={{ opacity: 0, transition: tween.micro }}
              >
                Change PIN
              </motion.button>
            )}
          </AnimatePresence>
        </div>
      </div>
      <AutoHeight reduced={reduced}>
        <AnimatePresence initial={false} mode="wait">
          {mode !== "idle" && (
            <motion.div
              key={mode}
              initial={reduced ? { opacity: 0 } : { opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0, transition: tween.small }}
              exit={{ opacity: 0, transition: tween.micro }}
            >
              <PinForm mode={mode} hotkey={hotkey} onDone={() => setMode("idle")} />
            </motion.div>
          )}
        </AnimatePresence>
      </AutoHeight>
    </div>
  );
}

function PinForm({ mode, hotkey, onDone }: { mode: Exclude<Mode, "idle">; hotkey: string; onDone: () => void }) {
  const reduced = useReduced();
  const redact = useRedact();
  const setSnapshot = useApp((s) => s.setSnapshot);
  const toast = useApp((s) => s.toast);
  const retryAt = useHome((s) => s.pinRetryAt);
  const [scope, animate] = useAnimate<HTMLDivElement>();
  const currentInput = useRef<HTMLInputElement>(null);
  const nextInput = useRef<HTMLInputElement>(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const needsCurrent = mode !== "set";
  const needsNext = mode !== "remove";
  // wrong guesses here count towards the same lockout as the reveal prompt
  const wait = useSecondsLeft(needsCurrent ? retryAt : 0);
  const locked = wait > 0;

  // the form opens from the switch or "Change PIN": typing goes straight into its first field
  useEffect(() => {
    (needsCurrent ? currentInput : nextInput).current?.focus({ preventScroll: true });
  }, [needsCurrent]);

  const submit = async () => {
    if (busy || locked) return;
    if (needsCurrent && current.length < PIN_MIN) return setError("Enter the current PIN.");
    if (needsNext && !isValidPin(next)) return setError(setPinErrorText("pin_invalid", ""));
    if (needsNext && next !== again) return setError("The two PINs don't match.");
    setBusy(true);
    try {
      const snap = await api.setPin(needsCurrent ? current : null, needsNext ? next : null);
      setSnapshot(snap);
      useHome.setState({ pinRetryAt: 0 });
      toast({ kind: "success", text: mode === "set" ? `PIN set. ${hotkey} now asks for it.` : mode === "change" ? "PIN changed." : "PIN removed." });
      onDone();
    } catch (e) {
      const f = toFailure(e);
      if (f.code === "pin_locked") {
        useHome.setState({ pinRetryAt: Date.now() + (retryFromMessage(f.message) || 30) * 1000 });
        setError(null);
      } else {
        setError(redact(setPinErrorText(f.code, f.message)));
      }
      if (f.code === "pin_wrong" || f.code === "pin_locked") {
        setCurrent("");
        if (f.code === "pin_wrong") currentInput.current?.focus();
        if (!reduced && scope.current) void animate(scope.current, shake);
      }
    } finally {
      setBusy(false);
    }
  };

  const action = mode === "set" ? "Set PIN" : mode === "change" ? "Save PIN" : "Remove PIN";
  const message = locked ? lockoutText(wait) : error;
  return (
    <form
      className="pin-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {needsCurrent && (
        <div className="pin-form__field">
          <span className="pin-form__label">Current PIN</span>
          <div ref={scope} className="pin-form__input">
            <PinInput
              ref={currentInput}
              label="Current PIN"
              value={current}
              disabled={locked}
              invalid={!!error && !current}
              onChange={(v) => {
                setCurrent(v);
                setError(null);
              }}
              onSubmit={() => void submit()}
            />
          </div>
        </div>
      )}
      {needsNext && (
        <>
          <div className="pin-form__field">
            <span className="pin-form__label">{mode === "change" ? "New PIN" : "PIN"}</span>
            <div className="pin-form__input">
              <PinInput
                ref={nextInput}
                label={mode === "change" ? "New PIN" : "PIN"}
                value={next}
                onChange={(v) => {
                  setNext(v);
                  setError(null);
                }}
                onSubmit={() => void submit()}
              />
            </div>
          </div>
          <div className="pin-form__field">
            <span className="pin-form__label">Repeat it</span>
            <div className="pin-form__input">
              <PinInput
                label="Repeat the PIN"
                value={again}
                invalid={again.length >= PIN_MIN && again.length >= next.length && again !== next}
                onChange={(v) => {
                  setAgain(v);
                  setError(null);
                }}
                onSubmit={() => void submit()}
              />
            </div>
          </div>
        </>
      )}
      <div className="pin-form__msg">
        <PinMessage id={locked ? "locked" : undefined} text={message ?? (needsNext ? `${PIN_MIN} to ${PIN_MAX} digits.` : null)} kind={message ? "error" : "info"} />
      </div>
      <div className="pin-form__actions">
        <button type="button" className="btn btn--sm" onClick={onDone} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className={`btn btn--sm ${mode === "remove" ? "btn--danger" : "btn--primary"}`} disabled={busy || locked}>
          {busy && <span className="spinner" aria-hidden />}
          {action}
        </button>
      </div>
    </form>
  );
}
