import { AnimatePresence, motion } from "motion/react";
import { useRef, useState } from "react";
import { api, toFailure } from "../api";
import type { Hotkey, ParsedKey, Skin, Snapshot } from "../api/types";
import { keycaps, onlyWithoutModifiers, type HotkeyClash } from "../lib/hotkeys";
import { tween } from "../motion";
import { useApp } from "../store/app";
import "./Hotkeys.css";

export function KeyCaps({ parsed, raw }: { parsed: ParsedKey[]; raw: string }) {
  const p = parsed[0];
  if (!p) return <code className="hk-raw">{raw}</code>;
  const caps = keycaps(p);
  return (
    <span className="hk-caps" title={raw}>
      {caps.map((c, i) => (
        <span key={i}>
          {i > 0 && <span className="kbd-plus">+</span>}
          <kbd className="kbd">{c}</kbd>
        </span>
      ))}
      {onlyWithoutModifiers(p) && <span className="hk-hint">only without modifiers</span>}
    </span>
  );
}

/** Hotkey table (SPEC §6 A3): keycaps, label (editable inline, saved in library.json only) and kind. */
export function HotkeyTable({ skin, editable = true }: { skin: Skin; editable?: boolean }) {
  const setSnapshot = useApp((s) => s.setSnapshot);
  const toast = useApp((s) => s.toast);
  if (!skin.hotkeys.length) return <p className="hk-empty">No hotkeys in this mod's ini files.</p>;
  const save = async (h: Hotkey, label: string) => {
    if (label.trim() === h.label) return;
    try {
      setSnapshot(
        await api.updateSkin(skin.id, { hotkeyLabels: [{ section: h.section, iniFile: h.iniFile, keys: h.keys, label }] }),
      );
    } catch (e) {
      toast({ kind: "error", text: toFailure(e).message });
    }
  };
  return (
    <table className="hk-table">
      <tbody>
        {skin.hotkeys.map((h) => (
          <tr key={`${h.iniFile}|${h.section}|${h.keys}|${h.label}`}>
            <td className="hk-table__keys">
              <KeyCaps parsed={h.parsed} raw={h.keys} />
            </td>
            <td className="hk-table__label">
              {editable ? <LabelInput value={h.label} onCommit={(v) => void save(h, v)} /> : h.label}
              {!h.gated && <span className="hk-ungated" title="No condition: fires even when this character isn't on screen">always on</span>}
            </td>
            <td className="hk-table__kind">{h.kind === "unknown" ? "" : h.kind}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function LabelInput({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  // Escape reverts: the blur that follows must not save the typed text
  const cancelled = useRef(false);
  if (seen !== value) {
    setSeen(value);
    setDraft(value);
  }
  return (
    <input
      className="hk-label-input"
      value={draft}
      aria-label="Hotkey label"
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (cancelled.current) {
          cancelled.current = false;
          return;
        }
        onCommit(draft);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          e.stopPropagation();
          cancelled.current = true;
          setDraft(value);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

/** "Key 6 is also used by Furina · Remembrance (active). Both toggle at once in game." (SPEC §8) */
export function ConflictRows({ clashes, snapshot, onOpen }: { clashes: HotkeyClash[]; snapshot: Snapshot; onOpen?: (skinId: string) => void }) {
  // one row per (key, other skin)
  const seen = new Set<string>();
  const rows = clashes.filter((c) => {
    const k = `${c.hotkey.keys}|${c.otherSkinId}|${c.severity}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  rows.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "conflict" ? -1 : 1));
  return (
    <AnimatePresence initial={false}>
      {rows.map((c) => {
        const other = snapshot.library.skins.find((s) => s.id === c.otherSkinId);
        const ent = snapshot.library.entities.find((e) => e.id === c.otherEntityId);
        const onDisk = snapshot.disk.active[c.otherEntityId]?.includes(c.otherSkinId);
        const key = c.hotkey.parsed[0] ? keycaps(c.hotkey.parsed[0]).join(" + ") : c.hotkey.keys;
        return (
          // the wrapper collapses as one box, padding and gap included, so nothing snaps at the end
          <motion.div
            key={`${c.hotkey.keys}|${c.otherSkinId}|${c.severity}`}
            className="clash-wrap"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto", transition: tween.small }}
            exit={{ opacity: 0, height: 0, transition: tween.small }}
          >
          <button type="button" className={`clash clash--${c.severity}`} onClick={() => onOpen?.(c.otherSkinId)} disabled={!onOpen}>
            <span className="clash__icon" aria-hidden>
              {c.severity === "conflict" ? "!" : "i"}
            </span>
            <span className="clash__text">
              Key <kbd className="kbd kbd--sm">{key}</kbd> is also used by{" "}
              <strong>
                {ent?.name ?? "?"} · {other?.name ?? "?"}
              </strong>{" "}
              ({onDisk ? "active" : "pending"}).{" "}
              {c.severity === "conflict"
                ? "Both toggle at once in game."
                : "Both keys only work while that model is on screen, so they clash only when both are visible."}
            </span>
          </button>
          </motion.div>
        );
      })}
    </AnimatePresence>
  );
}
