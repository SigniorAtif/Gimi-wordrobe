import { AnimatePresence, motion, useAnimate } from "motion/react";
import { useId, useMemo, useState } from "react";
import type { ArchiveEntry, ArchiveSummary, Category, Entity } from "../api/types";
import {
  AddProgressBar,
  CategoryPick,
  EntitySelect,
  FieldError,
  fileName,
  formatSize,
  GameBananaStatus,
  PortraitDrop,
  PreviewPicker,
  useAddDraft,
  useGameBananaLookup,
} from "../components/AddFields";
import { AutoHeight } from "../components/AutoHeight";
import { Modal } from "../components/Modal";
import { Switch } from "../components/Switch";
import {
  checkDraft,
  choiceName,
  defaultSplitName,
  guessChoice,
  rootLabel,
  sameChoice,
  type AddDraft,
  type EntityChoice,
  type RootDraft,
  withRootIncluded,
} from "../lib/addDraft";
import { useReduced } from "../lib/useReduced";
import { shake, spring, tween } from "../motion";
import { useRedact } from "../lib/useRedact";
import { useAdd } from "../store/add";
import { useApp } from "../store/app";
import "./AddDialog.css";

const NEW = "__new";

/** A4 (SPEC §6): the full add dialog. Opens for drops outside a card, "+ Add", and "More options…" in C4. */
export function AddDialog() {
  const flow = useAdd((s) => (s.flow?.kind === "a4" ? s.flow : null));
  const busy = useAdd((s) => s.busy);
  const progress = useAdd((s) => s.progress);
  const close = useAdd((s) => s.close);
  const browse = useAdd((s) => s.browse);
  const submit = useAdd((s) => s.submit);
  const entities = useApp((s) => s.snapshot?.library.entities) ?? [];
  const nsfwKey = useApp((s) => s.snapshot?.settings.nsfw.hotkey) ?? "Ctrl+H";
  const redact = useRedact();
  const [draft, setDraft] = useAddDraft(flow, entities, true);
  const [attempted, setAttempted] = useState(false);
  const [creating, setCreating] = useState(false);
  const [seenPath, setSeenPath] = useState(flow?.archivePath);
  const [btn, animateBtn] = useAnimate();
  const reduced = useReduced();
  if (flow?.archivePath !== seenPath) {
    setSeenPath(flow?.archivePath);
    setAttempted(false);
    setCreating(false);
  }

  const summary = flow?.summary ?? null;
  const gb = useGameBananaLookup(draft, setDraft, summary, entities);
  const check = draft && summary ? checkDraft(draft, summary, entities) : null;
  const errors = attempted ? (check?.errors ?? {}) : {};
  const detected = summary ? guessChoice(summary.roots[0], entities) : null;

  const onAdd = async () => {
    setAttempted(true);
    if (!check?.request || !draft) {
      if (btn.current) void animateBtn(btn.current, shake.x, shake.transition);
      return;
    }
    await submit(check.request, choiceName(draft.entity, entities));
  };

  const destination = draft && summary ? destinationText(draft, summary, entities) : "";

  return (
    <Modal open={!!flow} onClose={close} label="Add skin" width={900}>
      {flow && (
        <form
          className="a4"
          onSubmit={(e) => {
            e.preventDefault();
            void onAdd();
          }}
        >
          <header className="a4__head">
            <h2 className="a4__title">Add skin</h2>
            <button type="button" className="btn btn--icon" aria-label="Close" onClick={close} disabled={busy}>
              ×
            </button>
          </header>
          <div className="a4__body">
            {/* the dialog grows smoothly when the archive summary replaces the placeholders */}
            <AutoHeight reduced={reduced} className="a4__auto">
            <div className="a4__cols">
            <section className="a4__left" aria-label="Archive">
              <div className="a4__archive">
                <span className="a4__archive-name" title={flow.archivePath}>
                  {fileName(flow.archivePath)}
                </span>
                <span className="a4__archive-meta">
                  {summary
                    ? `${formatSize(summary.size)} · ${summary.roots.length} mod folder${summary.roots.length === 1 ? "" : "s"} · ${summary.images.length} image${summary.images.length === 1 ? "" : "s"} · ${summary.iniCount} .ini`
                    : flow.error
                      ? "Couldn't read this archive"
                      : "Reading…"}
                </span>
                <button type="button" className="btn btn--sm" onClick={() => void browse(flow.entityId)} disabled={busy}>
                  Choose another…
                </button>
              </div>
              {flow.error ? (
                  <motion.p key="err" className="a4__error" role="alert" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: tween.small }}>
                    {redact(flow.error)}
                  </motion.p>
                ) : !summary || !draft ? (
                  <div key="loading" className="a4__loading">
                    {[70, 50, 85, 40, 60].map((w, i) => (
                      <span key={i} className="add-skeleton" style={{ width: `${w}%` }} />
                    ))}
                  </div>
                ) : (
                  <motion.div key="tree" className="a4__inside" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: tween.small }}>
                    <FieldError text={errors.archive} />
                    {summary.roots.length > 1 && (
                      <RootList summary={summary} draft={draft} setDraft={setDraft} entities={entities} error={errors.roots} />
                    )}
                    <h3 className="caps a4__h">Inside the archive</h3>
                    <ArchiveTree summary={summary} />
                    {leftOut(summary).length > 0 && (
                      <p className="a4__skipped">
                        Left out: {leftOut(summary).slice(0, 3).join(", ")}
                        {leftOut(summary).length > 3 ? ` and ${leftOut(summary).length - 3} more` : ""} (junk files and bundled library copies)
                      </p>
                    )}
                  </motion.div>
                )}
            </section>
            <section className="a4__right" aria-label="Details">
              {draft && summary ? (
                <motion.div className="a4__form" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: tween.small }}>
                  <div className="a4__grid">
                    <div className="a4__field">
                      <span className="caps a4__label">
                        {entityLabel(draft.entity, entities)}
                        {detected && detected.kind !== "none" && sameChoice(detected, draft.entity) && (
                          <span className="a4__guess"> · detected by {reasonLabel(summary.roots[0]?.guess?.reason)}</span>
                        )}
                      </span>
                      <select
                        className={`input ${errors.entity ? "is-invalid" : ""}`}
                        aria-label="Character, weapon or extra"
                        value={draft.entity.kind === "existing" ? draft.entity.id : draft.entity.kind === "new" ? NEW : ""}
                        onChange={(e) => {
                          const v = e.target.value;
                          if (v === NEW) setCreating(true);
                          else setDraft({ ...draft, entity: v ? { kind: "existing", id: v } : { kind: "none" } });
                        }}
                      >
                        {draft.entity.kind === "none" && <option value="">Choose…</option>}
                        {draft.entity.kind === "new" && (
                          <option value={NEW}>
                            New: {draft.entity.name || "unnamed"} ({draft.entity.category})
                          </option>
                        )}
                        <EntityOptions entities={entities} />
                      </select>
                      <FieldError text={errors.entity} />
                    </div>
                    <div className="a4__field">
                      <span className="caps a4__label">Skin name</span>
                      <input
                        className={`input ${errors.skinName ? "is-invalid" : ""}`}
                        aria-label="Skin name"
                        value={draft.skinName}
                        // the dialog opens before the archive is read; focus the name once it appears
                        autoFocus
                        onChange={(e) => setDraft({ ...draft, skinName: e.target.value })}
                      />
                      <FieldError text={errors.skinName} />
                    </div>
                  </div>
                  <div className="a4__newrow">
                    <button type="button" className="btn btn--sm" onClick={() => setCreating((v) => !v)} aria-expanded={creating}>
                      + New character…
                    </button>
                    {draft.entity.kind === "new" && !creating && (
                      <span className="a4__newnote">
                        Creates <strong>{draft.entity.name || "a new entry"}</strong> ({draft.entity.category})
                      </span>
                    )}
                  </div>
                  <NewEntityPanel
                    open={creating}
                    initial={draft.entity.kind === "new" ? draft.entity : null}
                    onCancel={() => setCreating(false)}
                    onCreate={(entity) => {
                      setDraft({ ...draft, entity });
                      setCreating(false);
                    }}
                  />
                  <div className="a4__grid">
                    <div className="a4__field">
                      <span className="caps a4__label">GameBanana link (optional)</span>
                      <input
                        className={`input ${errors.gbUrl ? "is-invalid" : ""}`}
                        aria-label="GameBanana link"
                        placeholder="https://gamebanana.com/mods/…"
                        spellCheck={false}
                        value={draft.gbUrl}
                        onChange={(e) => setDraft({ ...draft, gbUrl: e.target.value })}
                      />
                      <FieldError text={errors.gbUrl} />
                      <GameBananaStatus lookup={gb} />
                    </div>
                    <div className="a4__field">
                      <span className="caps a4__label">Author (optional)</span>
                      <input className="input" aria-label="Author" value={draft.author} onChange={(e) => setDraft({ ...draft, author: e.target.value })} />
                    </div>
                  </div>
                  <div className="a4__line">
                    <Switch label="NSFW / 18+" checked={draft.nsfw} onChange={(v) => setDraft({ ...draft, nsfw: v })} />
                    <span>NSFW / 18+</span>
                    <span className="a4__muted">· hidden behind {nsfwKey} once added</span>
                  </div>
                  <div className="a4__field">
                    <span className="caps a4__label">Preview source</span>
                    <PreviewPicker draft={draft} setDraft={setDraft} imageCount={summary.images.length} gbImages={gb.state === "ok" ? gb.info.images.length : undefined} />
                    <FieldError text={errors.preview} />
                  </div>
                  <div className="a4__line">
                    <Switch label="Make it the active skin after adding" checked={draft.makeActive} onChange={(v) => setDraft({ ...draft, makeActive: v })} />
                    <span>Make it the active skin after adding</span>
                  </div>
                </motion.div>
              ) : (
                <div className="a4__loading a4__loading--right">
                  {[40, 90, 30, 90, 60].map((w, i) => (
                    <span key={i} className="add-skeleton" style={{ width: `${w}%` }} />
                  ))}
                </div>
              )}
            </section>
            </div>
            </AutoHeight>
          </div>
          <footer className="a4__foot">
            <AnimatePresence mode="popLayout" initial={false}>
              {busy && progress ? (
                <motion.div key="progress" className="a4__progress" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: tween.small }} exit={{ opacity: 0 }}>
                  <AddProgressBar progress={progress} />
                </motion.div>
              ) : (
                <motion.span key={destination} className="a4__dest" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: tween.small }} exit={{ opacity: 0, transition: tween.micro }}>
                  {destination}
                </motion.span>
              )}
            </AnimatePresence>
            <button type="button" className="btn" onClick={close} disabled={busy}>
              Cancel
            </button>
            <button ref={btn} type="submit" className="btn btn--primary" disabled={busy || !!flow.error || !summary}>
              {busy && <span className="spinner" aria-hidden />}
              {busy ? "Adding" : "Extract & add"}
            </button>
          </footer>
        </form>
      )}
    </Modal>
  );
}

