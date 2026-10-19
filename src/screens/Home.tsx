import { motion } from "motion/react";
import { useMemo } from "react";
import { api } from "../api";
import { Toolbar } from "../components/Toolbar";
import type { Category, Entity, Snapshot } from "../api/types";
import { riseIn, staggerContainer } from "../motion";
import { CATEGORY_LABEL, CATEGORY_ORDER, diskActive, skinMap, sortEntities } from "../lib/derive";
import { useReduced } from "../lib/useReduced";
import { useApp } from "../store/app";
import "./Home.css";

/** Sectioned home grid (C1 base). Shelves, filters and badges arrive with the Home milestone. */
export function Home({ snapshot }: { snapshot: Snapshot }) {
  const reduced = useReduced();
  // Returning to Home reverses the page transition; only launch and forward visits replay the card stagger.
  const replay = useApp((s) => s.navDir) === 1;
  const skins = useMemo(() => skinMap(snapshot), [snapshot]);
  const sections = useMemo(() => {
    return CATEGORY_ORDER.map((cat) => ({
      cat,
      items: sortEntities(snapshot.library.entities.filter((e) => e.category === cat)),
    })).filter((s) => s.items.length);
  }, [snapshot]);
  const total = sections.reduce((n, s) => n + s.items.length, 0);

  return (
    <>
    <Toolbar animateIn={replay} />
    <motion.div
      className="home"
      variants={staggerContainer(total, reduced, 0.12)}
      initial={replay ? "hidden" : false}
      animate="show"
    >
      {sections.map(({ cat, items }) => (
        <section key={cat} className="home__section" aria-label={CATEGORY_LABEL[cat]}>
          <motion.h2 className="caps home__heading" variants={riseIn(reduced)}>
            {CATEGORY_LABEL[cat]} <span className="num home__count">· {items.length}</span>
          </motion.h2>
          <div className="home__grid">
            {items.map((e) => {
              const active = diskActive(snapshot, e.id);
              return (
                <EntityTile
                  key={e.id}
                  entity={e}
                  category={cat}
                  subtitle={active ? (skins.get(active)?.name ?? "") : e.skinIds.length ? "Original" : "Original · no skins yet"}
                  reduced={reduced}
                />
              );
            })}
          </div>
        </section>
      ))}
    </motion.div>
    </>
  );
}

function EntityTile({ entity, subtitle, reduced, category }: { entity: Entity; subtitle: string; reduced: boolean; category: Category }) {
  return (
    <motion.button className={`tile tile--${category}`} variants={riseIn(reduced)} whileHover={reduced ? undefined : { y: -2 }} whileTap={{ scale: 0.98 }}>
      <span className="tile__portrait">{entity.portrait && <img src={api.assetUrl(entity.portrait)} alt="" decoding="async" />}</span>
      <span className="tile__text">
        <span className="tile__name">{entity.name}</span>
        <span className="tile__sub">{subtitle}</span>
      </span>
    </motion.button>
  );
}
