// Fixer scripts: the user's own fixer tools, run in order on every newly added skin (core/fixers.rs).
import { AnimatePresence, motion } from "motion/react";
import { api, toFailure } from "../api";
import type { FixerScript } from "../api/types";
import { useReduced } from "../lib/useReduced";
import { spring } from "../motion";
import { useApp } from "../store/app";
import { Switch } from "./Switch";
import "./FixerScripts.css";

/** Community tools that fix common problems with older mods. Not made by or shipped with this app. */
export const RECOMMENDED_FIXERS = [
  {
    name: "Fix All Character Mods",
    url: "https://gamebanana.com/tools/16433",
    by: "Gustav0_ and SilentNightSound",
    fixes: "Mods made for older game versions: outdated hashes, stretched or distorted bodies.",
  },
  {
    name: "ORFix Applier",
    url: "https://gamebanana.com/tools/16472",
    by: "golanah921 and LeoMods_",
    fixes: "Characters that show up flat green or glowing (outlines and reflections).",
  },
];

const fileName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/** Links to the recommended tools' pages, in the order they should run. */
export function RecommendedFixers() {
  return (
    <div className="fixers-rec">
      <ol className="fixers-rec__list">
        {RECOMMENDED_FIXERS.map((f) => (
          <li key={f.url} className="fixers-rec__item">
            <div className="fixers-rec__text">
              <span className="fixers-rec__name">{f.name}</span>
              <span className="fixers-rec__fixes">{f.fixes}</span>
              <span className="fixers-rec__by">by {f.by}</span>
            </div>
            <button type="button" className="btn btn--sm" onClick={() => void api.openUrl(f.url)}>
              Get it on GameBanana ↗
            </button>
          </li>
        ))}
      </ol>
      <p className="fixers-rec__note">
        Download and unzip them, then add each tool&apos;s .exe below, in this order. They aren&apos;t made by or shipped with
        Skin Switcher.
      </p>
    </div>
  );
}

/** The ordered list of fixer tools with add, reorder, on/off and remove. */
export function FixerScriptList({ scripts, onChange }: { scripts: FixerScript[]; onChange: (next: FixerScript[]) => void }) {
  const toast = useApp((s) => s.toast);
  const reduced = useReduced();
  const add = async () => {
    try {
      const path = await api.pickScript();
      if (!path) return;
      if (scripts.some((s) => s.path.toLowerCase() === path.toLowerCase())) {
        toast({ kind: "info", text: `${fileName(path)} is already in the list.` });
        return;
      }
      onChange([...scripts, { path, enabled: true }]);
    } catch (e) {
      toast({ kind: "error", text: toFailure(e).message });
    }
  };
  const move = (i: number, by: -1 | 1) => {
    const next = [...scripts];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    onChange(next);
  };
  const update = (i: number, patch: Partial<FixerScript>) => onChange(scripts.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const remove = (i: number) => onChange(scripts.filter((_, j) => j !== i));

  return (
    <div className="fixers">
      {scripts.length === 0 ? (
        <div className="fixers__empty">None yet. New skins are added exactly as they come.</div>
      ) : (
        <ol className="fixers__list">
          <AnimatePresence initial={false}>
            {scripts.map((s, i) => (
              <motion.li
                key={s.path}
                layout={!reduced}
                className={`fixers__row ${s.enabled ? "" : "is-off"}`}
                initial={{ opacity: 0, y: reduced ? 0 : -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, transition: { duration: 0.12 } }}
                transition={spring.snappy}
              >
                <span className="fixers__num">{i + 1}</span>
                <span className="fixers__text">
                  <span className="fixers__name">{fileName(s.path)}</span>
                  <span className="fixers__path" title={s.path}>
                    {s.path}
                  </span>
                </span>
                <Switch label={`Run ${fileName(s.path)}`} checked={s.enabled} onChange={(enabled) => update(i, { enabled })} />
                <span className="fixers__tools">
                  <button type="button" className="btn btn--ghost btn--icon btn--sm" aria-label="Move up" title="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                    ↑
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--icon btn--sm"
                    aria-label="Move down"
                    title="Move down"
                    disabled={i === scripts.length - 1}
                    onClick={() => move(i, 1)}
                  >
                    ↓
                  </button>
                  <button type="button" className="btn btn--ghost btn--icon btn--sm" aria-label={`Remove ${fileName(s.path)}`} title="Remove" onClick={() => remove(i)}>
                    ✕
                  </button>
                </span>
              </motion.li>
            ))}
          </AnimatePresence>
        </ol>
      )}
      <div>
        <button type="button" className="btn btn--sm" onClick={() => void add()}>
          + Add script…
        </button>
      </div>
    </div>
  );
}
