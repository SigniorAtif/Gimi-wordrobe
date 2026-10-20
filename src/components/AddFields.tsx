// Form pieces shared by the A4 add dialog and the C4 add popover (SPEC §6, §10).
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useId, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { api, toFailure } from "../api";
import type { AddProgress, ArchiveSummary, Category, Entity, GameBananaInfo, PreviewChoice } from "../api/types";
import { applyGameBananaInfo, choiceName, gameBananaPrefill, initialDraft, isGameBananaUrl, type AddDraft, type GameBananaPrefill } from "../lib/addDraft";
import { CATEGORY_LABEL, CATEGORY_ORDER } from "../lib/derive";
import { redactHidden } from "../lib/nsfw";
import { spring, tween } from "../motion";
import { useAdd, type AddFlow } from "../store/add";
import { useApp } from "../store/app";
import { useHome } from "../store/home";
import "./AddFields.css";
import "./Previews.css";

/** The draft for the open flow: built once the archive summary arrives, fed by images dropped on the window. */
export function useAddDraft(flow: AddFlow | null, entities: Entity[], makeActive: boolean) {
  const [draft, setDraft] = useState<AddDraft | null>(null);
  const [seen, setSeen] = useState<ArchiveSummary | null>(null);
  const summary = flow?.summary ?? null;
  if (summary !== seen) {
    setSeen(summary);
    // A4 opened from C4 ("More options…") carries on with what was filled in there
    setDraft(
      summary && flow
        ? (flow.draft ?? initialDraft(summary, { entityId: flow.entityId, newCategory: flow.newCategory, entities, makeActive }))
        : null,
    );
  }
  // an image dropped on the window becomes the new entry's portrait or the skin's own preview
  const dropped = useAdd((s) => s.droppedImage);
  const [seenDrop, setSeenDrop] = useState(dropped);
  if (dropped !== seenDrop) {
    setSeenDrop(dropped);
    if (dropped) {
      setDraft((d) => {
        if (!d) return d;
        if (dropped.target === "portrait") return d.entity.kind === "new" ? { ...d, entity: { ...d.entity, portraitPath: dropped.path } } : d;
        return { ...d, preview: "user", userImage: dropped.path };
      });
    }
  }
  return [draft, setDraft] as const;
}

export type GameBananaLookup =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ok"; info: GameBananaInfo }
  | { state: "error"; message: string };

/**
 * Pasting or typing a GameBanana link reads the mod page (debounced, stores nothing) and pre-fills the skin name
 * (unless the user typed one), the author and the NSFW switch (SPEC §6 A4/C4).
 */