function entityLabel(c: EntityChoice, entities: Entity[]): string {
  const cat = c.kind === "existing" ? entities.find((e) => e.id === c.id)?.category : c.kind === "new" ? c.category : undefined;
  return cat === "weapon" ? "Weapon" : cat === "extra" ? "Extra" : "Character";
}

/** Names of the files that won't be added (folders listed in `skipped` are implied by their files). */
function leftOut(s: ArchiveSummary): string[] {
  return [...new Set(s.skipped.filter((p) => !p.endsWith("/")).map(fileName))];
}

function reasonLabel(r: string | undefined): string {
  return r === "hash" ? "hash" : r === "learned" ? "an earlier import" : r === "name" ? "name" : "folder name";
}

function destinationText(draft: AddDraft, summary: ArchiveSummary, entities: Entity[]): string {
  const main = `${choiceName(draft.entity, entities) || "?"} / ${draft.skinName.trim() || "?"}`;
  const splitName = defaultSplitName(draft, entities);
  const splits = draft.roots.flatMap((r, i) => (i > 0 && r.include && r.own && summary.roots[i] ? [`${choiceName(r.entity, entities) || "?"} / ${r.skinName.trim() || splitName}`] : []));
  return `Extracts & files it under ${[main, ...splits].join(" and ")}`;
}

