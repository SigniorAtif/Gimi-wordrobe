import { AnimatePresence, motion } from "motion/react";
import type { MouseEvent } from "react";
import type { EntityView } from "../lib/derive";
import { NSFW_HIDE_S, riseIn, spring, tween } from "../motion";
import { Flip } from "./Flip";
import { Portrait } from "./Portrait";
import "./EntityCard.css";

/**
 * C1 compact card: portrait, name, active skin (crossfades on change), one dot per visible skin, PENDING / conflict
 * badges. Opening its shelf gives it an attached tab (SPEC §6 C1/C2, §7).
 */
export function EntityCard({
  view,
  open,
  conflict,
  reduced,
  dropHover,
  onToggle,
  onContextMenu,
}: {
  view: EntityView;
  open: boolean;
  conflict?: boolean;
  reduced: boolean;
  /** an archive is dragged over this card (C4) */
  dropHover?: boolean;
  onToggle: () => void;
  onContextMenu: (e: MouseEvent) => void;
}) {
  const { entity, skins, effective, pending, onDisk, subtitle } = view;
  const multiOn = onDisk.length > 1 && !pending;
  return (
    <motion.button
      layout="position"
      type="button"
      className={`ecard ecard--${entity.category} ${open ? "is-open" : ""} ${pending ? "is-pending" : ""} ${skins.length === 0 ? "is-empty" : ""} ${dropHover ? "is-drop-hover" : ""}`}
      data-entity={entity.id}
      data-nav
      data-drop={`entity:${entity.id}`}
      aria-expanded={open}
      aria-label={`${entity.name}, ${subtitle}${pending ? ", pending" : ""}`}
      variants={riseIn(reduced)}
      exit={reduced ? { opacity: 0, transition: tween.small } : { opacity: 0, scale: 0.94, transition: tween.small }}
      whileHover={reduced ? undefined : { y: -2, transition: tween.micro }}
      whileTap={reduced ? undefined : { scale: 0.98, transition: tween.micro }}
      transition={spring.smooth}
      onClick={onToggle}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e);
      }}
    >
      <Flip flipKey={`entity:${entity.id}`} className="ecard__portrait" reduced={reduced} radius={entity.category === "character" ? 24 : 12}>
        <Portrait entity={entity} cover={view.effectiveSkin} hidden={view.effectiveHidden} size={46} />
      </Flip>
      <span className="ecard__text">
        <span className="ecard__name">
          {entity.name}
          {open && <span className="ecard__caret" aria-hidden> ▴</span>}
        </span>
        <span className="ecard__sub">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={subtitle}
              className="ecard__sub-text"
              initial={reduced ? { opacity: 0 } : { opacity: 0, y: 5 }}
              animate={{ opacity: 1, y: 0, transition: tween.small }}
              exit={reduced ? { opacity: 0 } : { opacity: 0, y: -5, transition: tween.micro }}
            >
              {subtitle}
            </motion.span>
          </AnimatePresence>
        </span>
        {skins.length > 0 && (
          <span className="ecard__dots" aria-hidden>
            <AnimatePresence initial={false}>
            {skins.map((s) => {
              const on = s.id === effective;
              return (
                <motion.span
                  key={s.id}
                  className={`ecard__dot ${on ? "is-on" : ""} ${on && pending ? "is-pending" : ""}`}
                  // 18+ skins' dots come and go with the reveal (SPEC §11 counts only what is shown)
                  layout="position"
                  initial={{ opacity: 0, scale: 0.4 }}
                  animate={{ opacity: 1, scale: 1, transition: tween.small }}
                  exit={{ opacity: 0, scale: 0.4, transition: { duration: NSFW_HIDE_S } }}
                  transition={spring.smooth}
                >
                  <AnimatePresence initial={false}>
                    {on && (
                      <motion.span
                        className="ecard__dot-fill"
                        initial={reduced ? { opacity: 0 } : { scaleX: 0, opacity: 0 }}
                        animate={{ scaleX: 1, opacity: 1, transition: { ...spring.snappy, opacity: tween.micro } }}
                        exit={reduced ? { opacity: 0, transition: tween.micro } : { scaleX: 0, opacity: 0, transition: tween.micro }}
                      />
                    )}
                  </AnimatePresence>
                </motion.span>
              );
            })}
            </AnimatePresence>
          </span>
        )}
      </span>
      <span className="ecard__badges">
        <AnimatePresence initial={false}>
          {pending && (
            <motion.span
              key="pending"
              className="tag tag--pending"
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1, transition: spring.snappy }}
              exit={{ opacity: 0, scale: 0.9, filter: "blur(2px)", transition: tween.small }}
            >
              Pending
            </motion.span>
          )}
          {(conflict || multiOn) && (
            <motion.span
              key="conflict"
              className="ecard__alert"
              title={multiOn ? `${onDisk.length} skins are on at once. Pick one and Apply.` : "Hotkey conflict"}
              initial={{ opacity: 0, scale: 0.6 }}
              animate={{ opacity: 1, scale: 1, transition: spring.snappy }}
              exit={{ opacity: 0, scale: 0.6, transition: tween.micro }}
            >
              !
            </motion.span>
          )}
        </AnimatePresence>
      </span>
      <AnimatePresence>
        {open && (
          <motion.span
            className="ecard__tab"
            aria-hidden
            initial={reduced ? { opacity: 0 } : { scaleY: 0, opacity: 0 }}
            animate={{ scaleY: 1, opacity: 1, transition: spring.smooth }}
            exit={{ scaleY: 0, opacity: 0, transition: tween.micro }}
          />
        )}
      </AnimatePresence>
    </motion.button>
  );
}
