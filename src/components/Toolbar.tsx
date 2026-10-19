import { motion } from "motion/react";
import { spring, tween } from "../motion";
import { useReduced } from "../lib/useReduced";
import { useApp } from "../store/app";
import "./Toolbar.css";

/** Global toolbar for the home screens (§6). Search and filters are wired in the Home milestone. */
export function Toolbar() {
  const reduced = useReduced();
  const navigate = useApp((s) => s.navigate);
  return (
    <motion.header
      className="toolbar"
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0, transition: { ...spring.gentle, opacity: tween.medium } }}
      exit={{ opacity: 0, transition: tween.small }}
    >
      <div className="toolbar__search">
        <SearchIcon />
        <input className="input toolbar__input" placeholder="Search characters, skins, authors…" aria-label="Search" />
      </div>
      <div className="toolbar__spacer" />
      <button className="btn" onClick={() => navigate({ name: "settings" })}>
        Settings
      </button>
    </motion.header>
  );
}

export function SearchIcon() {
  return (
    <svg className="toolbar__search-icon" width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="7" cy="7" r="4.75" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