function EntityOptions({ entities }: { entities: Entity[] }) {
  const groups: [Category, string][] = [
    ["character", "Characters"],
    ["weapon", "Weapons"],
    ["extra", "Extras"],
  ];
  return (
    <>
      {groups.map(([cat, label]) => {
        const list = entities.filter((e) => e.category === cat).sort((a, b) => a.name.localeCompare(b.name));
        return list.length ? (
          <optgroup key={cat} label={label}>
            {list.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </optgroup>
        ) : null;
      })}
    </>
  );
}

/** "+ New character…" sub-panel: name, category and a portrait; opens in place (height + fade). */
function NewEntityPanel({
  open,
  initial,
  onCreate,
  onCancel,
}: {
  open: boolean;
  initial: Extract<EntityChoice, { kind: "new" }> | null;
  onCreate: (e: Extract<EntityChoice, { kind: "new" }>) => void;
  onCancel: () => void;
}) {
  const reduced = useReduced();
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          className="a4__sub"
          initial={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
          animate={reduced ? { opacity: 1 } : { opacity: 1, height: "auto", transition: spring.smooth }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, height: 0, transition: tween.small }}
        >
          <NewEntityForm initial={initial} onCreate={onCreate} onCancel={onCancel} />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function NewEntityForm({
  initial,
  onCreate,
  onCancel,
}: {
  initial: Extract<EntityChoice, { kind: "new" }> | null;
  onCreate: (e: Extract<EntityChoice, { kind: "new" }>) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [category, setCategory] = useState<Category>(initial?.category ?? "character");
  const [portrait, setPortrait] = useState(initial?.portraitPath);
  const dropped = useAdd((s) => s.droppedImage);
  const [seenDrop, setSeenDrop] = useState(dropped);
  if (dropped !== seenDrop) {
    setSeenDrop(dropped);
    if (dropped?.target === "portrait") setPortrait(dropped.path);
  }
  const id = useId();
  const create = () => name.trim() && onCreate({ kind: "new", name: name.trim(), category, portraitPath: portrait });
  return (
    <div className="a4__sub-inner">
      <PortraitDrop path={portrait} name={name} onChange={setPortrait} />
      <div className="a4__sub-fields">
        <input
          id={`${id}-name`}
          className="input"
          aria-label="Name"
          placeholder="Name"
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              create();
            }
          }}
        />
        <div className="a4__sub-row">
          <CategoryPick value={category} onChange={setCategory} options={["character", "weapon", "extra"]} />
          <span className="a4__spacer" />
          <button type="button" className="btn btn--sm btn--ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn btn--sm btn--primary" onClick={create} disabled={!name.trim()}>
            Create
          </button>
        </div>
      </div>
    </div>
  );
}