export function useGameBananaLookup(
  draft: AddDraft | null,
  setDraft: Dispatch<SetStateAction<AddDraft | null>>,
  summary: ArchiveSummary | null,
  entities: Entity[],
): GameBananaLookup {
  const url = draft?.gbUrl.trim() ?? "";
  const valid = isGameBananaUrl(url);
  const [answer, setAnswer] = useState<{ url: string; info?: GameBananaInfo; error?: string } | null>(null);
  const prefill = useRef<GameBananaPrefill | null>(null);
  const suggestedName = summary?.suggestedName ?? "";
  const entityName = draft ? choiceName(draft.entity, entities) : "";
  // read at answer time, so picking another character doesn't look the link up again
  const names = useRef({ suggestedName, entityName });
  useEffect(() => {
    names.current = { suggestedName, entityName };
  });
  useEffect(() => {
    if (!valid || !summary) return;
    let live = true;
    const t = setTimeout(async () => {
      try {
        const info = await api.gameBananaInfo(url);
        if (!live) return;
        const previous = prefill.current;
        prefill.current = gameBananaPrefill(info, names.current.entityName);
        setAnswer({ url, info });
        setDraft((d) => (d && d.gbUrl.trim() === url ? applyGameBananaInfo(d, info, { ...names.current, previous }).draft : d));
      } catch (e) {
        if (!live) return;
        const msg = redactHidden(toFailure(e).message, useApp.getState().snapshot, useHome.getState().nsfwVisible);
        setAnswer({ url, error: msg });
      }
    }, 450);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [url, valid, summary, setDraft]);
  if (!valid || !summary) return { state: "idle" };
  if (answer?.url !== url) return { state: "loading" };
  return answer.info ? { state: "ok", info: answer.info } : { state: "error", message: answer.error ?? "" };
}

/** One line under the link field: reading the page, what it found, or why it couldn't. Crossfades between them. */
export function GameBananaStatus({ lookup }: { lookup: GameBananaLookup }) {
  const key = lookup.state === "ok" ? `ok:${lookup.info.modId}` : lookup.state;
  return (
    <AnimatePresence initial={false} mode="popLayout">
      {lookup.state !== "idle" && (
        <motion.span
          key={key}
          className={`gb-status gb-status--${lookup.state}`}
          role={lookup.state === "error" ? "alert" : "status"}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: tween.small }}
          exit={{ opacity: 0, transition: tween.micro }}
        >
          <span className="gb-status__text">
            {lookup.state === "loading" && <span className="gb-status__line">Reading the GameBanana page…</span>}
            {lookup.state === "error" && <span className="gb-status__line">{lookup.message}</span>}
            {lookup.state === "ok" && (
              <>
                <span className="gb-status__check" aria-hidden>
                  ✓
                </span>
                <span className="gb-status__line" title={lookup.info.name}>
                  {[lookup.info.name, lookup.info.author && `by ${lookup.info.author}`, `${lookup.info.images.length} image${lookup.info.images.length === 1 ? "" : "s"}`]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                {lookup.info.nsfw && <span className="tag tag--nsfw">18+</span>}
              </>
            )}
          </span>
        </motion.span>
      )}
    </AnimatePresence>
  );
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${bytes} B`;
}

/** "1 mod · 2 images" */
export function summaryCounts(s: ArchiveSummary): string {
  const mods = s.roots.length;
  const imgs = s.images.length;
  return `${mods} mod${mods === 1 ? "" : "s"} · ${imgs} image${imgs === 1 ? "" : "s"}`;
}

/** Character / weapon / extra dropdown, grouped by category. */
export function EntitySelect({
  value,
  onChange,
  entities,
  id,
  allowNone,
  invalid,
}: {
  value: string;
  onChange: (id: string) => void;
  entities: Entity[];
  id?: string;
  allowNone?: boolean;
  invalid?: boolean;
}) {
  return (
    <select id={id} className={`input ${invalid ? "is-invalid" : ""}`} value={value} onChange={(e) => onChange(e.target.value)}>
      {(allowNone || !value) && <option value="">Choose…</option>}
      {CATEGORY_ORDER.map((cat) => {
        const list = entities.filter((e) => e.category === cat).sort((a, b) => a.name.localeCompare(b.name));
        return list.length ? (
          <optgroup key={cat} label={CATEGORY_LABEL[cat]}>
            {list.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </optgroup>
        ) : null;
      })}
    </select>
  );
}

/** A small "Weapon / Extra" or "Character / Weapon / Extra" switch for new entries. */
export function CategoryPick({ value, onChange, options }: { value: Category; onChange: (c: Category) => void; options: Category[] }) {
  const id = useId();
  return (
    <div className="catpick" role="radiogroup" aria-label="Category">
      {options.map((c) => (
        <button key={c} type="button" role="radio" aria-checked={value === c} className="catpick__opt" onClick={() => onChange(c)}>
          {value === c && <motion.span layoutId={`cat-${id}`} className="catpick__pill" transition={spring.snappy} />}
          <span className="catpick__label">{c === "extra" ? "Extra" : c === "weapon" ? "Weapon" : "Character"}</span>
        </button>
      ))}
    </div>
  );
}

/** Round portrait target for a new entry: drop an image on it or click to browse. */
export function PortraitDrop({ path, name, onChange }: { path?: string; name: string; onChange: (p: string) => void }) {
  return (
    <button
      type="button"
      className={`portrait-drop ${path ? "has-image" : ""}`}
      data-drop="portrait"
      aria-label={path ? `Portrait: ${fileName(path)}. Click to change` : "Add a portrait: drop an image or click to browse"}
      title={path ? fileName(path) : undefined}
      onClick={async () => {
        const p = await api.pickImage();
        if (p) onChange(p);
      }}
    >
      {path ? (
        <motion.span key={path} className="portrait-drop__done" initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1, transition: spring.snappy }}>
          ✓
        </motion.span>
      ) : name.trim() ? (
        <span className="portrait-drop__initial">{name.trim()[0].toUpperCase()}</span>
      ) : (
        <span className="portrait-drop__hint">Drop portrait</span>
      )}
    </button>
  );
}

const PREVIEW_OPTIONS: { value: PreviewChoice; label: (n: number) => string }[] = [
  { value: "gamebanana", label: () => "From GameBanana link" },
  { value: "archive", label: (n) => `Found in archive (${n})` },
  { value: "user", label: () => "Drop or browse" },
  { value: "later", label: () => "None for now" },
];

/** The four preview sources (SPEC §10) as tiles; the selection outline slides between them. */
export function PreviewPicker({
  draft,
  setDraft,
  imageCount,
  compact,
  gbImages,
}: {
  draft: AddDraft;
  setDraft: (d: AddDraft) => void;
  imageCount: number;
  compact?: boolean;
  /** images on the GameBanana page, once the link was read */
  gbImages?: number;
}) {
  const id = useId();
  const gbOk = isGameBananaUrl(draft.gbUrl);
  return (
    <div className={`previews-pick ${compact ? "previews-pick--compact" : ""}`} role="radiogroup" aria-label="Preview source">
      {PREVIEW_OPTIONS.map((o) => {
        const on = draft.preview === o.value;
        // GameBanana needs a link first; a tile already picked stays clickable so the choice can be seen
        const disabled = (o.value === "archive" && imageCount === 0) || (o.value === "gamebanana" && !gbOk && !on);
        const pick = async () => {
          if (o.value === "user") {
            const p = draft.userImage ?? (await api.pickImage());
            if (p) setDraft({ ...draft, preview: "user", userImage: p });
            return;
          }
          setDraft({ ...draft, preview: o.value });
        };
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled}
            className={`ptile ${on ? "is-on" : ""}`}
            data-drop={o.value === "user" ? "preview" : undefined}
            title={o.value === "gamebanana" ? (gbOk ? "Downloads the mod page's screenshots right after adding" : "Paste a GameBanana link first") : undefined}
            onClick={() => void pick()}
          >
            {on && <motion.span layoutId={`ptile-${id}`} className="ptile__ring" transition={spring.snappy} />}
            <span className="ptile__art" aria-hidden>
              {o.value === "gamebanana" && (!gbOk ? "Paste a link" : gbImages === undefined ? "From the link" : `${gbImages} image${gbImages === 1 ? "" : "s"}`)}
              {o.value === "archive" && (imageCount ? `${imageCount} image${imageCount === 1 ? "" : "s"}` : "None inside")}
              {o.value === "user" && (draft.userImage ? fileName(draft.userImage) : "Drop / browse")}
              {o.value === "later" && "+"}
            </span>
            <span className="ptile__label">{o.label(imageCount)}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Extraction progress: a bar that grows with transform only, plus "Extracting 4 / 10". */
export function AddProgressBar({ progress }: { progress: AddProgress }) {
  const frac = progress.total ? Math.min(1, progress.done / progress.total) : 0;
  return (
    <div className="add-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(frac * 100)} aria-label={progress.label}>
      <span className="add-progress__label">
        {progress.label}… <span className="num">{Math.round(frac * 100)}%</span>
      </span>
      <span className="add-progress__track">
        <motion.span className="add-progress__fill" initial={{ scaleX: 0 }} animate={{ scaleX: frac }} transition={tween.small} />
      </span>
    </div>
  );
}

/** Inline field error that opens under its field (height + fade) and closes the same way. */
export function FieldError({ text }: { text?: string }) {
  return (
    <AnimatePresence initial={false}>
      {text && (
        <motion.span
          key="err"
          className="field-error"
          role="alert"
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto", transition: tween.small }}
          exit={{ opacity: 0, height: 0, transition: tween.micro }}
        >
          <span className="field-error__text">{text}</span>
        </motion.span>
      )}
    </AnimatePresence>
  );
}
