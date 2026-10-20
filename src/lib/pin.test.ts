import { describe, expect, it } from "vitest";
import { formatWait, isValidPin, lockoutText, pinDigits, retryFromMessage, setPinErrorText, wrongPinText } from "./pin";

describe("PIN field input", () => {
  it("keeps digits only, at most six", () => {
    expect(pinDigits("12a3 4")).toBe("1234");
    expect(pinDigits("12345678")).toBe("123456");
    expect(pinDigits("")).toBe("");
  });

  it("accepts 4 to 6 digits", () => {
    expect(isValidPin("123")).toBe(false);
    expect(isValidPin("1234")).toBe(true);
    expect(isValidPin("123456")).toBe(true);
    expect(isValidPin("1234567")).toBe(false);
    expect(isValidPin("12a4")).toBe(false);
  });
});

describe("wrong PINs and lockouts", () => {
  it("formats the wait as a clock", () => {
    expect(formatWait(0)).toBe("0:00");
    expect(formatWait(9)).toBe("0:09");
    expect(formatWait(75)).toBe("1:15");
    expect(formatWait(600)).toBe("10:00");
    expect(formatWait(29.2)).toBe("0:30");
  });

  it("says how many tries are left, or how long the lockout lasts", () => {
    expect(wrongPinText({ ok: false, retryIn: 0, triesLeft: 3 })).toBe("Wrong PIN. 3 tries left.");
    expect(wrongPinText({ ok: false, retryIn: 0, triesLeft: 1 })).toBe("Wrong PIN. 1 try left.");
    expect(wrongPinText({ ok: false, retryIn: 30, triesLeft: 0 })).toBe(lockoutText(30));
    expect(lockoutText(30)).toBe("Too many wrong PINs. Try again in 0:30.");
  });

  it("reads the lockout from a pin_locked message, as both backends word it", () => {
    expect(retryFromMessage("Too many wrong PINs. Try again in 30 s.")).toBe(30);
    expect(retryFromMessage("Too many wrong PINs. Try again in 120 s.")).toBe(120);
    expect(retryFromMessage("Something else.")).toBe(0);
  });

  it("maps setPin errors to inline text", () => {
    expect(setPinErrorText("pin_wrong", "x")).toBe("That's not the current PIN.");
    expect(setPinErrorText("pin_locked", "Too many wrong PINs. Try again in 60 s.")).toBe("Too many wrong PINs. Try again in 1:00.");
    expect(setPinErrorText("pin_invalid", "")).toBe("Use 4 to 6 digits for the PIN.");
    expect(setPinErrorText("io", "Couldn't save the settings.")).toBe("Couldn't save the settings.");
  });
});