/** Several mod folders in one archive (SPEC §5 extras): keep each in the skin, split it into its own, or leave it out. */
function RootList({
  summary,
  draft,
  setDraft,
  entities,
  error,
}: {
  summary: ArchiveSummary;
  draft: AddDraft;
  setDraft: (d: AddDraft) => void;
  entities: Entity[];
  error?: string;
}) {
  const setRoot = (i: number, patch: Partial<RootDraft>) => setDraft({ ...draft, roots: draft.roots.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const setInclude = (i: number, include: boolean) => setDraft(withRootIncluded(draft, summary, i, include));
  const splitName = defaultSplitName(draft, entities);
  return (
    <div className="roots">
      <h3 className="caps a4__h">Mod folders</h3>
      {summary.roots.map((root, i) => {
        const d = draft.roots[i];
        if (!d) return null;
        const main = i === 0;
        const guess = root.guess;
        return (
          <div key={`${root.path}|${i}`} className={`roots__row ${d.include ? "" : "is-off"}`}>
            <label className="roots__check">
              <input
                type="checkbox"
                checked={d.include}
                disabled={main}
                title={main ? "The main skin" : undefined}
                onChange={(e) => setInclude(i, e.target.checked)}
              />
              <span className="roots__name" title={rootLabel(root, summary)}>
                {rootLabel(root, summary)}
              </span>
              {guess && (
                <span className="roots__guess">
                  {guess.name} · {guess.category}
                </span>
              )}
            </label>
            {!main && (
              <AnimatePresence initial={false}>
                {d.include && (
                  <motion.div
                    className="roots__opts"
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto", transition: spring.smooth }}
                    exit={{ opacity: 0, height: 0, transition: tween.small }}
                  >
                    <div className="roots__mode" role="radiogroup" aria-label={`${rootLabel(root, summary)}: where it goes`}>
                      <button type="button" role="radio" aria-checked={!d.own} className="roots__mode-opt" onClick={() => setRoot(i, { own: false })}>
                        In this skin
                      </button>
                      <button type="button" role="radio" aria-checked={d.own} className="roots__mode-opt" onClick={() => setRoot(i, { own: true })}>
                        Its own skin
                      </button>
                    </div>
                    <AnimatePresence initial={false}>
                      {d.own && (
                        <motion.div
                          className="roots__own"
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: "auto", transition: spring.smooth }}
                          exit={{ opacity: 0, height: 0, transition: tween.small }}
                        >
                          <RootEntitySelect value={d.entity} onChange={(entity) => setRoot(i, { entity })} entities={entities} />
                          <input
                            className="input"
                            aria-label="Skin name for this folder"
                            placeholder={splitName}
                            value={d.skinName}
                            onChange={(e) => setRoot(i, { skinName: e.target.value })}
                          />
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </motion.div>
                )}
              </AnimatePresence>
            )}
          </div>
        );
      })}
      <FieldError text={error} />
    </div>
  );
}

function RootEntitySelect({ value, onChange, entities }: { value: EntityChoice; onChange: (c: EntityChoice) => void; entities: Entity[] }) {
  const [newOne] = useState(value.kind === "new" ? value : null);
  if (!newOne) {
    return (
      <EntitySelect value={value.kind === "existing" ? value.id : ""} onChange={(id) => onChange(id ? { kind: "existing", id } : { kind: "none" })} entities={entities} />
    );
  }
  // detected but not in the library yet: offer to create it, or pick an existing one
  return (
    <select
      className="input"
      aria-label="Where this folder goes"
      value={value.kind === "existing" ? value.id : value.kind === "new" ? NEW : ""}
      onChange={(e) => onChange(e.target.value === NEW ? newOne : e.target.value ? { kind: "existing", id: e.target.value } : { kind: "none" })}
    >
      <option value={NEW}>
        New: {newOne.name} ({newOne.category})
      </option>
      <EntityOptions entities={entities} />
    </select>
  );
}

/** Folder tree of the archive (wrapper folder stripped), folders deeper than one level start closed. */
function ArchiveTree({ summary }: { summary: ArchiveSummary }) {
  // the archive as it is (wrapper folder included); files that won't be added are dimmed
  const tree = useMemo(() => buildTree(summary.entries, new Set(summary.skipped)), [summary]);
  return (
    <div className="tree" role="tree" aria-label="Archive contents">
      {tree.children.length ? <TreeNodes nodes={tree.children} depth={0} /> : <span className="tree__empty">Empty archive</span>}
    </div>
  );
}

interface Node {
  name: string;
  dir: boolean;
  children: Node[];
  files: number;
  skipped: boolean;
}

function buildTree(entries: ArchiveEntry[], skipped: Set<string>): Node {
  const root: Node = { name: "", dir: true, children: [], files: 0, skipped: false };
  for (const e of entries) {
    const parts = e.path.split("/").filter(Boolean);
    if (!parts.length) continue;
    let node = root;
    parts.forEach((part, i) => {
      const last = i === parts.length - 1;
      const dir = !last || e.isDir;
      let child = node.children.find((c) => c.name === part && c.dir === dir);
      if (!child) {
        const path = parts.slice(0, i + 1).join("/") + (dir ? "/" : "");
        child = { name: part, dir, children: [], files: 0, skipped: skipped.has(path) || node.skipped };
        node.children.push(child);
      }
      if (!dir) node.files += 1;
      node = child;
    });
  }
  const count = (n: Node): number => n.children.reduce((s, c) => s + (c.dir ? count(c) : 1), 0);
  const sort = (n: Node) => {
    n.files = count(n);
    n.children.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? 1 : -1));
    n.children.forEach(sort);
  };
  sort(root);
  return root;
}

