import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { useState, type MouseEvent } from "react";
import { api, toFailure } from "../api";
import type { Skin } from "../api/types";
import type { EntityView } from "../lib/derive";
import { nsfwHide, nsfwReveal, spring, staggerDelay, tween } from "../motion";
import { useApp } from "../store/app";
import { useHome } from "../store/home";
import { SkinInfo } from "../screens/SkinDetail";
import { Ambient, coverUrl } from "./Ambient";
import { AutoHeight } from "./AutoHeight";
import { Gallery } from "./Gallery";
import { RadioDot } from "./controls";
import { SelectionTag } from "./SelectionTag";
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
  const revealNsfw = useHome((s) => s.revealNsfw);
  const nsfwVisible = useHome((s) => s.nsfwVisible);
  // 18+ cards that mount after a reveal or hide since the shelf opened animate as a reveal (SPEC §7)
  const nsfwEpoch = useHome((s) => s.nsfwEpoch);
  const [openedAt] = useState(nsfwEpoch);
  const revealing = nsfwEpoch !== openedAt;
  const removeSkin = useHome((s) => s.removeSkin);
  const peek = useHome((s) => s.peek);
  const setPeek = useHome((s) => s.setPeek);
  const snapshot = useApp((s) => s.snapshot)!;
  const toast = useApp((s) => s.toast);
  const peekSkin = peek ? skins.find((s) => s.id === peek) : undefined;
  /** C3 below ~1100px opens A3 instead (SPEC §6). */
  const openPeek = (skinId: string) => {
    if (window.innerWidth < 1100 && onDetails) onDetails(skinId);
    else setPeek(skinId);
  };
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

  const fadeOut = { opacity: 0, transition: tween.micro };
  const enter = (i: number) =>
    revealing
      ? // after a reveal or hide only the 18+ cards move; the stub and the rest fade
        { initial: { opacity: 0 }, animate: { opacity: 1, transition: tween.small }, exit: fadeOut }
      : reduced
        ? { initial: { opacity: 0 }, animate: { opacity: 1, transition: tween.small }, exit: fadeOut }
        : {
            initial: { opacity: 0, x: -18 },
            animate: { opacity: 1, x: 0, transition: { ...spring.smooth, delay: 0.06 + staggerDelay(i, items, reduced) } },
            exit: fadeOut,
          };
  // an 18+ card blurs in when revealed and out when hidden; when the shelf opens it enters like the others
  const nsfwOrder = skins.filter((k) => k.nsfw).map((k) => k.id);
  const skinEnter = (skin: Skin, i: number) =>
    !skin.nsfw ? enter(i) : revealing ? nsfwReveal(reduced, nsfwOrder.indexOf(skin.id)) : { ...enter(i), exit: nsfwHide(reduced) };
  const cell = { layout: "position" as const, transition: spring.smooth };
  const hotkey = snapshot.settings.nsfw.hotkey;

  return (
    <motion.div
      className={`shelf ${pending ? "is-pending" : ""}`}
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
      <Ambient url={peekSkin ? coverUrl(peekSkin) : coverUrl(view.effectiveSkin, view.effectiveHidden)} variant="shelf" />
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
        <AutoHeight reduced={reduced}>
        <AnimatePresence mode="popLayout" initial={false}>
        {peekSkin ? (
          <motion.div
            key="peek"
            className="peek"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: tween.small }}
            exit={{ opacity: 0, transition: tween.micro }}
          >
            <LayoutGroup id="peek">
            <div className="peek__list" role="radiogroup" aria-label={`${entity.name} skins`}>
              <div className="caps peek__list-title">{entity.name}'s skins</div>
              <button type="button" role="radio" aria-checked={effective === null} className={`peek__row ${effective === null ? "is-selected" : ""}`} data-skin="original" data-nav onClick={() => pick(entity.id, null)}>
                <span className="peek__thumb peek__thumb--orig">orig</span>
                <span className="peek__row-name">Original</span>
                <AnimatePresence initial={false}>{effective === null && <SelectionTag entityId={entity.id} pending={pending} reduced={reduced} />}</AnimatePresence>
              </button>
              <AnimatePresence initial={false}>
              {skins.map((s) => (
                <motion.button
                  key={s.id}
                  type="button"
                  role="radio"
                  aria-checked={effective === s.id}
                  className={`peek__row ${effective === s.id ? "is-selected" : ""} ${peek === s.id ? "is-peeked" : ""}`}
                  data-skin={s.id}
                  data-nav
                  {...(s.nsfw && revealing ? {} : { layout: "position" as const, transition: spring.smooth })}
                  {...(s.nsfw ? nsfwReveal(reduced, nsfwOrder.indexOf(s.id)) : { exit: fadeOut })}
                  onClick={() => {
                    pick(entity.id, s.id);
                    setPeek(s.id);
                  }}
                  onDoubleClick={() => onDetails?.(s.id)}
                >
                  <span className="peek__thumb">{s.previews[0] && <img src={api.assetUrl(s.previews[0].file)} alt="" loading="lazy" decoding="async" />}</span>
                  <span className="peek__row-name">{s.name}</span>
                  <AnimatePresence initial={false}>{effective === s.id && <SelectionTag entityId={entity.id} pending={pending} reduced={reduced} />}</AnimatePresence>
                </motion.button>
              ))}
              </AnimatePresence>
              <motion.button layout="position" transition={spring.smooth} className="peek__add" onClick={onAdd} disabled={!onAdd}>
                + Add skin
              </motion.button>
            </div>
            </LayoutGroup>
            <motion.div className="peek__gallery" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { ...tween.medium, delay: 0.08 } }}>
              <Gallery skin={peekSkin} reduced={reduced} compact />
            </motion.div>
            <div className="peek__info">
              <SkinInfo
                skin={peekSkin}
                snapshot={snapshot}
                selected={effective === peekSkin.id}
                pending={pending && effective === peekSkin.id}
                reduced={reduced}
                compact
                onLess={() => setPeek(null)}
              />
            </div>
          </motion.div>
        ) : (
        <motion.div
          key="strip"
          className="shelf__strip"
          layoutScroll
          // exiting cells pop out of the flow (AnimatePresence popLayout), positioned against the strip
          style={{ position: "relative" }}
          role="radiogroup"
          aria-label={`${entity.name} skins`}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: tween.small }}
          exit={{ opacity: 0, transition: tween.micro }}
        >
          <AnimatePresence mode="popLayout">
          <motion.div key="original" className="shelf__cell" {...cell} {...enter(0)}>
            <OriginalCard entityId={entity.id} selected={effective === null} pending={pending} name={entity.name} reduced={reduced} onPick={() => pick(entity.id, null)} />
          </motion.div>
          {skins.map((s, i) => (
            // a revealed card fades in where it belongs; only the cells around it glide
            <motion.div key={s.id} className="shelf__cell" {...(s.nsfw && revealing ? {} : cell)} {...skinEnter(s, i + 1)}>
              <SkinCard
                skin={s}
                entityId={entity.id}
                selected={effective === s.id}
                pending={pending && effective === s.id}
                onNow={onDisk.includes(s.id)}
                reduced={reduced}
                onPick={() => pick(entity.id, s.id)}
                onDetails={onDetails ? () => onDetails(s.id) : undefined}
                onPeek={() => openPeek(s.id)}
                onMenu={(e) => setMenu({ skin: s, anchor: (e.currentTarget as HTMLElement).getBoundingClientRect() })}
              />
            </motion.div>
          ))}
          {view.hidden > 0 && whenHidden === "stub" && (
            <motion.div key="stub" className="shelf__cell shelf__cell--stub" {...cell} {...enter(skins.length + 1)}>
              <button className="shelf__stub" data-nav onClick={revealNsfw} title={`Show ${view.hidden} hidden 18+ skin${view.hidden === 1 ? "" : "s"} (${hotkey})`}>
                <span className="shelf__stub-count num">+{view.hidden}</span>
                <span className="shelf__stub-key">{hotkey.toUpperCase()}</span>
              </button>
            </motion.div>
          )}
          {skins.length === 0 && view.hidden === 0 ? (
            <motion.div key="empty" className="shelf__cell shelf__cell--wide" {...cell} {...enter(1)}>
              <button className="shelf__empty" data-nav onClick={onAdd} disabled={!onAdd}>
                <span className="shelf__empty-title">No skins yet</span>
                <span className="shelf__empty-sub">Drop a .zip / .rar / .7z here or click to browse</span>
              </button>
            </motion.div>
          ) : (
            <motion.div key="drop" className="shelf__cell" {...cell} {...enter(skins.length + 2)}>
              <button className="shelf__drop" data-nav onClick={onAdd} disabled={!onAdd}>
                <span className="shelf__drop-plus">+</span>
                Drop archive
              </button>
            </motion.div>
          )}
          </AnimatePresence>
        </motion.div>
        )}
        </AnimatePresence>
        </AutoHeight>
      </div>
      <Popover open={!!menu && (nsfwVisible || !menu.skin.nsfw)} anchor={menu?.anchor ?? null} onClose={() => setMenu(null)} align="end" label="Skin actions">
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
        open={!!confirm && (nsfwVisible || !confirm.nsfw)}
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

