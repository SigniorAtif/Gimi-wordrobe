import { motion } from "motion/react";
import { forwardRef } from "react";
import { spring, tween } from "../motion";
import { useReduced } from "../lib/useReduced";
import { useApp } from "../store/app";
import { useHome, type Chip } from "../store/home";
import "./Toolbar.css";

const CHIPS: { value: Chip; label: string }[] = [
  { value: "all", label: "All" },
  { value: "character", label: "Characters" },
  { value: "weapon", label: "Weapons" },
  { value: "extra", label: "Extras" },
  { value: "modded", label: "Modded only" },
];

/** Global toolbar on the home screens (SPEC §6): search, filter chips, NSFW chip, + Add, Settings. */
export const Toolbar = forwardRef<HTMLInputElement, { animateIn?: boolean; onAdd?: () => void; onToggleNsfw?: () => void }>(
  function Toolbar({ animateIn = true, onAdd, onToggleNsfw }, searchRef) {
    const reduced = useReduced();
    const navigate = useApp((s) => s.navigate);
    const hotkey = useApp((s) => s.snapshot?.settings.nsfw.hotkey ?? "Ctrl+H");
    const query = useHome((s) => s.query);
    const chip = useHome((s) => s.chip);
    const setQuery = useHome((s) => s.setQuery);
    const setChip = useHome((s) => s.setChip);
    const nsfwVisible = useHome((s) => s.nsfwVisible);
    return (
      <motion.header
        className="toolbar"
        initial={!animateIn ? false : reduced ? { opacity: 0 } : { opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0, transition: { ...spring.gentle, opacity: tween.medium } }}
        exit={{ opacity: 0, transition: tween.small }}
      >
        <div className="toolbar__search">
          <SearchIcon />
          <input
            ref={searchRef}
            className="input toolbar__input"
            placeholder="Search characters, skins, authors…"
            aria-label="Search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setQuery("");
                (e.target as HTMLInputElement).blur();
              }
            }}
          />
        </div>
        <div className="toolbar__chips" role="radiogroup" aria-label="Filter">
          {CHIPS.map((c) => (
            <button key={c.value} type="button" role="radio" aria-checked={chip === c.value} aria-pressed={chip === c.value} className="chip" onClick={() => setChip(c.value)}>
              {chip === c.value && <motion.span layoutId="chip-pill" layoutDependency={chip} className="chip__bg" transition={spring.snappy} />}
              {c.label}
            </button>
          ))}
        </div>
        <div className="toolbar__spacer" />
        <button type="button" className={`nsfw-chip ${nsfwVisible ? "is-visible" : ""}`} onClick={onToggleNsfw} aria-pressed={nsfwVisible}>
          18+ {nsfwVisible ? "VISIBLE" : "HIDDEN"} · {hotkey.toUpperCase()}
          {nsfwVisible ? " TO HIDE" : ""}
        </button>
        <button className="btn" onClick={onAdd} disabled={!onAdd}>
          + Add
        </button>
        <button className="btn" onClick={() => navigate({ name: "settings" })}>
          Settings
        </button>
      </motion.header>
    );
  },
);

export function SearchIcon() {
  return (
    <svg className="toolbar__search-icon" width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="7" cy="7" r="4.75" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
