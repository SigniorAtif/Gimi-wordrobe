import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, toFailure } from "../api";
import type { Skin, Snapshot } from "../api/types";
import { rememberFlipKey } from "../components/Flip";
import { Gallery } from "../components/Gallery";
import { ConflictRows, HotkeyTable } from "../components/Hotkeys";
import { Switch } from "../components/Switch";
import { SelectionTag } from "../components/SelectionTag";
import { clashesIfPicked } from "../lib/conflicts";
import { entityView, visibleSkins } from "../lib/derive";
import { useReduced } from "../lib/useReduced";
import { spring, tween } from "../motion";
import { useApp } from "../store/app";
import { prunePicks, useHome } from "../store/home";
import "./SkinDetail.css";

/** A3 skin detail (SPEC §6, shared by both layouts). Double-click a skin card to get here. */
export function SkinDetail({ skinId }: { skinId: string }) {
  // re-render on navigation so the outgoing page's shared elements snapshot their layout before the morph
  useApp((s) => s.route);
  const snapshot = useApp((s) => s.snapshot)!;
  const navigate = useApp((s) => s.navigate);
  const replace = useApp((s) => s.replace);
  const appBack = useApp((s) => s.back);
  // going back morphs the big preview into the card it came from
  const back = useCallback(() => {
    rememberFlipKey(`skin:${skinId}`);
    appBack();
  }, [appBack, skinId]);
  const picks = useHome((s) => s.picks);
  const nsfwVisible = useHome((s) => s.nsfwVisible);
  const reduced = useReduced();
  const skin = snapshot.library.skins.find((s) => s.id === skinId);
  const entity = skin ? snapshot.library.entities.find((e) => e.id === skin.entityId) : undefined;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea") || e.defaultPrevented) return;
      if (e.key === "Escape" || e.key === "Backspace") {
        e.preventDefault();
        back();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [back]);

  if (!skin || !entity || (skin.nsfw && !nsfwVisible)) {
    return (
      <div className="detail detail--missing">
        <p>{skin ? "This skin is hidden while 18+ skins are hidden." : "This skin no longer exists."}</p>
        <button className="btn" onClick={back}>
          ← Back
        </button>
      </div>
    );
  }

  const view = entityView(snapshot, picks, nsfwVisible, entity);
  const siblings = visibleSkins(snapshot, entity, nsfwVisible);
  const i = siblings.findIndex((s) => s.id === skin.id);
  const step = (d: 1 | -1) => {
    const next = siblings[(i + d + siblings.length) % siblings.length];
    if (next && next.id !== skin.id) replace({ name: "skin", skinId: next.id }, d);
  };
  const selected = view.effective === skin.id;

  return (
    <div className="detail">
      <header className="detail__header">
        <button className="btn" onClick={back}>
          ← {entity.name}
        </button>
        <nav className="detail__crumbs" aria-label="Breadcrumb">
          <button className="detail__crumb" onClick={() => navigate({ name: "home" })}>
            All characters
          </button>
          <span aria-hidden>›</span>
          <button className="detail__crumb" onClick={() => navigate({ name: "entity", entityId: entity.id })}>
            {entity.name}
          </button>
          <span aria-hidden>›</span>
          <span className="detail__crumb is-current">{skin.name}</span>
        </nav>
        <span className="detail__spacer" />
        <button className="btn" onClick={() => step(-1)} disabled={siblings.length < 2} aria-label="Previous skin">
          ‹ Prev
        </button>
        <button className="btn" onClick={() => step(1)} disabled={siblings.length < 2} aria-label="Next skin">
          Next ›
        </button>
      </header>
      <div className="detail__body">
        <Gallery skin={skin} reduced={reduced} keyboard flip />
        <motion.section
          className="detail__panel"
          initial={reduced ? { opacity: 0 } : { opacity: 0, x: 24 }}
          animate={{ opacity: 1, x: 0, transition: { ...spring.gentle, opacity: tween.medium, delay: 0.05 } }}
        >
          <SkinInfo skin={skin} snapshot={snapshot} selected={selected} pending={view.pending && selected} reduced={reduced} />
        </motion.section>
      </div>
    </div>
  );
}