function OriginalCard({
  entityId,
  name,
  selected,
  pending,
  reduced,
  onPick,
}: {
  entityId: string;
  name: string;
  selected: boolean;
  pending: boolean;
  reduced: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      className={`skincard skincard--original ${selected ? "is-selected" : ""} ${selected && pending ? "is-pending" : ""}`}
      data-skin="original"
      data-nav
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
        <AnimatePresence initial={false}>{selected && <SelectionTag entityId={entityId} pending={pending} reduced={reduced} />}</AnimatePresence>
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
  reduced,
  onPick,
  onDetails,
  onPeek,
  onMenu,
}: {
  skin: Skin;
  entityId: string;
  selected: boolean;
  pending: boolean;
  onNow: boolean;
  reduced: boolean;
  onPick: () => void;
  onDetails?: () => void;
  onPeek: () => void;
  onMenu: (e: MouseEvent) => void;
}) {
  return (
    <div className={`skincard ${selected ? "is-selected" : ""} ${pending ? "is-pending" : ""}`} data-skin={skin.id} data-drop={`skin:${skin.id}`}>
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        className="skincard__hit"
        data-nav
        aria-label={`${skin.name}${skin.author ? ` by ${skin.author}` : ""}`}
        onClick={onPick}
        onDoubleClick={onDetails}
      />
      <Cover skin={skin} className="skincard__cover" flip reduced={reduced} />
      <button type="button" className="skincard__info" aria-label={`Quick peek at ${skin.name} (I)`} title="Quick peek (I)" onClick={onPeek}>
        i
      </button>
      <button type="button" className="skincard__more" aria-label={`More actions for ${skin.name}`} onClick={onMenu}>
        ⋯
      </button>
      {skin.nsfw && <span className="tag tag--nsfw skincard__nsfw">18+</span>}
      <div className="skincard__meta">
        <RadioDot checked={selected} pending={pending} />
        <span className="skincard__name">{skin.name}</span>
        <AnimatePresence initial={false}>{selected && <SelectionTag entityId={entityId} pending={pending} reduced={reduced} />}</AnimatePresence>
      </div>
      <div className="skincard__author">
        {onNow && !selected ? "on now · turns off" : skin.author ? `by ${skin.author}` : " "}
      </div>
    </div>
  );
}
