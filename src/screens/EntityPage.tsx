import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useState, type MouseEvent } from "react";
import { api, toFailure } from "../api";
import type { Skin } from "../api/types";
import { RadioDot } from "../components/controls";
import { Cover } from "../components/Cover";
import { ConfirmDialog } from "../components/Modal";
import { MenuItem, MenuSeparator, Popover, type Anchor } from "../components/Popover";
import { Flip, rememberFlipKey } from "../components/Flip";
import { Portrait } from "../components/Portrait";
import { SelectionTag } from "../components/SelectionTag";
import { useClashes } from "../lib/conflicts";
import { entityView } from "../lib/derive";
import { useColumns } from "../lib/useColumns";
import { useReduced } from "../lib/useReduced";
import { riseIn, staggerContainer } from "../motion";
import { useApp } from "../store/app";
import { useHome } from "../store/home";
import "./EntityPage.css";

/** A2 character page (SPEC §6 Mode A): header + a grid of large skin cards that act as radio buttons. */
export function EntityPage({ entityId }: { entityId: string }) {
  // re-render on navigation so the outgoing page's shared elements snapshot their layout before the morph
  useApp((s) => s.route);
  const snapshot = useApp((s) => s.snapshot)!;
  const appBack = useApp((s) => s.back);
  // going back morphs the header portrait into the card it came from
  const back = useCallback(() => {
    rememberFlipKey(`entity:${entityId}`);
    appBack();
  }, [appBack, entityId]);
  const navigate = useApp((s) => s.navigate);
  const toast = useApp((s) => s.toast);
  const picks = useHome((s) => s.picks);
  const nsfwVisible = useHome((s) => s.nsfwVisible);
  const setNsfwVisible = useHome((s) => s.setNsfwVisible);
  const pick = useHome((s) => s.pick);
  const removeSkin = useHome((s) => s.removeSkin);
  const clashes = useClashes();
  const reduced = useReduced();
  const cols = useColumns(5, 4);
  const [menu, setMenu] = useState<{ skin: Skin | null; anchor: Anchor } | null>(null);
  const [confirm, setConfirm] = useState<Skin | null>(null);
  const entity = snapshot.library.entities.find((e) => e.id === entityId);

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

  if (!entity) {
    return (
      <div className="detail detail--missing">
        <p>This character no longer exists.</p>
        <button className="btn" onClick={back}>
          ← All characters
        </button>
      </div>
    );
  }
  const view = entityView(snapshot, picks, nsfwVisible, entity);
  const whenHidden = snapshot.settings.nsfw.whenHidden;
  const total = view.skins.length + view.hidden;
  const parents = [...new Set(view.skins.flatMap((s) => s.folders.map((f) => f.split("/").slice(0, -1).join("/"))))].filter(Boolean);
  const where = parents.length === 1 ? `Mods/${parents[0]}/` : view.skins.length ? "Mods/" : "";
  const meta = [
    `${view.skins.length} of ${total} skin${total === 1 ? "" : "s"} shown`,
    view.hidden > 0 && `${view.hidden} hidden (18+)`,
    where,
  ].filter(Boolean);
  const count = view.skins.length + 2 + (view.hidden && whenHidden === "stub" ? 1 : 0);
  const openFolder = async (target: Parameters<typeof api.openFolder>[0]) => {
    try {
      await api.openFolder(target);
    } catch (e) {
      toast({ kind: "error", text: toFailure(e).message });
    }
  };
  const details = (s: Skin) => {
    rememberFlipKey(`skin:${s.id}`);
    navigate({ name: "skin", skinId: s.id });
  };

  return (
    <div className="epage">
      <header className="epage__header">
        <button className="btn" onClick={back}>
          ← All characters
        </button>
        <Flip flipKey={`entity:${entity.id}`} className="epage__portrait" reduced={reduced} radius={entity.category === "character" ? 28 : 14}>
          <Portrait entity={entity} cover={view.effectiveSkin} hidden={view.effectiveHidden} size={56} />
        </Flip>
        <div className="epage__titles">
          <h1 className="epage__name">{entity.name}</h1>
          <p className="epage__meta">{meta.join(" · ")}</p>
        </div>
        <span className="epage__spacer" />
        <button type="button" className={`nsfw-chip ${nsfwVisible ? "is-visible" : ""}`} onClick={() => setNsfwVisible(!nsfwVisible)}>
          18+ {nsfwVisible ? "VISIBLE" : "HIDDEN"} · {snapshot.settings.nsfw.hotkey.toUpperCase()}
        </button>
        <button className="btn" disabled>
          + Add skin to {entity.name}
        </button>
        <button className="btn btn--icon" aria-label="More" onClick={(e) => setMenu({ skin: null, anchor: e.currentTarget.getBoundingClientRect() })}>
          ⋯
        </button>
      </header>
      <motion.div className="epage__grid" style={{ ["--cols" as string]: cols }} variants={staggerContainer(count, reduced, 0.1)} initial="hidden" animate="show">
        <motion.div variants={riseIn(reduced)}>
          <button
            type="button"
            role="radio"
            aria-checked={view.effective === null}
            className={`bigcard bigcard--original ${view.effective === null ? "is-selected" : ""} ${view.effective === null && view.pending ? "is-pending" : ""}`}
            data-skin="original"
            onClick={() => pick(entity.id, null)}
          >
            <div className="bigcard__orig">
              <span>Original</span>
              <small>no mod · default model</small>
            </div>
            <div className="bigcard__meta">
              <RadioDot checked={view.effective === null} pending={view.effective === null && view.pending} />
              <span className="bigcard__name">Original / no mod</span>
              <AnimatePresence initial={false}>{view.effective === null && <SelectionTag entityId={entity.id} pending={view.pending} reduced={reduced} />}</AnimatePresence>
            </div>
            <div className="bigcard__sub">Disables every {entity.name} skin</div>
          </button>
        </motion.div>
        {view.skins.map((s) => {
          const selected = view.effective === s.id;
          const conflict = (clashes.bySkin.get(s.id) ?? []).some((c) => c.severity === "conflict");
          return (
            <motion.div key={s.id} variants={riseIn(reduced)}>
              <div className={`bigcard ${selected ? "is-selected" : ""} ${selected && view.pending ? "is-pending" : ""}`} data-skin={s.id}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-label={s.name}
                  className="bigcard__hit"
                  onClick={() => pick(entity.id, s.id)}
                  onDoubleClick={() => details(s)}
                />
                <Cover skin={s} flip reduced={reduced} />
                <button type="button" className="bigcard__more" aria-label={`More actions for ${s.name}`} onClick={(e: MouseEvent) => setMenu({ skin: s, anchor: (e.currentTarget as HTMLElement).getBoundingClientRect() })}>
                  ⋯
                </button>
                {s.nsfw && <span className="tag tag--nsfw bigcard__nsfw">18+</span>}
                {conflict && selected && <span className="ecard__alert bigcard__alert" title="Hotkey conflict">!</span>}
                <div className="bigcard__meta">
                  <RadioDot checked={selected} pending={selected && view.pending} />
                  <span className="bigcard__name">{s.name}</span>
                  <AnimatePresence initial={false}>{selected && <SelectionTag entityId={entity.id} pending={view.pending} reduced={reduced} />}</AnimatePresence>
                </div>
                <div className="bigcard__sub">
                  {[s.author && `by ${s.author}`, `${s.previews.length} image${s.previews.length === 1 ? "" : "s"}`, `${s.hotkeys.length} hotkey${s.hotkeys.length === 1 ? "" : "s"}`]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
              </div>
            </motion.div>
          );
        })}
        {view.hidden > 0 && whenHidden === "stub" && (
          <motion.div variants={riseIn(reduced)}>
            <button className="bigcard bigcard--hidden" onClick={() => setNsfwVisible(true)}>
              <span className="bigcard__hidden-title">
                {view.hidden} skin{view.hidden === 1 ? "" : "s"} hidden
              </span>
              <span className="tag tag--nsfw">18+</span>
              <span className="bigcard__hidden-sub">Press {snapshot.settings.nsfw.hotkey} to reveal</span>
            </button>
          </motion.div>
        )}
        <motion.div variants={riseIn(reduced)}>
          <div className="bigcard bigcard--drop">
            <span className="bigcard__plus">+</span>
            <span>{view.skins.length ? "Drop archive here" : "No skins yet"}</span>
            <small>{view.skins.length ? "or click + Add skin" : "drop a .zip / .rar / .7z here"}</small>
          </div>
        </motion.div>
      </motion.div>
      <Popover open={!!menu} anchor={menu?.anchor ?? null} onClose={() => setMenu(null)} align="end" label="Actions">
        {menu?.skin ? (
          <>
            <MenuItem onSelect={() => { const s = menu.skin!; setMenu(null); details(s); }}>Edit details</MenuItem>
            <MenuItem onSelect={() => { const s = menu.skin!; setMenu(null); void openFolder({ kind: "skin", skinId: s.id }); }}>Open folder</MenuItem>
            <MenuItem disabled={!menu.skin.gameBananaUrl} onSelect={() => { const u = menu.skin!.gameBananaUrl; setMenu(null); if (u) void api.openUrl(u); }}>
              Open GameBanana
            </MenuItem>
            <MenuSeparator />
            <MenuItem danger onSelect={() => { setConfirm(menu.skin); setMenu(null); }}>
              Remove…
            </MenuItem>
          </>
        ) : (
          <MenuItem onSelect={() => { setMenu(null); void openFolder({ kind: "entity", entityId: entity.id }); }}>Open folder</MenuItem>
        )}
      </Popover>
      <ConfirmDialog
        open={!!confirm}
        title={`Remove ${confirm?.name ?? ""}?`}
        body="Its folder goes to the Recycle Bin, and it leaves the library. You can restore it from the Recycle Bin."
        confirmLabel="Move to Recycle Bin"
        danger
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const s = confirm;
          setConfirm(null);
          if (s) void removeSkin(s.id);
        }}
      />
    </div>
  );
}