const MAX_FILES = 8;

function TreeNodes({ nodes, depth }: { nodes: Node[]; depth: number }) {
  const files = nodes.filter((n) => !n.dir);
  const dirs = nodes.filter((n) => n.dir);
  const shown = files.slice(0, MAX_FILES);
  return (
    <ul className="tree__list" role="group">
      {shown.map((f) => (
        <li key={f.name} className={`tree__file ${/\.ini$/i.test(f.name) ? "is-ini" : ""} ${f.skipped ? "is-skipped" : ""}`} role="treeitem">
          {f.name}
          {f.skipped && <span className="tree__note">left out</span>}
        </li>
      ))}
      {files.length > MAX_FILES && <li className="tree__more">and {files.length - MAX_FILES} more files</li>}
      {dirs.map((d) => (
        <TreeDir key={d.name} node={d} depth={depth} />
      ))}
    </ul>
  );
}

function TreeDir({ node, depth }: { node: Node; depth: number }) {
  const [open, setOpen] = useState(depth <= 1 && !node.skipped && node.files <= 12);
  return (
    <li role="treeitem" aria-expanded={open}>
      <button type="button" className={`tree__dir ${node.skipped ? "is-skipped" : ""}`} onClick={() => setOpen((v) => !v)}>
        <motion.span className="tree__caret" animate={{ rotate: open ? 90 : 0 }} transition={tween.micro} aria-hidden>
          ▸
        </motion.span>
        {node.name}/ <span className="tree__count">({node.files})</span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div className="tree__kids" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto", transition: tween.small }} exit={{ opacity: 0, height: 0, transition: tween.micro }}>
            <TreeNodes nodes={node.children} depth={depth + 1} />
          </motion.div>
        )}
      </AnimatePresence>
    </li>
  );
}
