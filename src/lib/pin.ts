// PIN lock helpers (SPEC §6, §11): what the PIN field accepts and what a wrong guess or a lockout says. Pure.
import type { PinCheck } from "../api/types";

export const PIN_MIN = 4;
export const PIN_MAX = 6;

/** Typed or pasted text cut down to what a PIN field holds: digits only, at most six. */
export function pinDigits(text: string): string {
  return text.replace(/\D/g, "").slice(0, PIN_MAX);
}

export function isValidPin(pin: string): boolean {
  return new RegExp(`^\\d{${PIN_MIN},${PIN_MAX}}$`).test(pin);
}

/** Seconds as a clock: 75 -> "1:15". */
export function formatWait(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function lockoutText(seconds: number): string {
  return `Too many wrong PINs. Try again in ${formatWait(seconds)}.`;
}

/** The line under the prompt's field after a wrong guess. */
export function wrongPinText(r: PinCheck): string {
  if (r.retryIn > 0) return lockoutText(r.retryIn);
  return `Wrong PIN. ${r.triesLeft} ${r.triesLeft === 1 ? "try" : "tries"} left.`;
}

/**
 * Seconds left in a lockout, read from a `pin_locked` error ("Try again in 30 s."). `setPin` reports the lockout only
 * as text, and both backends word it the same way. 0 when the message has no number.
 */
export function retryFromMessage(message: string): number {
  const m = /(\d+)\s*s\b/.exec(message);
  return m ? Number(m[1]) : 0;
}

/** Inline text for a failed `setPin` (Settings › PIN lock). */
export function setPinErrorText(code: string, message: string): string {
  switch (code) {
    case "pin_wrong":
      return "That's not the current PIN.";
    case "pin_locked":
      return lockoutText(retryFromMessage(message) || 30);
    case "pin_invalid":
      return `Use ${PIN_MIN} to ${PIN_MAX} digits for the PIN.`;
    default:
      return message;
  }
}
