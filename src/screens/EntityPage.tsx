import { AnimatePresence, motion } from "motion/react";
import { useCallback, useState, type MouseEvent } from "react";
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
import { nsfwHide, nsfwReveal, riseIn, spring, staggerContainer, tween } from "../motion";
import { useApp } from "../store/app";
import { useAdd } from "../store/add";
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
  const toggleNsfw = useHome((s) => s.toggleNsfw);
  const revealNsfw = useHome((s) => s.revealNsfw);
  // 18+ cards that mount after a reveal or hide since the page opened animate as a reveal (SPEC §7)
  const nsfwEpoch = useHome((s) => s.nsfwEpoch);
  const [openedAt] = useState(nsfwEpoch);
  const revealing = nsfwEpoch !== openedAt;
  const pick = useHome((s) => s.pick);
  const removeSkin = useHome((s) => s.removeSkin);
  const browse = useAdd((s) => s.browse);
  const clashes = useClashes();
  const reduced = useReduced();
  const cols = useColumns(5, 4);
  const [menu, setMenu] = useState<{ skin: Skin | null; anchor: Anchor } | null>(null);
  const [confirm, setConfirm] = useState<Skin | null>(null);
  const entity = snapshot.library.entities.find((e) => e.id === entityId);

  // Esc / Backspace go back through useShortcuts

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
  // "invisible" means hidden skins leave no trace at all, not even in the counts (SPEC §11)
  const shownTotal = whenHidden === "stub" ? total : view.skins.length;
  const meta = [
    `${view.skins.length} of ${shownTotal} skin${shownTotal === 1 ? "" : "s"} shown`,
    view.hidden > 0 && whenHidden === "stub" && `${view.hidden} hidden (18+)`,
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
  // grid items glide when 18+ cards come and go; those blur in after a reveal and out on hide
  const item = { layout: "position" as const, transition: spring.smooth };
  const fade = { initial: { opacity: 0 }, animate: { opacity: 1, transition: tween.small } };
  const fadeOut = { opacity: 0, transition: tween.micro };
  const nsfwOrder = view.skins.filter((k) => k.nsfw).map((k) => k.id);
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
        <button type="button" className={`nsfw-chip ${nsfwVisible ? "is-visible" : ""}`} onClick={toggleNsfw} aria-pressed={nsfwVisible}>
          18+ {nsfwVisible ? "VISIBLE" : "HIDDEN"} · {snapshot.settings.nsfw.hotkey.toUpperCase()}
          {nsfwVisible ? " TO HIDE" : ""}
        </button>
        <button className="btn" onClick={() => void browse(entity.id)}>
          + Add skin to {entity.name}
        </button>
        <button className="btn btn--icon" aria-label="More" onClick={(e) => setMenu({ skin: null, anchor: e.currentTarget.getBoundingClientRect() })}>
          ⋯
        </button>
      </header>
      <motion.div className="epage__grid" style={{ ["--cols" as string]: cols, position: "relative" }} variants={staggerContainer(count, reduced, 0.1)} initial="hidden" animate="show">
        {/* exiting cards pop out of the grid, so the rest settle in one glide (positioned against the grid) */}
        <AnimatePresence mode="popLayout">
        <motion.div key="original" variants={riseIn(reduced)} {...item}>
          <button
            type="button"
            role="radio"
            aria-checked={view.effective === null}
            className={`bigcard bigcard--original ${view.effective === null ? "is-selected" : ""} ${view.effective === null && view.pending ? "is-pending" : ""}`}
            data-skin="original"
            data-nav
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
            <motion.div
              key={s.id}
              variants={riseIn(reduced)}
              // a revealed card fades in where it belongs; only the cards around it glide
              {...(s.nsfw && revealing ? {} : item)}
              {...(!s.nsfw ? { exit: fadeOut } : revealing ? nsfwReveal(reduced, nsfwOrder.indexOf(s.id)) : { exit: nsfwHide(reduced) })}
            >
              <div className={`bigcard ${selected ? "is-selected" : ""} ${selected && view.pending ? "is-pending" : ""}`} data-skin={s.id} data-drop={`skin:${s.id}`}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-label={s.name}
                  className="bigcard__hit"
                  data-nav
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
          <motion.div key="hidden" variants={riseIn(reduced)} {...item} {...(revealing ? fade : {})} exit={fadeOut}>
            <button className="bigcard bigcard--hidden" data-nav onClick={revealNsfw}>
              <span className="bigcard__hidden-title">
                {view.hidden} skin{view.hidden === 1 ? "" : "s"} hidden
              </span>
              <span className="tag tag--nsfw">18+</span>
              <span className="bigcard__hidden-sub">Press {snapshot.settings.nsfw.hotkey} to reveal</span>
            </button>
          </motion.div>
        )}
        <motion.div key="drop" variants={riseIn(reduced)} {...item}>
          <button type="button" className="bigcard bigcard--drop" data-drop={`entity:${entity.id}`} data-nav onClick={() => void browse(entity.id)}>
            <span className="bigcard__plus">+</span>
            <span>{total ? "Drop archive here" : "No skins yet"}</span>
            <small>{total ? "or click to browse" : "drop a .zip / .rar / .7z here or click to browse"}</small>
          </button>
        </motion.div>
        </AnimatePresence>
      </motion.div>
      <Popover open={!!menu && (nsfwVisible || !menu.skin?.nsfw)} anchor={menu?.anchor ?? null} onClose={() => setMenu(null)} align="end" label="Actions">
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
        open={!!confirm && (nsfwVisible || !confirm.nsfw)}
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
