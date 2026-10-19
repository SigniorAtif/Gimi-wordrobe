import { AnimatePresence, motion, useAnimate } from "motion/react";
import { useState } from "react";
import { checkDraft, choiceName, rootLabel } from "../lib/addDraft";
import { shake, tween } from "../motion";
import { useAdd } from "../store/add";
import { useApp } from "../store/app";
import {
  AddProgressBar,
  CategoryPick,
  FieldError,
  fileName,
  PortraitDrop,
  PreviewPicker,
  summaryCounts,
  useAddDraft,
} from "./AddFields";
import { useReduced } from "../lib/useReduced";
import { AutoHeight } from "./AutoHeight";
import { Popover } from "./Popover";
import { Switch } from "./Switch";
import "./AddPanel.css";

/**
 * C4 (SPEC §6): the small panel anchored to the card an archive was dropped on, or to a "+ New" tile.
 * The common case is one field and Add; "More options…" opens the full A4 dialog on the same archive.
 */
export function AddPanel() {
  const flow = useAdd((s) => (s.flow?.kind === "c4" ? s.flow : null));
  const busy = useAdd((s) => s.busy);
  const progress = useAdd((s) => s.progress);
  const close = useAdd((s) => s.close);
  const expand = useAdd((s) => s.expand);
  const submit = useAdd((s) => s.submit);
  const entities = useApp((s) => s.snapshot?.library.entities) ?? [];
  const [draft, setDraft] = useAddDraft(flow, entities, false);
  const [attempted, setAttempted] = useState(false);
  const [seenFlow, setSeenFlow] = useState(flow);
  const [btn, animateBtn] = useAnimate();
  const reduced = useReduced();
  if (flow !== seenFlow) {
    setSeenFlow(flow);
    if (flow?.archivePath !== seenFlow?.archivePath) setAttempted(false);
  }

  const summary = flow?.summary ?? null;
  const check = draft && summary ? checkDraft(draft, summary, entities) : null;
  const errors = attempted ? (check?.errors ?? {}) : {};
  const target = flow?.entityId ? entities.find((e) => e.id === flow.entityId) : undefined;
  const title = flow?.newCategory ? (flow.newCategory === "character" ? "New character" : "New weapon / extra") : `Add to ${target?.name ?? "…"}`;
  const others = summary?.roots.slice(1) ?? [];

  const onAdd = async () => {
    setAttempted(true);
    if (!check?.request || !draft) {
      if (btn.current) void animateBtn(btn.current, shake.x, shake.transition);
      return;
    }
    await submit(check.request, choiceName(draft.entity, entities));
  };

  return (
    <Popover
      open={!!flow}
      anchor={flow?.anchor ?? null}
      // stays on its card while the page scrolls ("+ New" tiles vanish after the drop, so those keep the drop spot)
      follow={() => (flow?.entityId ? document.querySelector(`[data-drop="entity:${flow.entityId}"]`) : null)}
      onClose={close}
      kind="dialog"
      label={title}
      className="addpanel"
    >
      {flow && (
        <form
          className="addpanel__form"
          onSubmit={(e) => {
            e.preventDefault();
            void onAdd();
          }}
        >
          <header className="addpanel__head">
            <h2 className="addpanel__title">{title}</h2>
            <span className="addpanel__meta" title={flow.archivePath}>
              {fileName(flow.archivePath)} · {summary ? summaryCounts(summary) : "reading…"}
            </span>
          </header>
          {/* placeholders swap out at once and the content fades in while the height springs, so it never dips */}
          <AutoHeight reduced={reduced}>
            {flow.error ? (
              <motion.p key="error" className="addpanel__error" role="alert" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: tween.small }}>
                {flow.error}
              </motion.p>
            ) : !draft || !summary ? (
              <div key="loading" className="addpanel__loading" aria-label="Reading the archive">
                <span className="add-skeleton" style={{ width: "60%" }} />
                <span className="add-skeleton" style={{ width: "90%" }} />
                <span className="add-skeleton" style={{ width: "75%" }} />
              </div>
            ) : (
              <motion.div key="body" className="addpanel__body" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: tween.small }}>
                <FieldError text={errors.archive} />
                {draft.entity.kind === "new" && (
                  <div className="addpanel__new">
                    <PortraitDrop
                      path={draft.entity.portraitPath}
                      name={draft.entity.name}
                      onChange={(p) => draft.entity.kind === "new" && setDraft({ ...draft, entity: { ...draft.entity, portraitPath: p } })}
                    />
                    <label className="addpanel__field addpanel__grow">
                      <span className="caps">{flow.newCategory === "character" ? "Character name" : "Name"}</span>
                      <input
                        className={`input ${errors.entity ? "is-invalid" : ""}`}
                        value={draft.entity.name}
                        placeholder={flow.newCategory === "character" ? "e.g. Lumine" : "e.g. Skyward Blade"}
                        // the panel opens before the archive is read; focus lands here once the fields appear
                        autoFocus
                        onChange={(e) => draft.entity.kind === "new" && setDraft({ ...draft, entity: { ...draft.entity, name: e.target.value } })}
                      />
                      <FieldError text={errors.entity} />
                    </label>
                    {flow.newCategory !== "character" && (
                      <CategoryPick
                        value={draft.entity.category === "character" ? "weapon" : draft.entity.category}
                        options={["weapon", "extra"]}
                        onChange={(c) => draft.entity.kind === "new" && setDraft({ ...draft, entity: { ...draft.entity, category: c } })}
                      />
                    )}
                  </div>
                )}
                <div className="addpanel__row">
                  <label className="addpanel__field">
                    <span className="caps">Skin name</span>
                    <input
                      className={`input ${errors.skinName ? "is-invalid" : ""}`}
                      value={draft.skinName}
                      autoFocus={draft.entity.kind !== "new"}
                      onChange={(e) => setDraft({ ...draft, skinName: e.target.value })}
                    />
                    <FieldError text={errors.skinName} />
                  </label>
                  <label className="addpanel__field">
                    <span className="caps">GameBanana link</span>
                    <input
                      className={`input ${errors.gbUrl ? "is-invalid" : ""}`}
                      value={draft.gbUrl}
                      placeholder="optional"
                      spellCheck={false}
                      onChange={(e) => setDraft({ ...draft, gbUrl: e.target.value })}
                    />
                    <FieldError text={errors.gbUrl} />
                  </label>
                </div>
                <div className="addpanel__line">
                  <Switch label="NSFW" checked={draft.nsfw} onChange={(v) => setDraft({ ...draft, nsfw: v })} />
                  <span>NSFW</span>
                  <span className="addpanel__spacer" />
                  <span className="caps">Preview</span>
                </div>
                <PreviewPicker draft={draft} setDraft={setDraft} imageCount={summary.images.length} compact />
                <FieldError text={errors.preview ?? errors.roots} />
                {others.length > 0 && (
                  <p className="addpanel__also">
                    Also inside:{" "}
                    {others
                      .map((r, i) => {
                        const d = draft.roots[i + 1];
                        const who = d ? choiceName(d.entity, entities) : "";
                        return `${who || rootLabel(r, summary)}${d?.own ? " (its own skin)" : ""}`;
                      })
                      .join(", ")}
                    .{" "}
                    <button type="button" className="link" onClick={() => expand(draft)} disabled={busy}>
                      More options…
                    </button>
                  </p>
                )}
              </motion.div>
            )}
          </AutoHeight>
          <footer className="addpanel__foot">
            <AnimatePresence mode="popLayout" initial={false}>
              {busy && progress ? (
                <motion.div key="progress" className="addpanel__progress" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: tween.small }} exit={{ opacity: 0 }}>
                  <AddProgressBar progress={progress} />
                </motion.div>
              ) : (
                <motion.span key="spacer" className="addpanel__spacer" />
              )}
            </AnimatePresence>
            <button type="button" className="btn" onClick={close} disabled={busy}>
              Cancel
            </button>
            <button ref={btn} type="submit" className="btn btn--primary" disabled={busy || !!flow.error || !summary}>
              {busy ? <span className="spinner" aria-hidden /> : null}
              {busy ? "Adding" : "Add"}
            </button>
          </footer>
        </form>
      )}
    </Popover>
  );
}
