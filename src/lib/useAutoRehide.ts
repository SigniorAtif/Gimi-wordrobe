import { useEffect } from "react";
import { api } from "../api";
import { useApp } from "../store/app";
import { useHome } from "../store/home";
import { createIdleTimer, IDLE_MS } from "./nsfw";

const INPUT_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel"] as const;

/**
 * Auto re-hide (SPEC §6 Settings › NSFW, §11): with the setting on, 18+ skins hide again when the window is minimized
 * or after five minutes without pointer or key input. Hiding never needs the PIN.
 */
export function useAutoRehide() {
  const on = useApp((s) => !!s.snapshot?.settings.nsfw.autoRehide);
  const visible = useHome((s) => s.nsfwVisible);

  useEffect(() => {
    if (!on) return;
    let unlisten: (() => void) | null = null;
    let gone = false;
    void api
      .onMinimize(() => useHome.getState().hideNsfw())
      .then((u) => {
        if (gone) u();
        else unlisten = u;
      })
      .catch(() => {
        /* no minimize events: the idle timer still covers it */
      });
    return () => {
      gone = true;
      unlisten?.();
    };
  }, [on]);

  useEffect(() => {
    if (!on || !visible) return;
    const idle = createIdleTimer(() => useHome.getState().hideNsfw(), IDLE_MS);
    // pointer moves arrive many times a second; restarting the timer once a second is plenty
    let last = 0;
    const bump = () => {
      const now = performance.now();
      if (now - last < 1000) return;
      last = now;
      idle.bump();
    };
    for (const t of INPUT_EVENTS) window.addEventListener(t, bump, { capture: true, passive: true });
    return () => {
      idle.stop();
      for (const t of INPUT_EVENTS) window.removeEventListener(t, bump, { capture: true });
    };
  }, [on, visible]);
}
