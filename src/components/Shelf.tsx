import { motion } from "motion/react";
import { useState, type MouseEvent } from "react";
import { api, toFailure } from "../api";
import type { Skin } from "../api/types";
import type { EntityView } from "../lib/derive";
import { spring, staggerDelay, tween } from "../motion";
import { useApp } from "../store/app";
import { useHome } from "../store/home";
import { RadioDot } from "./controls";
import { Cover } from "./Cover";
import { ConfirmDialog } from "./Modal";
import { MenuItem, MenuSeparator, Popover, type Anchor } from "./Popover";
import "./Shelf.css";

/**
 * C2 shelf: opens under the clicked card's row at full width; the height springs open, the skin strip staggers in
 * from the left. Clicking a skin makes it the pending active skin; Original turns every skin of the entity off.
 */
export function Shelf({
  view,
  reduced,
  whenHidden,
  onOpenPage,
  onDetails,
  onAdd,
}: {
  view: EntityView;
  reduced: boolean;
  whenHidden: "stub" | "invisible";
  onOpenPage?: () => void;
  onDetails?: (skinId: string) => void;
  onAdd?: () => void;
}) {
  const { entity, skins, effective, onDisk, pending } = view;
  const pick = useHome((s) => s.pick);
  const close = useHome((s) => s.closeShelf);
  const setNsfwVisible = useHome((s) => s.setNsfwVisible);
  const removeSkin = useHome((s) => s.removeSkin);
  const toast = useApp((s) => s.toast);
  const [menu, setMenu] = useState<{ skin: Skin; anchor: Anchor } | null>(null);
  const [confirm, setConfirm] = useState<Skin | null>(null);
  const multiOn = onDisk.length > 1 && !pending;
  const items = 1 + skins.length + 1;

  const openFolder = async (target: Parameters<typeof api.openFolder>[0]) => {
    try {
      await api.openFolder(target);
    } catch (e) {
      toast({ kind: "error", text: toFailure(e).message });
    }
  };

  const enter = (i: number) =>
    reduced
      ? { initial: { opacity: 0 }, animate: { opacity: 1, transition: tween.small } }
      : {
          initial: { opacity: 0, x: -18 },
          animate: { opacity: 1, x: 0, transition: { ...spring.smooth, delay: 0.06 + staggerDelay(i, items, reduced) } },
        };

  return (
    <motion.div
      className="shelf"
      data-shelf={entity.id}
      onAnimationComplete={(def) => {
        // once it has opened, bring the whole shelf into view if it ended up below the fold
        if (typeof def === "object" && def && "opacity" in def && def.opacity === 0) return; // closing
        const el = document.querySelector<HTMLElement>(`[data-shelf="${entity.id}"]`);
        el?.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
      }}
      initial={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }}
      animate={reduced ? { opacity: 1, transition: tween.small } : { height: "auto", opacity: 1, transition: { ...spring.smooth, opacity: tween.small } }}
      exit={
        reduced
          ? { opacity: 0, transition: tween.micro }
          : // the panel stays visible while it collapses, fading only at the end, so closing never leaves a blank gap
            { height: 0, opacity: 0, transition: { ...spring.smooth, opacity: { duration: 0.28, ease: [0.55, 0, 0.75, 0.25] } } }
      }
    >
      <div className="shelf__inner">
        <header className="shelf__head">
          <h3 className="shelf__title">{entity.name}</h3>
          <span className="shelf__hint">click a skin to make it active · double-click for details</span>
          <span className="shelf__spacer" />
          <button className="btn btn--sm" onClick={() => void openFolder({ kind: "entity", entityId: entity.id })}>
            Open folder
          </button>
          {onOpenPage && (
            <button className="btn btn--sm" onClick={onOpenPage}>
              Open full page
            </button>
          )}
          <button className="btn btn--sm btn--icon" aria-label="Close shelf" onClick={close}>
            ×
          </button>
        </header>
        {multiOn && (
          <p className="shelf__warn" role="status">
            {onDisk.length} skins are on at once. Pick the one to keep, then Apply.
          </p>
        )}
        <div className="shelf__strip" role="radiogroup" aria-label={`${entity.name} skins`}>
          <motion.div className="shelf__cell" {...enter(0)}>
            <OriginalCard entityId={entity.id} selected={effective === null} pending={pending} name={entity.name} onPick={() => pick(entity.id, null)} />
          </motion.div>
          {skins.map((s, i) => (
            <motion.div key={s.id} className="shelf__cell" {...enter(i + 1)}>
              <SkinCard
                skin={s}
                entityId={entity.id}
                selected={effective === s.id}
                pending={pending && effective === s.id}
                onNow={onDisk.includes(s.id)}
                onPick={() => pick(entity.id, s.id)}
                onDetails={onDetails ? () => onDetails(s.id) : undefined}
                onMenu={(e) => setMenu({ skin: s, anchor: (e.currentTarget as HTMLElement).getBoundingClientRect() })}
              />
            </motion.div>
          ))}
          {view.hidden > 0 && whenHidden === "stub" && (
            <motion.div className="shelf__cell shelf__cell--stub" {...enter(skins.length + 1)}>
              <button className="shelf__stub" onClick={() => setNsfwVisible(true)} title="Reveal NSFW skins">
                <span className="shelf__stub-count num">+{view.hidden}</span>
                <span className="shelf__stub-key">CTRL+H</span>
              </button>
            </motion.div>
          )}
          {skins.length === 0 && view.hidden === 0 ? (
            <motion.div className="shelf__cell shelf__cell--wide" {...enter(1)}>
              <button className="shelf__empty" onClick={onAdd} disabled={!onAdd}>
                <span className="shelf__empty-title">No skins yet</span>
                <span className="shelf__empty-sub">Drop a .zip / .rar / .7z here or click to browse</span>
              </button>
            </motion.div>
          ) : (
            <motion.div className="shelf__cell" {...enter(skins.length + 2)}>
              <button className="shelf__drop" onClick={onAdd} disabled={!onAdd}>
                <span className="shelf__drop-plus">+</span>
                Drop archive
              </button>
            </motion.div>
          )}
        </div>
      </div>
      <Popover open={!!menu} anchor={menu?.anchor ?? null} onClose={() => setMenu(null)} align="end" label="Skin actions">
        {menu && (
          <>
            <MenuItem disabled={!onDetails} onSelect={() => { setMenu(null); onDetails?.(menu.skin.id); }}>
              Edit details
            </MenuItem>
            <MenuItem onSelect={() => { setMenu(null); void openFolder({ kind: "skin", skinId: menu.skin.id }); }}>Open folder</MenuItem>
            <MenuItem
              disabled={!menu.skin.gameBananaUrl}
              onSelect={() => {
                setMenu(null);
                if (menu.skin.gameBananaUrl) void api.openUrl(menu.skin.gameBananaUrl);
              }}
            >
              Open GameBanana
            </MenuItem>
            <MenuSeparator />
            <MenuItem danger onSelect={() => { setConfirm(menu.skin); setMenu(null); }}>
              Remove…
            </MenuItem>
          </>
        )}
      </Popover>
      <ConfirmDialog
        open={!!confirm}
        title={`Remove ${confirm?.name ?? ""}?`}
        body={<>Its folder{(confirm?.folders.length ?? 0) > 1 ? "s go" : " goes"} to the Recycle Bin, and it leaves the library. You can restore it from the Recycle Bin.</>}
        confirmLabel="Move to Recycle Bin"
        danger
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const s = confirm;
          setConfirm(null);
          if (s) void removeSkin(s.id);
        }}
      />
    </motion.div>
  );
}