/** Right-hand info (A3) / right column (C3 peek): name, meta, actions, hotkeys, conflicts, notes. */
export function SkinInfo({
  skin,
  snapshot,
  selected,
  pending,
  reduced,
  compact,
  onLess,
}: {
  skin: Skin;
  snapshot: Snapshot;
  selected: boolean;
  pending: boolean;
  reduced: boolean;
  compact?: boolean;
  onLess?: () => void;
}) {
  const pick = useHome((s) => s.pick);
  const picks = useHome((s) => s.picks);
  const nsfwVisible = useHome((s) => s.nsfwVisible);
  const navigate = useApp((s) => s.navigate);
  const toast = useApp((s) => s.toast);
  const [editing, setEditing] = useState(false);
  const clashes = useMemo(() => clashesIfPicked(snapshot, picks, skin, nsfwVisible), [snapshot, picks, skin, nsfwVisible]);
  const added = skin.addedAt ? new Date(skin.addedAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : null;
  const meta = [skin.author && `by ${skin.author}`, skin.version && `v${skin.version}`, added && `added ${added}`, ...skin.folders.map((f) => `Mods/${f}/`)].filter(Boolean);

  const openFolder = async () => {
    try {
      await api.openFolder({ kind: "skin", skinId: skin.id });
    } catch (e) {
      toast({ kind: "error", text: toFailure(e).message });
    }
  };

  return (
    <div className={`info ${compact ? "info--compact" : ""}`}>
      <div className="info__title-row">
        <h1 className="info__title">{skin.name}</h1>
        <AnimatePresence initial={false}>{selected && <SelectionTag entityId={skin.entityId} pending={pending} reduced={reduced} shared={false} />}</AnimatePresence>
        {skin.nsfw && <span className="tag tag--nsfw">18+</span>}
        {onLess && (
          <button className="btn btn--sm info__less" onClick={onLess}>
            ▴ Less
          </button>
        )}
      </div>
      <p className="info__meta">{meta.join(" · ")}</p>
      <div className="info__actions">
        {selected ? (
          <button className="btn" onClick={() => pick(skin.entityId, null)}>
            Set as Original (turn off)
          </button>
        ) : (
          <button className="btn btn--primary" onClick={() => pick(skin.entityId, skin.id)}>
            Set active
          </button>
        )}
        <button className="btn" onClick={() => void openFolder()}>
          Open folder
        </button>
        {skin.gameBananaUrl && (
          <button className="btn" onClick={() => void api.openUrl(skin.gameBananaUrl!)}>
            GameBanana page ↗
          </button>
        )}
        {!compact && (
          <button className="btn btn--ghost" onClick={() => setEditing((v) => !v)} aria-expanded={editing}>
            {editing ? "Done" : "Edit details"}
          </button>
        )}
      </div>
      <AnimatePresence initial={false}>
        {editing && (
          <motion.div
            className="info__edit"
            initial={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
            animate={reduced ? { opacity: 1 } : { opacity: 1, height: "auto", transition: spring.smooth }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, height: 0, transition: tween.small }}
          >
            <EditDetails skin={skin} snapshot={snapshot} />
          </motion.div>
        )}
      </AnimatePresence>
      <h2 className="caps info__h">In-game hotkeys · read from the mod's .ini</h2>
      <HotkeyTable skin={skin} />
      {clashes.length > 0 && (
        <div className="info__clashes">
          <ConflictRows clashes={clashes} snapshot={snapshot} onOpen={(id) => navigate({ name: "skin", skinId: id })} />
        </div>
      )}
      <h2 className="caps info__h">Notes</h2>
      <Notes key={skin.id} skin={skin} />
    </div>
  );
}

function Notes({ skin }: { skin: Skin }) {
  const setSnapshot = useApp((s) => s.setSnapshot);
  const toast = useApp((s) => s.toast);
  const [draft, setDraft] = useState(skin.notes ?? "");
  const [saved, setSaved] = useState<"idle" | "saving" | "saved">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const last = useRef(skin.notes ?? "");
  const save = async (text: string) => {
    if (text === last.current) return;
    setSaved("saving");
    try {
      setSnapshot(await api.updateSkin(skin.id, { notes: text }));
      // only remember what actually saved, so a failed save is retried on the next edit or blur
      last.current = text;
      setSaved("saved");
    } catch (e) {
      setSaved("idle");
      toast({ kind: "error", text: `Couldn't save the notes: ${toFailure(e).message}` });
    }
  };
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return (
    <div className="notes">
      <textarea
        className="input"
        aria-label="Notes"
        placeholder={'Your own notes, e.g. "use with the dark hair variant"…'}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          if (timer.current) clearTimeout(timer.current);
          const v = e.target.value;
          timer.current = setTimeout(() => void save(v), 700);
        }}
        onBlur={() => void save(draft)}
      />
      <AnimatePresence>
        {saved !== "idle" && (
          <motion.span key={saved} className="notes__state" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={tween.small}>
            {saved === "saving" ? "Saving…" : "Saved"}
          </motion.span>
        )}
      </AnimatePresence>
    </div>
  );
}

function EditDetails({ skin, snapshot }: { skin: Skin; snapshot: Snapshot }) {
  const setSnapshot = useApp((s) => s.setSnapshot);
  const toast = useApp((s) => s.toast);
  const save = async (patch: Parameters<typeof api.updateSkin>[1]) => {
    try {
      const snap = await api.updateSkin(skin.id, patch);
      setSnapshot(snap);
      // a skin that moved to another character can't stay a pending pick for the old one
      if (patch.entityId !== undefined) useHome.setState((h) => ({ picks: prunePicks(h.picks, snap) }));
    } catch (e) {
      toast({ kind: "error", text: toFailure(e).message });
    }
  };
  const field = (label: string, value: string | undefined, key: "name" | "author" | "version" | "gameBananaUrl", placeholder = "") => (
    <label className="edit__field">
      <span className="caps">{label}</span>
      <input
        className="input"
        defaultValue={value ?? ""}
        placeholder={placeholder}
        onBlur={(e) => {
          if ((e.target.value || "") !== (value ?? "")) void save({ [key]: e.target.value });
        }}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
    </label>
  );
  const entities = [...snapshot.library.entities].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="edit">
      {field("Skin name", skin.name, "name")}
      {field("Author", skin.author, "author", "optional")}
      {field("Version", skin.version, "version", "optional")}
      {field("GameBanana link", skin.gameBananaUrl, "gameBananaUrl", "https://gamebanana.com/mods/…")}
      <label className="edit__field">
        <span className="caps">Belongs to</span>
        <select className="input" value={skin.entityId} onChange={(e) => void save({ entityId: e.target.value })}>
          {entities.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name} ({e.category})
            </option>
          ))}
        </select>
      </label>
      <div className="edit__field edit__field--row">
        <Switch label="NSFW" checked={skin.nsfw} onChange={(v) => void save({ nsfw: v })} />
        <span>NSFW / 18+ (hidden behind Ctrl+H)</span>
      </div>
    </div>
  );
}
