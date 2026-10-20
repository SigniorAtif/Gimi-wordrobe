import { AnimatePresence, motion } from "motion/react";
import type { MouseEvent } from "react";
import { api } from "../api";
import { hueFor, type EntityView } from "../lib/derive";
import { NSFW_HIDE_S, riseIn, spring, tween } from "../motion";
import { usePreviews } from "../store/previews";
import { AnimatedNumber } from "./AnimatedNumber";
import { CoverShimmer } from "./Cover";
import { Flip } from "./Flip";
import { Portrait } from "./Portrait";
import "./PageCard.css";

/** A1 large card: the active skin's cover as a backdrop, name, active skin, dots and badges (SPEC §6 Mode A). */
export function PageCard({
  view,
  conflict,
  reduced,
  onOpen,
  onContextMenu,
}: {
  view: EntityView;
  conflict?: boolean;
  reduced: boolean;
  onOpen: () => void;
  onContextMenu: (e: MouseEvent) => void;
}) {
  const { entity, skins, effective, pending, onDisk, subtitle, effectiveSkin, effectiveHidden } = view;
  const cover = !effectiveHidden && effectiveSkin?.previews[0] ? api.assetUrl(effectiveSkin.previews[0].file) : "";
  const multiOn = onDisk.length > 1 && !pending;
  // the active skin's GameBanana previews are downloading: the backdrop shimmers (SPEC §10 state 1)
  const fetching = usePreviews((s) => !!effectiveSkin && !effectiveHidden && effectiveSkin.id in s.fetching);
  return (
    <motion.button
      layout="position"
      type="button"
      className={`pcard ${pending ? "is-pending" : ""}`}
      data-entity={entity.id}
      data-nav
      data-drop={`entity:${entity.id}`}
      aria-label={`${entity.name}, ${subtitle}${pending ? ", pending" : ""}`}
      variants={riseIn(reduced)}
      exit={reduced ? { opacity: 0, transition: tween.small } : { opacity: 0, scale: 0.94, transition: tween.small }}
      whileHover={reduced ? undefined : { y: -2, transition: tween.micro }}
      whileTap={reduced ? undefined : { scale: 0.98, transition: tween.micro }}
      transition={spring.smooth}
      onClick={onOpen}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e);
      }}
    >
      <Flip flipKey={`entity:${entity.id}`} className="pcard__art" reduced={reduced} radius={10}>
        <span className="pcard__art-bg" style={{ ["--hue" as string]: hueFor(entity.name) }} />
        {cover ? (
          <img src={cover} alt="" loading="lazy" decoding="async" draggable={false} />
        ) : (
          <span className="pcard__portrait">
            <Portrait entity={entity} size={72} />
          </span>
        )}
        <AnimatePresence>{fetching && <CoverShimmer key="fetching" overlay />}</AnimatePresence>
      </Flip>
      <span className="pcard__name">{entity.name}</span>
      <span className="pcard__sub">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={subtitle}
            className="pcard__sub-text"
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0, transition: tween.small }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: -5, transition: tween.micro }}
          >
            {subtitle}
          </motion.span>
        </AnimatePresence>
      </span>
      <span className="pcard__foot">
        <span className="pcard__dots" aria-hidden>
          <AnimatePresence initial={false}>
          {skins.map((s) => (
            <motion.span
              key={s.id}
              className={`ecard__dot ${s.id === effective ? "is-on" : ""} ${s.id === effective && pending ? "is-pending" : ""}`}
              // 18+ skins' dots come and go with the reveal
              layout="position"
              initial={{ opacity: 0, scale: 0.4 }}
              animate={{ opacity: 1, scale: 1, transition: tween.small }}
              exit={{ opacity: 0, scale: 0.4, transition: { duration: NSFW_HIDE_S } }}
              transition={spring.smooth}
            >
              <AnimatePresence initial={false}>
                {s.id === effective && (
                  <motion.span
                    className="ecard__dot-fill"
                    initial={{ scale: 0, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1, transition: { type: "spring", stiffness: 600, damping: 22, opacity: tween.micro } }}
                    exit={{ scale: 0, opacity: 0, transition: tween.micro }}
                  />
                )}
              </AnimatePresence>
            </motion.span>
          ))}
          </AnimatePresence>
        </span>
        <span className="pcard__count caps num">
          <AnimatedNumber value={skins.length} /> skin{skins.length === 1 ? "" : "s"}
        </span>
      </span>
      <span className="pcard__badges">
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
    </motion.button>
  );
}
