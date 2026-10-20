import { useAnimate } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { toFailure } from "../api";
import { lockoutText, PIN_MAX, PIN_MIN, wrongPinText } from "../lib/pin";
import { useRedact } from "../lib/useRedact";
import { useReduced } from "../lib/useReduced";
import { shake } from "../motion";
import { useHome } from "../store/home";
import { Modal } from "./Modal";
import { PinInput, PinMessage, useSecondsLeft } from "./PinField";
import "./PinPrompt.css";

/** Asks for the PIN before 18+ skins are revealed (SPEC §11). Mounted once in the app shell. */
export function PinPrompt() {
  const open = useHome((s) => s.pinPrompt);
  const close = useHome((s) => s.closePinPrompt);
  return (
    <Modal open={open} onClose={close} label="Enter your PIN" width={360}>
      <PinPromptBody onClose={close} />
    </Modal>
  );
}

function PinPromptBody({ onClose }: { onClose: () => void }) {
  const reduced = useReduced();
  const redact = useRedact();
  const [scope, animate] = useAnimate<HTMLDivElement>();
  const input = useRef<HTMLInputElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const submitPin = useHome((s) => s.submitPin);
  const retryAt = useHome((s) => s.pinRetryAt);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wait = useSecondsLeft(retryAt);
  const locked = wait > 0;

  // the field is disabled during a lockout: focus stays in the dialog on Cancel, and returns to the field after
  const wasLocked = useRef(locked);
  useEffect(() => {
    if (wasLocked.current && !locked) input.current?.focus();
    if (!wasLocked.current && locked) cancel.current?.focus();
    wasLocked.current = locked;
  }, [locked]);

  const submit = async (value = pin) => {
    if (busy || locked || value.length < PIN_MIN) return;
    setBusy(true);
    try {
      const r = await submitPin(value);
      if (r.ok) return; // the store reveals and closes the prompt
      setPin("");
      setError(r.retryIn > 0 ? null : wrongPinText(r));
      if (!reduced && scope.current) void animate(scope.current, shake);
    } catch (e) {
      setError(redact(toFailure(e).message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pin-prompt">
      <h2 className="pin-prompt__title">Show 18+ skins</h2>
      <p className="pin-prompt__lede">Enter your PIN to show them.</p>
      <div ref={scope}>
        <PinInput
          ref={input}
          label="PIN"
          value={pin}
          autoFocus={!locked}
          disabled={locked}
          invalid={!!error}
          onChange={(v) => {
            setPin(v);
            setError(null);
            // six digits is the longest a PIN can be, so there's nothing left to wait for
            if (v.length === PIN_MAX) void submit(v);
          }}
          onSubmit={() => void submit()}
        />
      </div>
      <PinMessage id={locked ? "locked" : undefined} text={locked ? lockoutText(wait) : error} />
      <div className="confirm__actions pin-prompt__actions">
        <button ref={cancel} type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn btn--primary" onClick={() => void submit()} disabled={busy || locked || pin.length < PIN_MIN}>
          {busy && <span className="spinner" aria-hidden />}
          Show
        </button>
      </div>
    </div>
  );
}
