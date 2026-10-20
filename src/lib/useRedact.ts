import { useCallback } from "react";
import { useApp } from "../store/app";
import { useHome } from "../store/home";
import { redactHidden } from "./nsfw";

/**
 * A function that strips hidden 18+ skins' names and folders from free text (toasts, backend errors) while they are
 * hidden (SPEC §11). It applies at render time, so a message shown before a hide is redacted after it too.
 */
export function useRedact(): (text: string) => string {
  const snapshot = useApp((s) => s.snapshot);
  const nsfwVisible = useHome((s) => s.nsfwVisible);
  return useCallback((text: string) => redactHidden(text, snapshot, nsfwVisible), [snapshot, nsfwVisible]);
}
