import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, toFailure } from "../api";
import type { AddProgress, Category, Entity, ImportItem, ImportPlan, ImportRequest } from "../api/types";
import { AddProgressBar, CategoryPick, fileName } from "../components/AddFields";
import { Switch } from "../components/Switch";
import { choiceName, guessChoice, target, type EntityChoice } from "../lib/addDraft";
import { CATEGORY_LABEL, CATEGORY_ORDER } from "../lib/derive";
import { useReduced } from "../lib/useReduced";
import { riseIn, spring, staggerContainer, tween } from "../motion";
import { useApp } from "../store/app";
import { useHome } from "../store/home";
import "./ImportReview.css";

interface Row {
  include: boolean;
  entity: EntityChoice;
  skinName: string;
  nsfw: boolean;
  own: boolean;
}

type Phase =
  | { kind: "reading"; progress: AddProgress | null }
  | { kind: "review" }
  | { kind: "importing"; progress: AddProgress | null }
  | { kind: "error"; message: string };

const OTHER = "__other";

function entityKey(c: EntityChoice): string {
  return c.kind === "existing" ? `id:${c.id}` : c.kind === "new" ? `new:${c.name.trim().toLowerCase()}` : "none";
}

function categoryOf(c: EntityChoice, entities: Entity[]): Category {
  if (c.kind === "existing") return entities.find((e) => e.id === c.id)?.category ?? "character";
  return c.kind === "new" ? c.category : "character";
}

const isPart = (item: ImportItem, row: Row) => item.source.kind === "archive" && !item.source.main && !row.own;
const isSplit = (item: ImportItem) => item.source.kind === "archive" && !item.source.main;

/** Where an item comes from, in words: "Mods/Furina/Casual" or "bennettbeachday.zip". */
function sourceLabel(item: ImportItem): string {
  if (item.source.kind === "installed") return `Mods/${item.source.folders.join(" + Mods/")}`;
  return fileName(item.source.archive);
}

const REASON: Record<string, string> = { hash: "by hash", learned: "learned", name: "by name", folder: "from folder name" };