/** The ACTIVE / PENDING tag. One per entity, shared layoutId, so it slides between cards (SPEC §7). */
export function SelectionTag({ entityId, pending }: { entityId: string; pending: boolean }) {
  return (
    <motion.span layoutId={`tag-${entityId}`} className={`tag ${pending ? "tag--pending" : "tag--active"}`} transition={spring.snappy}>
      {pending ? "Pending" : "Active"}
    </motion.span>
  );
}

function OriginalCard({
  entityId,
  name,
  selected,
  pending,
  onPick,
}: {
  entityId: string;
  name: string;
  selected: boolean;
  pending: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      className={`skincard skincard--original ${selected ? "is-selected" : ""} ${selected && pending ? "is-pending" : ""}`}
      data-skin="original"
      onClick={onPick}
      title={`Disables every ${name} skin`}
    >
      <div className="skincard__orig">
        <span className="skincard__orig-title">Original</span>
        <span className="skincard__orig-sub">no mod</span>
      </div>
      <div className="skincard__meta">
        <RadioDot checked={selected} pending={selected && pending} />
        <span className="skincard__name">Original</span>
        {selected && <SelectionTag entityId={entityId} pending={pending} />}
      </div>
      <div className="skincard__author">default model</div>
    </button>
  );
}

function SkinCard({
  skin,
  entityId,
  selected,
  pending,
  onNow,
  onPick,
  onDetails,
  onMenu,
}: {
  skin: Skin;
  entityId: string;
  selected: boolean;
  pending: boolean;
  onNow: boolean;
  onPick: () => void;
  onDetails?: () => void;
  onMenu: (e: MouseEvent) => void;
}) {
  return (
    <div className={`skincard ${selected ? "is-selected" : ""} ${pending ? "is-pending" : ""}`} data-skin={skin.id}>
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        className="skincard__hit"
        aria-label={`${skin.name}${skin.author ? ` by ${skin.author}` : ""}`}
        onClick={onPick}
        onDoubleClick={onDetails}
      />
      <Cover skin={skin} className="skincard__cover" />
      <button type="button" className="skincard__more" aria-label={`More actions for ${skin.name}`} onClick={onMenu}>
        ⋯
      </button>
      {skin.nsfw && <span className="tag tag--nsfw skincard__nsfw">18+</span>}
      <div className="skincard__meta">
        <RadioDot checked={selected} pending={pending} />
        <span className="skincard__name">{skin.name}</span>
        {selected && <SelectionTag entityId={entityId} pending={pending} />}
      </div>
      <div className="skincard__author">
        {onNow && !selected ? "on now · turns off" : skin.author ? `by ${skin.author}` : " "}
      </div>
    </div>
  );
}