/** SPEC §5: the first-run import and Re-scan review. Nothing changes on disk until "Import". */
export function ImportReview() {
  const snapshot = useApp((s) => s.snapshot)!;
  const setSnapshot = useApp((s) => s.setSnapshot);
  const replace = useApp((s) => s.replace);
  const back = useApp((s) => s.back);
  const toast = useApp((s) => s.toast);
  const nsfwVisible = useHome((s) => s.nsfwVisible);
  const setNsfwVisible = useHome((s) => s.setNsfwVisible);
  const reduced = useReduced();
  const entities = snapshot.library.entities;
  const [phase, setPhase] = useState<Phase>({ kind: "reading", progress: null });
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [moveArchives, setMoveArchives] = useState(true);
  const [moveStray, setMoveStray] = useState(true);
  const [keep, setKeep] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<string | null>(null);
  // the row whose group just changed; it rides above the others while it moves
  const [moved, setMoved] = useState<string | null>(null);

  const read = useCallback(async () => {
    setPhase({ kind: "reading", progress: null });
    try {
      const p = await api.planImport((progress) => setPhase({ kind: "reading", progress }));
      const lib = useApp.getState().snapshot?.library.entities ?? [];
      setPlan(p);
      setRows(
        Object.fromEntries(
          p.items.map((i) => [i.key, { include: true, entity: guessChoice(i, lib), skinName: i.skinName, nsfw: i.nsfw, own: i.own }]),
        ),
      );
      setPhase({ kind: "review" });
    } catch (e) {
      setPhase({ kind: "error", message: toFailure(e).message });
    }
  }, []);

  useEffect(() => {
    // reading the plan is the page's whole purpose; it reports progress as archives are read
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void read();
  }, [read]);

  const leave = useCallback(() => {
    if (useApp.getState().history.length) back();
    else replace({ name: "home" }, -1);
  }, [back, replace]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || (e.target as HTMLElement).closest("input, textarea, select")) return;
      if (useApp.getState().route.name !== "import" || phase.kind === "importing") return;
      e.preventDefault();
      leave();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [leave, phase.kind]);

  const items = useMemo(() => plan?.items ?? [], [plan]);
  const parentIncluded = (i: ImportItem) => !i.parent || rows[i.parent]?.include !== false;
  const setRow = (key: string, patch: Partial<Row>) => {
    if (patch.entity || patch.own !== undefined) setMoved(key);
    setRows((r) => ({ ...r, [key]: { ...r[key], ...patch } }));
  };

  // entities the rows may land in: the library's, plus every new one proposed or typed
  const proposed = useMemo(() => {
    const m = new Map<string, Extract<EntityChoice, { kind: "new" }>>();
    for (const r of Object.values(rows)) if (r.entity.kind === "new" && r.entity.name.trim()) m.set(entityKey(r.entity), r.entity);
    for (const i of items) {
      const c = guessChoice(i, entities);
      if (c.kind === "new" && !m.has(entityKey(c))) m.set(entityKey(c), c);
    }
    return [...m.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name));
  }, [rows, items, entities]);

  const groups = useMemo(() => {
    const m = new Map<string, { key: string; label: string; category: Category; isNew: boolean; items: ImportItem[] }>();
    for (const i of items) {
      const r = rows[i.key];
      if (!r || isPart(i, r)) continue;
      const k = entityKey(r.entity);
      const g = m.get(k) ?? {
        key: k,
        label: choiceName(r.entity, entities) || "Choose where these go",
        category: categoryOf(r.entity, entities),
        isNew: r.entity.kind === "new",
        items: [],
      };
      g.items.push(i);
      m.set(k, g);
    }
    return [...m.values()].sort((a, b) =>
      a.key === "none" ? -1 : b.key === "none" ? 1 : CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) || a.label.localeCompare(b.label),
    );
  }, [items, rows, entities]);

  // SPEC §5 step 5: entities that would have two or more skins on
  const conflicts = useMemo(() => {
    const m = new Map<string, { key: string; label: string; options: { key: string; label: string; nsfw: boolean }[] }>();
    const add = (k: string, label: string, opt: { key: string; label: string; nsfw: boolean }) => {
      const c = m.get(k) ?? { key: k, label, options: [] };
      c.options.push(opt);
      m.set(k, c);
    };
    for (const [eid, ids] of Object.entries(snapshot.disk.active)) {
      const ent = entities.find((e) => e.id === eid);
      for (const id of ids) {
        const s = snapshot.library.skins.find((k) => k.id === id);
        if (s && ent) add(`id:${eid}`, ent.name, { key: s.id, label: `${s.name} (already in the library)`, nsfw: s.nsfw });
      }
    }
    for (const i of items) {
      const r = rows[i.key];
      if (i.source.kind !== "installed" || !r?.include || r.entity.kind === "none") continue;
      add(entityKey(r.entity), choiceName(r.entity, entities), { key: i.key, label: r.skinName || i.skinName, nsfw: r.nsfw });
    }
    return [...m.values()].filter((c) => c.options.length > 1);
  }, [items, rows, entities, snapshot]);

  const problems = items.filter((i) => {
    const r = rows[i.key];
    return r?.include && parentIncluded(i) && !isPart(i, r) && !target(r.entity, r.skinName.trim() || i.skinName);
  }).length;
  const count = items.filter((i) => {
    const r = rows[i.key];
    return r?.include && parentIncluded(i) && !isPart(i, r);
  }).length;
  const archiveCount = new Set(
    items.flatMap((i) => (i.source.kind === "archive" && i.source.main && rows[i.key]?.include ? [i.source.archive] : [])),
  ).size;

  const submit = async () => {
    if (!plan || problems) return;
    const keepActive = conflicts.map((c) => keep[c.key]).filter((k): k is string => !!k && k !== "all");
    const req: ImportRequest = {
      choices: plan.items.map((i) => {
        const r = rows[i.key];
        const name = r.skinName.trim() || i.skinName;
        const t = target(r.entity, name) ?? { skinName: name };
        return { ...t, key: i.key, include: r.include && parentIncluded(i), nsfw: r.nsfw, own: r.own };
      }),
      moveArchives,
      moveStray,
      keepActive,
    };
    setPhase({ kind: "importing", progress: null });
    try {
      const out = await api.applyImport(req, (progress) => setPhase({ kind: "importing", progress }));
      setSnapshot(out.snapshot);
      toast({ kind: "success", text: `Imported ${out.added} skin${out.added === 1 ? "" : "s"}.` });
      for (const w of out.warnings) toast({ kind: "info", text: w, ttl: 10000 });
      replace({ name: "home" }, 1);
    } catch (e) {
      toast({ kind: "error", text: "The import stopped.", detail: toFailure(e).message, ttl: 10000 });
      void read();
    }
  };

  if (phase.kind === "reading" || phase.kind === "error") {
    return (
      <div className="imp imp--center">
        <motion.div className="imp__card" initial={{ opacity: 0, y: reduced ? 0 : 8 }} animate={{ opacity: 1, y: 0, transition: spring.gentle }}>
          {phase.kind === "reading" ? (
            <>
              <h1 className="imp__title">Reading your mods</h1>
              <p className="imp__lede">Looking through the Mods folder and the archives in it. Your Mods folder isn't changed.</p>
              <AddProgressBar
                progress={phase.progress ? { ...phase.progress, label: phase.progress.total ? "Reading archives" : "Scanning" } : { done: 0, total: 1, label: "Scanning" }}
              />
              <span className="imp__file">{phase.progress?.label ? fileName(phase.progress.label) : ""}</span>
            </>
          ) : (
            <>
              <h1 className="imp__title">Couldn't read the Mods folder</h1>
              <p className="imp__lede">{phase.message}</p>
              <div className="imp__row-actions">
                <button className="btn" onClick={leave}>
                  Back
                </button>
                <button className="btn btn--primary" onClick={() => void read()}>
                  Try again
                </button>
              </div>
            </>
          )}
        </motion.div>
      </div>
    );
  }

  const nothing = !items.length && !plan?.stray.length && !plan?.archives.some((a) => a.error);
  if (nothing) {
    return (
      <div className="imp imp--center">
        <motion.div className="imp__card" initial={{ opacity: 0, y: reduced ? 0 : 8 }} animate={{ opacity: 1, y: 0, transition: spring.gentle }}>
          <h1 className="imp__title">Nothing new to import</h1>
          <p className="imp__lede">Every mod in the Mods folder is already in the library.</p>
          <button className="btn btn--primary" onClick={leave} data-autofocus>
            Back
          </button>
        </motion.div>
      </div>
    );
  }

  const installed = items.filter((i) => i.source.kind === "installed").length;
  const archives = plan?.archives.length ?? 0;
  const busy = phase.kind === "importing";

  return (
    <div className="imp">
      <header className="imp__head">
        <div>
          <h1 className="imp__title">Review your mods</h1>
          <p className="imp__lede">
            Found {installed} installed mod{installed === 1 ? "" : "s"}
            {archives ? ` and ${archives} archive${archives === 1 ? "" : "s"}` : ""}. Check where each one goes; nothing changes
            until you press Import.
          </p>
        </div>
        <span className="imp__spacer" />
        <button type="button" className={`nsfw-chip ${nsfwVisible ? "is-visible" : ""}`} onClick={() => setNsfwVisible(!nsfwVisible)}>
          18+ {nsfwVisible ? "VISIBLE" : "HIDDEN"} · {snapshot.settings.nsfw.hotkey.toUpperCase()}
        </button>
      </header>

      <LayoutGroup>
        <motion.div className="imp__groups" variants={staggerContainer(groups.length, reduced, 0.05)} initial="hidden" animate="show">
          {groups.map((g) => (
            <motion.section key={g.key} layout="position" className={`imp-group ${moved && g.items.some((i) => i.key === moved) ? "is-lifted" : ""}`} variants={riseIn(reduced)} transition={spring.smooth}>
              <h2 className="imp-group__head">
                <span className="imp-group__name">{g.label}</span>
                {g.key !== "none" && <span className="imp-group__cat caps">{CATEGORY_LABEL[g.category].replace(/s$/, "")}</span>}
                {g.isNew && <span className="tag tag--new">New</span>}
                <span className="imp-group__count num">{g.items.length}</span>
              </h2>
              <AnimatePresence initial={false}>
                {g.items.map((i) => (
                  <ImportRow
                    key={i.key}
                    item={i}
                    row={rows[i.key]}
                    parts={items.filter((p) => p.parent === i.key && rows[p.key] && isPart(p, rows[p.key]))}
                    rows={rows}
                    disabled={busy || !parentIncluded(i)}
                    parentName={i.parent ? rows[i.parent]?.skinName : undefined}
                    entities={entities}
                    proposed={proposed}
                    editing={editing === i.key}
                    moving={moved === i.key}
                    onMoved={() => setMoved((m) => (m === i.key ? null : m))}
                    nsfwVisible={nsfwVisible}
                    reduced={reduced}
                    onEdit={(v) => setEditing(v ? i.key : null)}
                    onChange={(patch) => setRow(i.key, patch)}
                    onChangePart={(key, patch) => setRow(key, patch)}
                  />
                ))}
              </AnimatePresence>
            </motion.section>
          ))}
        </motion.div>
      </LayoutGroup>

      <AnimatePresence initial={false}>
        {conflicts.length > 0 && (
          <motion.section
            key="conflicts"
            className="imp-box"
            initial={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
            animate={reduced ? { opacity: 1 } : { opacity: 1, height: "auto", transition: spring.smooth }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, height: 0, transition: tween.small }}
          >
            <div className="imp-box__inner">
              <h2 className="caps imp-box__h">Several skins are on</h2>
              <p className="imp-box__lede">3DMigoto loads every enabled skin of a character at once. Pick the one to keep on; the others move to the stash.</p>
              {conflicts.map((c) => (
                <div key={c.key} className="imp-conflict" role="radiogroup" aria-label={`${c.label}: skin to keep on`}>
                  <span className="imp-conflict__name">{c.label}</span>
                  <div className="imp-conflict__opts">
                    {[...c.options.map((o) => ({ key: o.key, label: o.nsfw && !nsfwVisible ? "A hidden 18+ skin" : o.label })), { key: "all", label: "Leave them all on" }].map((o) => {
                      const on = (keep[c.key] ?? "all") === o.key;
                      return (
                        <button key={o.key} type="button" role="radio" aria-checked={on} className={`imp-pill ${on ? "is-on" : ""}`} onClick={() => setKeep((k) => ({ ...k, [c.key]: o.key }))} disabled={busy}>
                          {o.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </motion.section>
        )}
      </AnimatePresence>

      {(archives > 0 || (plan?.stray.length ?? 0) > 0) && (
        <section className="imp-box">
          <div className="imp-box__inner">
            <h2 className="caps imp-box__h">Archives</h2>
            {archives > 0 && (
              <label className="imp-check">
                <input type="checkbox" checked={moveArchives} onChange={(e) => setMoveArchives(e.target.checked)} disabled={busy} />
                <span>
                  Move the imported archives{archiveCount ? ` (${archiveCount})` : ""} to <code>{snapshot.settings.libraryPath}\archives</code>
                  <small>Keeps the Mods folder for mods only; every skin can be re-extracted from its archive later.</small>
                </span>
              </label>
            )}
            {(plan?.stray.length ?? 0) > 0 && (
              <label className="imp-check">
                <input type="checkbox" checked={moveStray} onChange={(e) => setMoveStray(e.target.checked)} disabled={busy} />
                <span>
                  Move {plan!.stray.length} loose archive{plan!.stray.length === 1 ? "" : "s"} from the Mods folder to the Library
                  <small>{plan!.stray.join(", ")}</small>
                </span>
              </label>
            )}
            {plan?.archives
              .filter((a) => a.error)
              .map((a) => (
                <p key={a.path} className="imp-error">
                  <strong>{fileName(a.path)}</strong> can't be imported: {a.error}
                </p>
              ))}
          </div>
        </section>
      )}

      <footer className="imp__foot">
        <AnimatePresence mode="popLayout" initial={false}>
          {busy ? (
            <motion.div key="p" className="imp__progress" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: tween.small }} exit={{ opacity: 0 }}>
              <AddProgressBar progress={phase.progress ?? { done: 0, total: 1, label: "Importing" }} />
            </motion.div>
          ) : (
            <motion.span key="s" className="imp__summary" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: tween.small }} exit={{ opacity: 0 }}>
              {problems ? `${problems} skin${problems === 1 ? "" : "s"} still need a character, weapon or extra.` : "Nothing changes until you press Import."}
            </motion.span>
          )}
        </AnimatePresence>
        <button className="btn" onClick={leave} disabled={busy}>
          Skip for now
        </button>
        <button className="btn btn--primary" onClick={() => void submit()} disabled={busy || !!problems || count === 0}>
          {busy && <span className="spinner" aria-hidden />}
          {busy ? "Importing" : `Import ${count} skin${count === 1 ? "" : "s"}`}
        </button>
      </footer>
    </div>
  );
}

function ImportRow({
  item,
  row,
  parts,
  rows,
  disabled,
  parentName,
  entities,
  proposed,
  editing,
  moving,
  onMoved,
  nsfwVisible,
  reduced,
  onEdit,
  onChange,
  onChangePart,
}: {
  item: ImportItem;
  row: Row;
  parts: ImportItem[];
  rows: Record<string, Row>;
  disabled: boolean;
  parentName?: string;
  entities: Entity[];
  proposed: [string, Extract<EntityChoice, { kind: "new" }>][];
  editing: boolean;
  moving: boolean;
  onMoved: () => void;
  nsfwVisible: boolean;
  reduced: boolean;
  onEdit: (v: boolean) => void;
  onChange: (patch: Partial<Row>) => void;
  onChangePart: (key: string, patch: Partial<Row>) => void;
}) {
  const hidden = row.nsfw && !nsfwVisible;
  const off = !row.include || disabled;
  const split = isSplit(item);
  const value = row.entity.kind === "existing" ? entityKey(row.entity) : row.entity.kind === "new" ? entityKey(row.entity) : "";
  const pick = (v: string) => {
    if (v === OTHER) return onEdit(true);
    if (v.startsWith("id:")) return onChange({ entity: { kind: "existing", id: v.slice(3) } });
    const p = proposed.find(([k]) => k === v);
    if (p) onChange({ entity: p[1] });
  };
  const source =
    item.source.kind === "archive" && hidden ? `An archive in ${item.source.archive.split("/").slice(0, -1).join("/") || "Mods"}` : sourceLabel(item);
  return (
    <motion.div
      layoutId={item.key}
      layout="position"
      className={`imp-row ${off ? "is-off" : ""} ${moving ? "is-moving" : ""}`}
      onLayoutAnimationComplete={moving ? onMoved : undefined}
      // a row arriving from another group is already on screen, so it moves instead of fading in
      initial={moving ? false : { opacity: 0 }}
      animate={{ opacity: 1, transition: tween.small }}
      exit={{ opacity: 0, transition: tween.micro }}
      transition={spring.smooth}
    >
      <div className="imp-row__main">
        <input
          type="checkbox"
          className="imp-row__check"
          checked={row.include && !disabled}
          disabled={disabled}
          aria-label={hidden ? "Import this hidden 18+ skin" : `Import ${row.skinName}`}
          onChange={(e) => onChange({ include: e.target.checked })}
        />
        <div className="imp-row__text">
          {hidden ? (
            <span className="imp-row__hidden">
              Hidden 18+ skin <span className="tag tag--nsfw">18+</span>
            </span>
          ) : (
            <input className="input imp-row__name" aria-label="Skin name" value={row.skinName} disabled={off} onChange={(e) => onChange({ skinName: e.target.value })} />
          )}
          <span className="imp-row__meta">
            <span className={`imp-badge imp-badge--${item.guess.reason}`}>{REASON[item.guess.reason] ?? item.guess.reason}</span>
            <span className="imp-row__src" title={source}>
              {split ? `${source} · inside ${parentName ?? "the main skin"}` : source}
            </span>
            {item.hotkeys > 0 && <span>{item.hotkeys} hotkey{item.hotkeys === 1 ? "" : "s"}</span>}
            {item.images > 0 && <span>{item.images} image{item.images === 1 ? "" : "s"}</span>}
          </span>
        </div>
        {split && (
          <div className="imp-seg" role="radiogroup" aria-label="Where this folder goes">
            <button type="button" role="radio" aria-checked={row.own} className="imp-seg__opt" onClick={() => onChange({ own: true })} disabled={off}>
              Its own skin
            </button>
            <button type="button" role="radio" aria-checked={!row.own} className="imp-seg__opt" onClick={() => onChange({ own: false })} disabled={off}>
              Part of {parentName ?? "main"}
            </button>
          </div>
        )}
        <select className={`input imp-row__entity ${row.entity.kind === "none" ? "is-invalid" : ""}`} aria-label="Belongs to" value={value} disabled={off} onChange={(e) => pick(e.target.value)}>
          {row.entity.kind === "none" && <option value="">Choose…</option>}
          {CATEGORY_ORDER.map((cat) => {
            const list = entities.filter((e) => e.category === cat).sort((a, b) => a.name.localeCompare(b.name));
            const fresh = proposed.filter(([, n]) => n.category === cat);
            return list.length || fresh.length ? (
              <optgroup key={cat} label={CATEGORY_LABEL[cat]}>
                {list.map((e) => (
                  <option key={e.id} value={`id:${e.id}`}>
                    {e.name}
                  </option>
                ))}
                {fresh.map(([k, n]) => (
                  <option key={k} value={k}>
                    {n.name} (new)
                  </option>
                ))}
              </optgroup>
            ) : null;
          })}
          <option value={OTHER}>Something else…</option>
        </select>
        <span className="imp-row__nsfw" title={split ? "Follows the skin it came from" : undefined}>
          18+
          <Switch label="NSFW" checked={row.nsfw} onChange={(v) => onChange({ nsfw: v })} disabled={off || split} />
        </span>
      </div>
      <AnimatePresence initial={false}>
        {editing && (
          <motion.div
            className="imp-row__edit"
            initial={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
            animate={reduced ? { opacity: 1 } : { opacity: 1, height: "auto", transition: spring.smooth }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, height: 0, transition: tween.small }}
          >
            <NewEntityEditor
              initial={row.entity.kind === "new" ? row.entity : null}
              onDone={(entity) => {
                if (entity) onChange({ entity });
                onEdit(false);
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>
      {parts.length > 0 && (
        <div className="imp-row__parts">
          {parts.map((p) => (
            <div key={p.key} className="imp-part">
              <span className="imp-part__label">
                + {sourceLabelShort(p)} <span className="imp-part__muted">({p.guess.name}, kept in this skin)</span>
              </span>
              <button type="button" className="link" onClick={() => onChangePart(p.key, { own: true })} disabled={off}>
                Make it its own skin
              </button>
              <input
                type="checkbox"
                aria-label={`Keep ${sourceLabelShort(p)}`}
                checked={rows[p.key]?.include !== false}
                disabled={off}
                onChange={(e) => onChangePart(p.key, { include: e.target.checked })}
              />
            </div>
          ))}
        </div>
      )}
    </motion.div>
  );
}

function sourceLabelShort(i: ImportItem): string {
  return i.source.kind === "archive" ? i.source.root || "(top level)" : i.source.folders[0];
}

function NewEntityEditor({
  initial,
  onDone,
}: {
  initial: Extract<EntityChoice, { kind: "new" }> | null;
  onDone: (e: Extract<EntityChoice, { kind: "new" }> | null) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [category, setCategory] = useState<Category>(initial?.category ?? "character");
  const done = () => onDone(name.trim() ? { kind: "new", name: name.trim(), category } : null);
  return (
    <div className="imp-new">
      <input
        className="input"
        aria-label="New character, weapon or extra"
        placeholder="Name"
        value={name}
        autoFocus
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") done();
          if (e.key === "Escape") {
            e.stopPropagation();
            onDone(null);
          }
        }}
      />
      <CategoryPick value={category} onChange={setCategory} options={["character", "weapon", "extra"]} />
      <button type="button" className="btn btn--sm btn--ghost" onClick={() => onDone(null)}>
        Cancel
      </button>
      <button type="button" className="btn btn--sm btn--primary" onClick={done} disabled={!name.trim()}>
        Use
      </button>
    </div>
  );
}
